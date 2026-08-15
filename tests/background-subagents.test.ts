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
// "off" on any malformed input.
//
// Capability answers one question: is `subagent_run` callable? The live pi
// tool registry answers it directly and wins when it carries any signal. With
// no registry handle (prompt rendering outside a session, or a runtime without
// getActiveTools) capability falls back to the installed pi-subagents package.
// That fallback probes the package root's own package.json, NOT an `agents/`
// subdirectory: pi-subagents-j0k3r v1.5.2 ships index.ts, src/, skills/ and
// scripts/ and no agents/ at all, so the old agents-dir probe reported
// "absent" on every real install and left the background policy inert.
// ---------------------------------------------------------------------------

const {
	loadBackgroundSubagentsPolicy,
	parseBackgroundSubagentsPolicyFile,
	resolveBackgroundSubagentsCapability,
	readActiveToolNames,
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

/**
 * Materialize an installed subagents package under the cwd-relative candidate
 * root. `agentsDir` reproduces the hypothetical legacy layout; omitting it
 * reproduces the real published layout, which ships no agents/ directory.
 */
function installSubagentsPackage(
	cwd: string,
	packageName: string,
	options: { agentsDir?: boolean } = {},
): void {
	const root = join(cwd, ".pi", "npm", "node_modules", packageName);
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: packageName, version: "1.5.2", type: "module" }),
	);
	// The real package ships these; none of them is an agents/ directory.
	for (const shipped of ["src", "skills", "scripts"]) {
		mkdirSync(join(root, shipped), { recursive: true });
	}
	if (options.agentsDir) mkdirSync(join(root, "agents"), { recursive: true });
}

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

test("capability is absent when no subagents package exists anywhere", () => {
	const cwd = makeScratch("gp-bg-cap-absent-");
	assert.equal(resolveBackgroundSubagentsCapability(cwd), "absent");
});

// Regression: the exact shape of a real install. pi-subagents-j0k3r v1.5.2
// ships no agents/ directory, so the previous agents-dir probe reported
// "absent" while subagent_run was in fact installed and callable.
test("capability is ready when the subagents package is installed without an agents directory", () => {
	const cwd = makeScratch("gp-bg-cap-real-");
	installSubagentsPackage(cwd, "pi-subagents-j0k3r");
	assert.equal(resolveBackgroundSubagentsCapability(cwd), "ready");
});

test("capability is ready for either supported package name", () => {
	for (const packageName of ["pi-subagents-j0k3r", "pi-subagents"]) {
		const cwd = makeScratch("gp-bg-cap-name-");
		installSubagentsPackage(cwd, packageName);
		assert.equal(
			resolveBackgroundSubagentsCapability(cwd),
			"ready",
			`package name ${packageName} must be detected`,
		);
	}
});

test("capability stays ready for a layout that does ship an agents directory", () => {
	const cwd = makeScratch("gp-bg-cap-legacy-");
	installSubagentsPackage(cwd, "pi-subagents", { agentsDir: true });
	assert.equal(resolveBackgroundSubagentsCapability(cwd), "ready");
});

test("a bare directory with no package.json is not an installed package", () => {
	const cwd = makeScratch("gp-bg-cap-bare-");
	mkdirSync(join(cwd, ".pi", "npm", "node_modules", "pi-subagents-j0k3r", "agents"), {
		recursive: true,
	});
	assert.equal(resolveBackgroundSubagentsCapability(cwd), "absent");
});

// ---------------------------------------------------------------------------
// Live tool registry outranks the filesystem fallback
// ---------------------------------------------------------------------------

test("a live tool registry listing subagent_run reports ready with no package on disk", () => {
	const cwd = makeScratch("gp-bg-cap-tools-ready-");
	assert.equal(
		resolveBackgroundSubagentsCapability(cwd, ["read", "bash", "subagent_run"]),
		"ready",
	);
	assert.equal(
		resolveBackgroundSubagentsCapability(cwd, ["pi-subagents-j0k3r.subagent_run"]),
		"ready",
		"a namespaced tool name must still count",
	);
});

test("a live tool registry without subagent_run outranks an installed package", () => {
	const cwd = makeScratch("gp-bg-cap-tools-absent-");
	installSubagentsPackage(cwd, "pi-subagents-j0k3r");
	assert.equal(resolveBackgroundSubagentsCapability(cwd, ["read", "bash"]), "absent");
});

test("an empty tool list carries no signal and falls back to the package probe", () => {
	const cwd = makeScratch("gp-bg-cap-tools-empty-");
	installSubagentsPackage(cwd, "pi-subagents-j0k3r");
	assert.equal(resolveBackgroundSubagentsCapability(cwd, []), "ready");
});

test("readActiveToolNames reads the pi registry and degrades to undefined", () => {
	assert.deepEqual(
		readActiveToolNames({ getActiveTools: () => ["read", "subagent_run"] }),
		["read", "subagent_run"],
	);
	assert.deepEqual(
		readActiveToolNames({ getActiveTools: () => [{ name: "subagent_run" }, 7, ""] }),
		["subagent_run"],
		"non-string entries are normalized and blanks dropped",
	);
	assert.equal(readActiveToolNames({}), undefined, "no handle means no signal");
	assert.equal(
		readActiveToolNames({ getActiveTools: () => "nope" }),
		undefined,
		"a non-array result means no signal",
	);
	assert.equal(
		readActiveToolNames({
			getActiveTools: () => {
				throw new Error("registry unavailable");
			},
		}),
		undefined,
		"a throwing registry means no signal",
	);
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

// The project policy file pins the policy half of the status line so these
// assertions never depend on the developer's ambient global config.
test("the rendered status line flips to ready when the subagents package is installed", () => {
	const cwd = makeScratch("gp-bg-cap-render-");
	writePolicyFile(join(cwd, ".pi", "gentle-ai"), "on");
	assert.match(
		getOrchestratorPrompt(cwd),
		/Background subagent policy: on \(capability: absent\)/,
		"no package installed yet",
	);
	installSubagentsPackage(cwd, "pi-subagents-j0k3r");
	assert.match(
		getOrchestratorPrompt(cwd),
		/Background subagent policy: on \(capability: ready\)/,
	);
});

test("the rendered status line reports ready from a live registry alone", () => {
	const cwd = makeScratch("gp-bg-cap-render-tools-");
	writePolicyFile(join(cwd, ".pi", "gentle-ai"), "on");
	assert.match(
		getOrchestratorPrompt(cwd, ["read", "subagent_run"]),
		/Background subagent policy: on \(capability: ready\)/,
	);
});

test("getOrchestratorPrompt renders exactly one background status line", () => {
	const rendered = getOrchestratorPrompt();
	const matches = rendered.match(/Background subagent policy: (?:on|off) \(capability: (?:ready|absent)\)/g) ?? [];
	assert.equal(matches.length, 1, "the always-on core must carry exactly one status line");
});
