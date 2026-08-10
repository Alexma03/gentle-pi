import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// ---------------------------------------------------------------------------
// Provider Defect Handoff — structural readback tests (issue #256, track 5)
//
// Pins the port of Gentle AI's v2.4.0-rc.3 provider-defect handoff consent
// contract (Gentleman-Programming/gentle-ai#2060) into Pi's lazy-loaded
// orchestrator assets. The contract is a prerelease (not in v2.3.0 stable).
// These tests assert structural presence and ordering of the contract's key
// elements; they do not execute any lifecycle command.
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "..");
const DELEGATION_PATH = join(REPO_ROOT, "assets", "orchestrator-delegation.md");
const SDD_WORKFLOW_PATH = join(REPO_ROOT, "assets", "sdd-orchestrator-workflow.md");

const DELEGATION = readFileSync(DELEGATION_PATH, "utf8");
const SDD_WORKFLOW = readFileSync(SDD_WORKFLOW_PATH, "utf8");

const CHOICE_TOKENS = ["report_and_continue", "continue_without_reporting", "stop_here"] as const;

// ---------------------------------------------------------------------------
// 1 — assets/orchestrator-delegation.md structural presence
// ---------------------------------------------------------------------------

test("orchestrator-delegation.md carries the provider defect handoff section", () => {
	assert.match(DELEGATION, /## Provider Defect Handoff/);
});

test("orchestrator-delegation.md references the v2.4.0-rc.3 prerelease contract", () => {
	assert.match(DELEGATION, /v2\.4\.0-rc\.3/);
	assert.match(DELEGATION, /prerelease/i);
});

test("orchestrator-delegation.md lists all three semantic choice tokens", () => {
	for (const token of CHOICE_TOKENS) {
		assert.ok(
			DELEGATION.includes(token),
			`orchestrator-delegation.md missing semantic choice token: ${token}`,
		);
	}
});

test("orchestrator-delegation.md orders the three choices: report_and_continue, continue_without_reporting, stop_here", () => {
	const positions = CHOICE_TOKENS.map((token) => DELEGATION.indexOf(token));
	for (const pos of positions) {
		assert.notEqual(pos, -1, "a choice token is missing; ordering assertion is meaningless");
	}
	assert.ok(
		positions[0] < positions[1],
		`report_and_continue must appear before continue_without_reporting; got positions ${positions}`,
	);
	assert.ok(
		positions[1] < positions[2],
		`continue_without_reporting must appear before stop_here; got positions ${positions}`,
	);
});

test("orchestrator-delegation.md states the never-offer-to-repair rule", () => {
	assert.match(
		DELEGATION,
		/Never offer to switch to, inspect, modify, or directly repair the Gentle AI repository/i,
	);
});

test("orchestrator-delegation.md states the consent requirement", () => {
	assert.match(DELEGATION, /Ask the user first[\s\S]*explicit consent to report/i);
	assert.match(DELEGATION, /single-select/i);
});

test("orchestrator-delegation.md states the privacy scrub requirement", () => {
	assert.match(DELEGATION, /privacy-scrubbed/i);
	assert.match(DELEGATION, /final privacy scan/i);
	assert.match(DELEGATION, /raw argv, absolute paths, private project names, usernames, hostnames, credentials, diffs, source contents, and environment values/i);
});

test("orchestrator-delegation.md states the duplicate search in Gentleman-Programming/gentle-ai", () => {
	assert.match(DELEGATION, /Gentleman-Programming\/gentle-ai/);
	assert.match(DELEGATION, /Search open and closed issues/i);
	assert.match(DELEGATION, /completed duplicate lookup with a definitive result/i);
});

test("orchestrator-delegation.md states the gentle-report label rule (only after confirmed creation)", () => {
	assert.match(DELEGATION, /gentle-report/);
	assert.match(DELEGATION, /only after a GitHub create operation confirms a newly-created issue identity/i);
	assert.match(DELEGATION, /Never infer creation from output text alone/i);
});

test("orchestrator-delegation.md states the exact-captured-decline-invocation rule", () => {
	assert.match(DELEGATION, /exact captured decline invocation/i);
	assert.match(
		DELEGATION,
		/Never synthesize the decline command, target, token, or consumer continuation from prose/i,
	);
});

test("orchestrator-delegation.md states the fail-closed rule", () => {
	assert.match(DELEGATION, /fail closed/i);
	assert.match(DELEGATION, /Any report ambiguity or failure is a hard stop/i);
});

test("orchestrator-delegation.md states the resume-only-after-released-fix rule", () => {
	assert.match(DELEGATION, /Resume the consumer workflow only after an installed published fix/i);
	assert.match(DELEGATION, /Never resume against unpublished code/i);
	assert.match(DELEGATION, /release candidate/i);
});

// ---------------------------------------------------------------------------
// 2 — assets/sdd-orchestrator-workflow.md structural presence
// ---------------------------------------------------------------------------

test("sdd-orchestrator-workflow.md carries the provider defect handoff section", () => {
	assert.match(SDD_WORKFLOW, /## Provider Defect Handoff/);
});

test("sdd-orchestrator-workflow.md lists all three semantic choice tokens", () => {
	for (const token of CHOICE_TOKENS) {
		assert.ok(
			SDD_WORKFLOW.includes(token),
			`sdd-orchestrator-workflow.md missing semantic choice token: ${token}`,
		);
	}
});

test("sdd-orchestrator-workflow.md references the full contract in orchestrator-delegation.md", () => {
	assert.match(
		SDD_WORKFLOW,
		/The full contract lives in `assets\/orchestrator-delegation\.md` under `## Provider Defect Handoff`/i,
	);
});

test("sdd-orchestrator-workflow.md states the key rules concisely", () => {
	// never-repair
	assert.match(
		SDD_WORKFLOW,
		/Never offer to switch to, inspect, modify, or directly repair the Gentle AI repository/i,
	);
	// consent
	assert.match(SDD_WORKFLOW, /Ask for explicit consent/i);
	// privacy
	assert.match(SDD_WORKFLOW, /Privacy scrub immediately before the first GitHub operation/i);
	// duplicate
	assert.match(SDD_WORKFLOW, /Duplicate search in `Gentleman-Programming\/gentle-ai`/i);
	// label after confirmed creation
	assert.match(SDD_WORKFLOW, /gentle-report/);
	assert.match(SDD_WORKFLOW, /only after a GitHub create operation confirms a newly-created issue identity/i);
	// exact decline
	assert.match(SDD_WORKFLOW, /exact captured decline invocation/i);
	// fail-closed
	assert.match(SDD_WORKFLOW, /fail closed/i);
	// resume after fix
	assert.match(SDD_WORKFLOW, /Resume only after an installed published fix/i);
});
