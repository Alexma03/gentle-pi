import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENTS = join(ROOT, "assets", "agents");
const ASSETS = join(ROOT, "assets");

// SDD phase executors installed to ~/.pi/agent/agents/ by installSddAssets.
// Each carries its own effective prompt; none inherits the parent workflow.
const SDD_PREFIX = "sdd-";

// Strict-output agents that must remain untouched by Key Learnings.
const STRICT_JSON_AGENTS = [
	"jd-fix-agent.md", "jd-judge-a.md", "jd-judge-b.md",
	"review-readability.md", "review-refuter.md", "review-reliability.md",
	"review-resilience.md", "review-risk.md", "review-validator.md",
];

// Canonical semantics every Key Learnings section must encode.
const KL_SEMANTICS: Array<[string, RegExp]> = [
	["heading `## Key Learnings`", /`## Key Learnings`/],
	["1–5 numbered items", /1[–-]5 numbered/],
	["standalone factual sentence", /standalone factual sentence/],
	["at least 20 characters", /at least 20 characters/],
	["at least 4 words", /at least 4 words/],
	["final report text only", /final (?:report|response) text only/],
	["Engram extracts and persists", /Engram[^\n]*automatically extracts[^\n]*persists/i],
	["executor does not parse", /do(?:es)? not parse/],
	["passive-capture tool wording", /passive.capture/i],
	["omit when no reusable learning", /[Oo]mit[^\n]*no reusable learning/],
	["separate from mem_save", /separate from[^\n]*mem_save/],
];

