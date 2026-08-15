import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// ---------------------------------------------------------------------------
// Background subagents policy (issue #256).
//
// The policy loader mirrors loadRuntimeGuardrailsConfig: project file >
// global file > env var > default off, strict schema decode, fail-closed to
// "off" on any malformed input. Capability is derived from the pi-subagents
// package presence (builtinAgentDirs probe) because no synchronous runtime
// tool registry exists at prompt-render time.
// ---------------------------------------------------------------------------

const {
	loadBackgroundSubagentsPolicy,
	parseBackgroundSubagentsPolicyFile,
	resolveBackgroundSubagentsCapability,
	renderBackgroundSubagentsStatusLine,
	renderOrchestratorPrompt,
	getOrchestratorPrompt,
} = __testing;

const scratchRoots: string[] = [];

function makeScratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratchRoots.push(dir);
	return dir;
}

after(() => {
	for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

function writePolicyFile(dir: string, policy: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "background-subagents.json"),
		JSON.stringify({ schema: "gentle-pi.background-subagents/v1", policy }),
	);
}

const EMPTY_ENV = {} as Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Strict decode
// ---------------------------------------------------------------------------

test("strict decode accepts exactly the v1 schema with policy on|off", () => {
	assert.equal(
		parseBackgroundSubagentsPolicyFile(
			'{"schema":"gentle-pi.background-subagents/v1","policy":"on"}',
		),
		"on",
	);
	assert.equal(
		parseBackgroundSubagentsPolicyFile(
			'{"schema":"gentle-pi.background-subagents/v1","policy":"off"}',
		),
		"off",
	);
});

test("strict decode rejects malformed shapes", () => {
	for (const raw of [
		"not json",
		"[]",
		"null",
		'{"policy":"on"}',
		'{"schema":"gentle-pi.background-subagents/v2","policy":"on"}',
		'{"schema":"gentle-pi.background-subagents/v1","policy":"ON"}',
		'{"schema":"gentle-pi.background-subagents/v1","policy":true}',
		'{"schema":"gentle-pi.background-subagents/v1","policy":"on","extra":1}',
	]) {
		assert.equal(
			parseBackgroundSubagentsPolicyFile(raw),
			undefined,
			`must reject: ${raw}`,
		);
	}
});

// ---------------------------------------------------------------------------
// Cascade: project > global > env > default off
// ---------------------------------------------------------------------------

test("default is off with no file and no env", () => {
	const cwd = makeScratch("gp-bg-none-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	assert.equal(
		loadBackgroundSubagentsPolicy(cwd, { gentlePiConfigHome: configHome, env: EMPTY_ENV }),
		"off",
	);
});

test("project file overrides global file and env", () => {
	const cwd = makeScratch("gp-bg-proj-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	writePolicyFile(join(cwd, ".pi", "gentle-ai"), "on");
	writePolicyFile(configHome, "off");
	assert.equal(
		loadBackgroundSubagentsPolicy(cwd, {
			gentlePiConfigHome: configHome,
			env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "off" },
		}),
		"on",
	);
});

test("global file overrides env when no project file exists", () => {
	const cwd = makeScratch("gp-bg-glob-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	writePolicyFile(configHome, "on");
	assert.equal(
		loadBackgroundSubagentsPolicy(cwd, {
			gentlePiConfigHome: configHome,
			env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "off" },
		}),
		"on",
	);
});

test("env var applies only when no policy file exists, and only exact on|off", () => {
	const cwd = makeScratch("gp-bg-env-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	assert.equal(
		loadBackgroundSubagentsPolicy(cwd, {
			gentlePiConfigHome: configHome,
			env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "on" },
		}),
		"on",
	);
	for (const invalid of ["1", "true", "ON", "yes", ""]) {
		assert.equal(
			loadBackgroundSubagentsPolicy(cwd, {
				gentlePiConfigHome: configHome,
				env: { GENTLE_PI_BACKGROUND_SUBAGENTS: invalid },
			}),
			"off",
			`env value "${invalid}" must fail closed to off`,
		);
	}
});

test("a malformed higher-priority file fails closed to off instead of falling through", () => {
	const cwd = makeScratch("gp-bg-mal-");
	const configHome = join(makeScratch("gp-bg-home-"), "gentle-ai");
	const projectDir = join(cwd, ".pi", "gentle-ai");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(join(projectDir, "background-subagents.json"), "{malformed");
	writePolicyFile(configHome, "on");
	assert.equal(
		loadBackgroundSubagentsPolicy(cwd, {
			gentlePiConfigHome: configHome,
			env: { GENTLE_PI_BACKGROUND_SUBAGENTS: "on" },
		}),
		"off",
	);
});

// ---------------------------------------------------------------------------
// Capability degrade
// ---------------------------------------------------------------------------

test("capability is absent when no pi-subagents package directory exists", () => {
	const cwd = makeScratch("gp-bg-cap-absent-");
	assert.equal(resolveBackgroundSubagentsCapability(cwd), "absent");
});

test("capability is ready when a pi-subagents agents directory is discoverable", () => {
	const cwd = makeScratch("gp-bg-cap-ready-");
	mkdirSync(join(cwd, ".pi", "npm", "node_modules", "pi-subagents", "agents"), {
		recursive: true,
	});
	assert.equal(resolveBackgroundSubagentsCapability(cwd), "ready");
});

// ---------------------------------------------------------------------------
// Token rendering
// ---------------------------------------------------------------------------

test("status line renders policy and capability", () => {
	assert.equal(
		renderBackgroundSubagentsStatusLine({ policy: "on", capability: "ready" }),
		"Background subagent policy: on (capability: ready)",
	);
	assert.equal(
		renderBackgroundSubagentsStatusLine({ policy: "off", capability: "absent" }),
		"Background subagent policy: off (capability: absent)",
	);
});

test("renderOrchestratorPrompt substitutes the background policy token", () => {
	const assetsDir = join(process.cwd(), "assets");
	const rendered = renderOrchestratorPrompt(assetsDir, {
		policy: "on",
		capability: "ready",
	});
	assert.match(rendered, /Background subagent policy: on \(capability: ready\)/);
	assert.doesNotMatch(rendered, /\{\{GENTLE_PI_BACKGROUND_POLICY\}\}/);
});

test("renderOrchestratorPrompt defaults to the fail-closed off/absent rendering", () => {
	const assetsDir = join(process.cwd(), "assets");
	const rendered = renderOrchestratorPrompt(assetsDir);
	assert.match(rendered, /Background subagent policy: off \(capability: absent\)/);
});

test("getOrchestratorPrompt renders exactly one background status line", () => {
	const rendered = getOrchestratorPrompt();
	const matches = rendered.match(/Background subagent policy: (?:on|off) \(capability: (?:ready|absent)\)/g) ?? [];
	assert.equal(matches.length, 1, "the always-on core must carry exactly one status line");
});
