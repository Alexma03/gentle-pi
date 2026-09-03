import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// ---------------------------------------------------------------------------
// Native SDD Runtime Attempt Authority contract tests (issue #256 track 3).
//
// Locks the Pi-owned lazy-loaded orchestration/status contract that ports the
// released Gentle AI v2.4.0 compact SDD attempt ledger authority. Pi must NOT
// implement a local attempt runtime; it must route every runtime-bearing
// sdd-apply/sdd-verify/remediation launch through the provider compact CLI.
//
// Both assets are Markdown contracts consumed by orchestrators; these tests
// read the real repo files and assert the essential semantics, not merely
// keyword presence. Negative controls guard against caller-authored
// counters, OpenSpec/Engram attempt ledgers, bookkeeping reset consent, and legacy
// status|begin|finish|reset normal-flow routing.
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dirname, "..");
const WORKFLOW = "assets/sdd-orchestrator-workflow.md";
const STATUS_CONTRACT = "assets/support/sdd-status-contract.md";
const SECTION = "Native Runtime Attempt Authority";

function read(path: string): string {
	return readFileSync(join(ROOT, path), "utf8");
}

function readMarkdownSection(source: string, heading: string): string {
	const lines = source.split(/\r?\n/);
	const matches = lines.flatMap((line, index) => {
		const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
		return match?.[2] === heading ? [{ index, level: match[1].length }] : [];
	});
	assert.equal(
		matches.length,
		1,
		`Markdown must contain exactly one "${heading}" section (found ${matches.length})`,
	);
	const [{ index: start, level }] = matches;
	const relativeEnd = lines.slice(start + 1).findIndex((line) => {
		const match = line.match(/^(#{1,6})\s+/);
		return match !== null && match[1].length <= level;
	});
	const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
	return lines.slice(start + 1, end).join("\n").trim();
}

// Extracts one command line beginning with `commandPrefix` so payload args bind
// to the correct command shape; `--cwd`, `--change`, `--request-id` appear in
// both acquire and settle, so a section-wide match stays green on arg removal.
function extractCommandLine(section: string, commandPrefix: string): string {
	const escaped = commandPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^[ \t]*${escaped}.*$`, "gm");
	const matches = section.match(re) ?? [];
	assert.equal(
		matches.length,
		1,
		`Native Runtime Attempt Authority section must contain exactly one command line starting with "${commandPrefix}" (found ${matches.length})`,
	);
	const [line] = matches;
	return line;
}

test("extractCommandLine rejects duplicate matching command lines (negative control)", () => {
	for (const prefix of [
		"gentle-ai sdd-attempt acquire ",
		"gentle-ai sdd-attempt settle ",
	]) {
		const duplicate = [
			`${prefix}--cwd repo --change change --request-id id`,
			`${prefix}--cwd repo2 --change change2 --request-id id2`,
		].join("\n");
		assert.throws(
			() => extractCommandLine(duplicate, prefix),
			/exactly one command line/,
			`duplicate ${prefix.trim()} lines must be rejected`,
		);
	}
});

test("workflow asset has exactly one Native Runtime Attempt Authority section", () => {
	const section = readMarkdownSection(read(WORKFLOW), SECTION);
	assert.ok(section.length > 0, "section must be non-empty");
});

test("status contract asset has exactly one Native Runtime Attempt Authority section", () => {
	const section = readMarkdownSection(read(STATUS_CONTRACT), SECTION);
	assert.ok(section.length > 0, "section must be non-empty");
});

test("workflow names acquire and settle as sole provider authority for OpenSpec and Engram", () => {
	const section = readMarkdownSection(read(WORKFLOW), SECTION);
	assert.match(section, /sdd-attempt acquire/);
	assert.match(section, /sdd-attempt settle/);
	assert.match(section, /sole attempt and evidence authority/i);
	assert.match(section, /Git-common-dir/);
	assert.match(section, /OpenSpec and Engram/);
});

test("status contract names acquire and settle and forbids OpenSpec/Engram attempt ledgers", () => {
	const section = readMarkdownSection(read(STATUS_CONTRACT), SECTION);
	assert.match(section, /acquire/);
	assert.match(section, /settle/);
	assert.match(section, /OpenSpec or Engram attempt ledger/i);
});

test("workflow launches only on proceed and reserves blocked for genuine provider safety failures", () => {
	const section = readMarkdownSection(read(WORKFLOW), SECTION);
	assert.match(section, /proceed/);
	assert.match(section, /blocked/);
	assert.match(section, /complete/);
	assert.match(section, /launch only on `proceed`/i);
	assert.match(section, /blocked.*do not launch/i);
	assert.match(section, /complete.*do not launch/i);
	assert.match(section, /integrity, ownership, binding, or continuation problem/i);
	assert.match(section, /no safe automatic recovery/i);
});

test("workflow requires distinct request IDs with own-ID-only idempotent replay", () => {
	const section = readMarkdownSection(read(WORKFLOW), SECTION);
	assert.match(section, /distinct from acquire/i);
	assert.match(section, /own ID only for idempotent replay/i);
});

test("workflow acquire command line binds mandatory payload without a caller-selected attempt budget", () => {
	const section = readMarkdownSection(read(WORKFLOW), SECTION);
	const acquire = extractCommandLine(section, "gentle-ai sdd-attempt acquire ");
	for (const arg of [
		"--cwd <repo>",
		"--change <change>",
		"--request-id <id>",
		"--work-unit <label>",
		"--evidence-goal <goal>",
	]) {
		assert.ok(acquire.includes(arg), `acquire command is missing ${arg}; command: ${acquire}`);
	}
	assert.doesNotMatch(acquire, /max-attempts/);
	assert.doesNotMatch(acquire, /max-changed-lines/);
});

test("workflow settle command line binds mandatory arguments and routing invariants", () => {
	const section = readMarkdownSection(read(WORKFLOW), SECTION);
	const settle = extractCommandLine(section, "gentle-ai sdd-attempt settle ");
	for (const arg of [
		"--cwd <repo>",
		"--change <change>",
		"--token <token>",
		"--request-id <id>",
		"--outcome <failed|interrupted|passed>",
		"--evidence-revision <sha256:...>",
		"--diagnosis <text>",
		"--harness-disposition <reused|invalidated>",
		"--cleanup-evidence <text>",
		"--process-evidence <text>",
	]) {
		assert.ok(settle.includes(arg), `settle command is missing ${arg}; command: ${settle}`);
	}
	assert.match(section, /never `none`/);
	assert.match(section, /proceed\|blocked\|complete/);
	assert.match(section, /--successor-lineage/);
	assert.match(section, /--remediates-evidence-revision/);
});

test("workflow forbids caller-authored counters and Pi-owned attempt state", () => {
	const section = readMarkdownSection(read(WORKFLOW), SECTION);
	assert.match(section, /never persist caller-authored/i);
	assert.match(section, /OpenSpec artifacts, Engram memory/);
	assert.match(section, /counter|token store|state machine|interception/i);
});

test("workflow makes routine failure recovery automatic while retaining compatibility surfaces", () => {
	const section = readMarkdownSection(read(WORKFLOW), SECTION);
	assert.match(section, /`status`, `begin`, `finish`, and `reset`/);
	assert.match(section, /diagnostic\/compatibility surfaces/);
	assert.match(section, /not the normal runtime route/i);
	assert.match(section, /advisory\/no-progress telemetry/i);
	assert.match(section, /failed or interrupted/i);
	assert.match(section, /diagnose.*change strategy.*acquire/i);
	assert.match(section, /never require human permission or a reset/i);
	assert.match(section, /reset is not part of the normal failure path/i);
	assert.match(section, /invalidated harness.*proof is incomplete/i);
	assert.match(section, /execution may have started/i);
});

test("workflow gatekeeper rerun is subordinate to a fresh native acquire", () => {
	const section = readMarkdownSection(read(WORKFLOW), SECTION);
	assert.match(section, /rerun never bypasses native attempt authority/i);
	assert.match(section, /fresh compact acquire/i);
	// The gatekeeper quality rule is preserved (not deleted).
	const gatekeeper = readMarkdownSection(read(WORKFLOW), "Automatic Mode Gatekeeper");
	assert.match(gatekeeper, /rerun the same SDD phase once with corrective feedback/);
	assert.match(gatekeeper, /Validate the rerun/);
});

test("workflow does not present status|begin|finish|reset as the primary route", () => {
	const section = readMarkdownSection(read(WORKFLOW), SECTION);
	assert.match(section, /not the normal runtime route/i);
	assert.doesNotMatch(
		section,
		/primary route.*sdd-attempt (?:status|begin|finish|reset)/i,
	);
});

test("status contract authority is artifact-store agnostic and excluded from SDD v1 status", () => {
	const section = readMarkdownSection(read(STATUS_CONTRACT), SECTION);
	assert.match(section, /artifact-store agnostic/i);
	assert.match(section, /MUST NOT be embedded in the SDD v1 status/i);
	assert.match(section, /separate from artifact dispatch/i);
});

test("status contract continuation rule keeps routine ceilings advisory and retries diagnosed failures", () => {
	const section = readMarkdownSection(read(STATUS_CONTRACT), SECTION);
	assert.match(section, /before every runtime-bearing/i);
	assert.match(section, /after the external run completes it MUST settle/i);
	assert.match(section, /distinct/i);
	assert.match(section, /proceed\|blocked\|complete/);
	assert.match(section, /launch only on `proceed`/i);
	assert.match(section, /advisory\/no-progress telemetry/i);
	assert.match(section, /failed or interrupted/i);
	assert.match(section, /diagnose.*change strategy.*acquire/i);
	assert.match(section, /must not demand human permission to reset bookkeeping/i);
	assert.match(section, /invalidated harness.*proof is incomplete/i);
});

test("status contract schema is unchanged (no attempt authority payload added)", () => {
	const schema = readMarkdownSection(read(STATUS_CONTRACT), "Status Schema");
	assert.doesNotMatch(
		schema,
		/attemptToken|attempt_token|attemptCount|attempt_counter|sddAttempt|sdd_attempt|nativeAttempt/i,
		"Status Schema must not embed the runtime attempt authority payload",
	);
});

test("status contract uses a runtime-safe semantic reference, not a repo-source assets/ path", () => {
	const section = readMarkdownSection(read(STATUS_CONTRACT), SECTION);
	assert.doesNotMatch(
		section,
		/See `assets\/sdd-orchestrator-workflow\.md`|see `assets\//i,
		"status contract must not point installed consumers at a repo-source assets/ path; those are package source paths before installation",
	);
	assert.match(section, /lazy-loaded `SDD Orchestrator Workflow`/i);
	assert.match(section, /Native Runtime Attempt Authority/);
	assert.match(section, /Do not look up `assets\/\.\.\.` paths at runtime/i);
});