function readSection(source: string, heading: string): string | null {
	const lines = source.split(/\r?\n/);
	const start = lines.findIndex((l) => /^#{1,6}\s+/.test(l) && l.replace(/^#{1,6}\s+/, "").trim() === heading);
	if (start === -1) return null;
	const level = lines[start].match(/^(#{1,6})/)![1].length;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const m = lines[i].match(/^(#{1,6})\s+/);
		if (m && m[1].length <= level) { end = i; break; }
	}
	return lines.slice(start, end).join("\n").trim();
}

function agentFiles(): string[] {
	return readdirSync(AGENTS).filter((f) => f.endsWith(".md")).sort();
}

function sddAgents(): string[] {
	return agentFiles().filter((f) => f.startsWith(SDD_PREFIX));
}

test("every SDD phase executor carries an effective `## Key Learnings Closing` section with full semantics", () => {
	const agents = sddAgents();
	assert.ok(agents.length >= 12, `expected >=12 SDD agents, found ${agents.length}`);
	const missing: string[] = [];
	const failed: string[] = [];
	for (const file of agents) {
		const source = readFileSync(join(AGENTS, file), "utf8");
		const section = readSection(source, "Key Learnings Closing");
		if (section === null) { missing.push(file); continue; }
		for (const [label, regex] of KL_SEMANTICS) {
			if (!regex.test(section)) failed.push(`${file}: ${label}`);
		}
	}
	assert.deepEqual(missing, [], "every SDD agent must carry a `## Key Learnings Closing` section");
	assert.deepEqual(failed, [], "every section must encode all canonical semantics");
});

test("no SDD phase executor infers Key Learnings through `standard phase envelope` alone", () => {
	for (const file of sddAgents()) {
		const source = readFileSync(join(AGENTS, file), "utf8");
		const section = readSection(source, "Key Learnings Closing");
		assert.ok(section, `${file} must have a direct Key Learnings Closing section`);
	}
});

test("SDD executor coverage is exhaustive against actual agent files", () => {
	const actual = sddAgents();
	// Allowlist: the 12 known phase executors. A new sdd-*.md without a
	// Key Learnings Closing section fails the first test; this test proves
	// the allowlist matches reality so coverage cannot silently drift.
	const expected = [
		"sdd-apply.md", "sdd-archive.md", "sdd-design.md", "sdd-explore.md",
		"sdd-init.md", "sdd-onboard.md", "sdd-proposal.md", "sdd-spec.md",
		"sdd-status.md", "sdd-sync.md", "sdd-tasks.md", "sdd-verify.md",
	];
	assert.deepEqual(actual, expected, "SDD agent set must match the known allowlist");
});

test("generic delegation contract instructs the same `## Key Learnings` closing block", () => {
	const delegation = readFileSync(join(ASSETS, "orchestrator-delegation.md"), "utf8");
	const section = readSection(delegation, "Key Learnings closing block");
	assert.ok(section, "orchestrator-delegation.md must have a Key Learnings closing block section");
	for (const [label, regex] of KL_SEMANTICS) {
		assert.match(section, regex, `delegation missing semantic: ${label}`);
	}
	assert.match(section, /native `Agent`/, "must cover native Agent fallback");
	assert.match(section, /strict JSON/i, "must exclude strict-JSON agents");
	assert.match(section, /layers on after/, "must state the block layers on after the envelope");
});

test("sdd-orchestrator-workflow documents routing, not executor authority", () => {
	const workflow = readFileSync(join(ASSETS, "sdd-orchestrator-workflow.md"), "utf8");
	const section = readSection(workflow, "Key Learnings closing block (routing)");
	assert.ok(section, "workflow must document Key Learnings routing");
	assert.match(section, /installed SDD phase executor agent.*carries the effective.*contract/i);
	assert.match(section, /documents routing only and is not the executor authority/);
});

test("provider ownership: no Pi TypeScript runtime parses Key Learnings or invokes passive-capture tools", () => {
	const roots = ["lib", "extensions", "scripts", "runtime"];
	const forbidden: Array<[string, RegExp]> = [
		["Key Learnings parser", /Key Learnings/i],
		["key_learnings token", /key_learnings/i],
		["passive-capture tool invocation", /mem_capture_passive|capture_passive|passive_capture/i],
	];
	const failures: string[] = [];
	for (const root of roots) {
		const absRoot = join(ROOT, root);
		if (!existsSync(absRoot)) continue;
		for (const entry of readdirSync(absRoot, { withFileTypes: true })) {
			if (!entry.isFile() || !/\.(ts|mjs)$/.test(entry.name)) continue;
			const text = readFileSync(join(absRoot, entry.name), "utf8");
			for (const [label, regex] of forbidden) {
				if (regex.test(text)) failures.push(`${root}/${entry.name}: ${label}`);
			}
		}
	}
	assert.deepEqual(failures, [], "Pi must not parse Key Learnings or invoke passive-capture tools");
});

test("strict review and Judgment Day agents do not gain Key Learnings or trailing-prose instruction", () => {
	const failures: string[] = [];
	for (const file of STRICT_JSON_AGENTS) {
		const source = readFileSync(join(AGENTS, file), "utf8");
		for (const regex of [/Key Learnings/i, /key_learnings/i, /trailing prose/i]) {
			if (regex.test(source)) failures.push(`${file}: ${regex.source}`);
		}
	}
	assert.deepEqual(failures, [], "strict-JSON/ledger agents must remain untouched");
});

test("the canonical Key Learnings heading has no trailing colon in any asset", () => {
	for (const file of sddAgents()) {
		const source = readFileSync(join(AGENTS, file), "utf8");
		assert.match(source, /`## Key Learnings`/, `${file} must reference the canonical heading`);
		assert.doesNotMatch(source, /`## Key Learnings:`/, `${file} must not use a trailing colon`);
	}
	const delegation = readFileSync(join(ASSETS, "orchestrator-delegation.md"), "utf8");
	assert.doesNotMatch(delegation, /`## Key Learnings:`/);
});

test("modified SDD agents are packaged and installed by the existing installer", () => {
	const verifier = readFileSync(join(ROOT, "scripts", "verify-package-files.mjs"), "utf8");
	const expected = [
		"assets/agents/sdd-apply.md", "assets/agents/sdd-archive.md",
		"assets/agents/sdd-design.md", "assets/agents/sdd-explore.md",
		"assets/agents/sdd-init.md", "assets/agents/sdd-onboard.md",
		"assets/agents/sdd-proposal.md", "assets/agents/sdd-spec.md",
		"assets/agents/sdd-status.md", "assets/agents/sdd-sync.md",
		"assets/agents/sdd-tasks.md", "assets/agents/sdd-verify.md",
	];
	for (const path of expected) {
		assert.match(verifier, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${path} must be in the package verifier`);
	}
});
