import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import type { ReviewStatusV3 } from "../lib/review-integration-v2.ts";

// Field defect (Engram #12547, lineage review-43762fca1bba0bf3): a MEDIUM
// lineage detected a reliability defect, corrected it inside budget, captured
// evidence and the native targeted validator. Negotiated STATUS then returned
// `captured_provider_targeted_validation_ready` with an execute
// `review.finalize` transition, and running that exact transition failed twice
// with `candidate-target-projection-drift`, mutation none, so no receipt was
// ever minted.
//
// Measured on a faithful live reproduction (medium candidate, real binary,
// START through the controller so the registry holds the START-time view):
//
//   START candidate tree:     4c24487f850050af0a0944d37d4dbb15287ab3da
//   corrected candidate tree: 777f48fdc4e6ed9abd325d6b4c49e6d06036c906
//   FINALIZE (no documents) -> candidate-target-projection-drift, mutation none
//   registry branch taken:    ["resolveForFinalize"]
//
// Root cause: the corrected tree is tolerated only while
// `correctionCompletion` (validation AND final_evidence) or `validationAttempt`
// (final_evidence without a forecast) hold. A FINALIZE that merely follows the
// provider's own execute transition carries no documents, so both are false,
// the START-time view is resolved, and it is compared against the corrected
// candidate the provider itself authorized.

const SHA = `sha256:${"1".repeat(64)}`;
const DEFECT = "export function lastComponent(input) {\n  const parts = input.split(\"/\");\n  return parts[parts.length - 2];\n}\n";
const CORRECTED = "export function lastComponent(input) {\n  const parts = input.split(\"/\");\n  return parts[parts.length - 1];\n}\n";

function git(cwd: string, ...arguments_: string[]): string {
	return execFileSync("git", arguments_, { cwd, encoding: "utf8" }).trim();
}

function repository(t: test.TestContext): string {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-corrected-finalize-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	git(cwd, "init", "-b", "main");
	git(cwd, "config", "user.name", "Corrected Test");
	git(cwd, "config", "user.email", "corrected@example.invalid");
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src", "parse.js"), "export function parsePath(input) {\n  return input.split(\"/\");\n}\n");
	git(cwd, "add", "-A");
	git(cwd, "commit", "-m", "base");
	writeFileSync(join(cwd, "src", "parse.js"), DEFECT);
	return cwd;
}

/** The live frozen identity of the current workspace candidate. */
function liveIdentity(cwd: string): { baseTree: string; candidateTree: string; paths: readonly string[] } {
	const probe = new CandidateViewRegistry();
	const view = probe.create({ contributorRoot: cwd });
	try {
		return { baseTree: view.baseTree, candidateTree: view.candidateTree, paths: view.paths };
	} finally {
		probe.cleanup(view.token);
	}
}

function correctedStatus(lineageId: string, identity: { baseTree: string; candidateTree: string; paths: readonly string[] }): ReviewStatusV3 {
	return {
		contract: "gentle-ai.review-integration/v2",
		applicability: "current_target",
		authority: { version: "compact-v2", lineageId, state: "correction_required", generation: 1, revision: SHA },
		receipt: { status: "expected_missing" },
		action: "finalize",
		replayability: "not_replayable",
		frozen: { tier: "medium", originalChangedLines: 4, correctionBudget: 2 },
		targetIdentity: SHA,
		projection: {
			schema: "gentle-ai.review-integration.projection/v1",
			kind: "current-changes",
			projection: "workspace",
			baseTree: identity.baseTree,
			initialReviewTree: identity.candidateTree,
			currentCandidateTree: identity.candidateTree,
			pathsDigest: SHA,
			paths: [...identity.paths],
			intendedUntracked: [],
			intendedUntrackedProof: SHA,
			initialSnapshotIdentity: SHA,
			currentSnapshotIdentity: SHA,
		},
		candidates: [],
		// The provider's own answer after it admitted the captured validator.
		nextTransition: {
			kind: "execute",
			reasonCode: "captured_provider_targeted_validation_ready",
			execute: {
				operation: "review.finalize",
				arguments: [
					{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
					{ name: "captured-evidence", value: "true", token: "--captured-evidence=true" },
				],
				binding: { lineageId },
			},
		},
		raw: { schema: "gentle-ai.review-integration.status/v5", action: "finalize", lineage_id: lineageId },
	} as unknown as ReviewStatusV3;
}

function approvingNative(status: ReviewStatusV3): { native: NativeReviewCli; transitions: number } {
	const state = { transitions: 0 };
	const native = {
		targetStatus: async () => status,
		finalizeTransition: async () => {
			state.transitions += 1;
			return { lineageId: status.authority!.lineageId, state: "approved", action: "approved", storeRevision: "r2" };
		},
		finalize: async () => { throw new Error("the provider transition must be executed, not raw finalize"); },
	} as unknown as NativeReviewCli;
	return { native, get transitions() { return state.transitions; } } as never;
}

/** Binds the START-time immutable reviewer view, as a live session does. */
function sessionWithStartBinding(cwd: string, lineageId: string): { registry: CandidateViewRegistry; startTree: string } {
	const registry = new CandidateViewRegistry();
	const view = registry.createOrReuse({ contributorRoot: cwd });
	registry.bindCurrent({ token: view.token, lineageId, selectedLenses: ["review-reliability"] });
	return { registry, startTree: view.candidateTree };
}

test("FINALIZE follows the provider transition after a correction instead of drifting on the START view", async (t) => {
	const cwd = repository(t);
	const lineageId = "review-corrected-lineage";
	const { registry, startTree } = sessionWithStartBinding(cwd, lineageId);
	t.after(() => { try { registry.cleanup(registry.resolveForFinalize(lineageId).token); } catch { /* already cleaned */ } });

	// The bounded correction lands: the candidate identity legitimately moves.
	writeFileSync(join(cwd, "src", "parse.js"), CORRECTED);
	const corrected = liveIdentity(cwd);
	assert.notEqual(corrected.candidateTree, startTree, "the correction must move the candidate tree");

	const harness = approvingNative(correctedStatus(lineageId, corrected));
	const result = await __testing.executeReviewControllerOperation(
		// Exactly the reporter's call: follow the provider transition, no documents.
		{ operation: "finalize", lineageId, input: JSON.stringify({}) },
		cwd, harness.native, undefined, registry,
	) as Record<string, unknown>;

	assert.notEqual(
		(result.diagnostics as { code?: string } | undefined)?.code,
		"candidate-target-projection-drift",
		"a corrected candidate the provider authorized must not read as reviewer-view drift",
	);
	assert.equal(harness.transitions, 1, "the provider's own finalize transition must run");
	assert.equal((result.result as { state?: string } | undefined)?.state, "approved");
});

test("FINALIZE still fails closed when the live candidate does not match the provider projection", async (t) => {
	const cwd = repository(t);
	const lineageId = "review-drifted-lineage";
	const { registry } = sessionWithStartBinding(cwd, lineageId);
	t.after(() => { try { registry.cleanup(registry.resolveForFinalize(lineageId).token); } catch { /* already cleaned */ } });

	// The provider describes a candidate this workspace cannot reproduce.
	const identity = liveIdentity(cwd);
	const harness = approvingNative(correctedStatus(lineageId, { ...identity, candidateTree: identity.baseTree }));
	const result = await __testing.executeReviewControllerOperation(
		{ operation: "finalize", lineageId, input: JSON.stringify({}) },
		cwd, harness.native, undefined, registry,
	) as Record<string, unknown>;

	assert.equal(result.status, "blocked", "an unverifiable candidate must never mint a receipt");
	assert.equal(result.mutation_outcome, "none");
	assert.equal(harness.transitions, 0, "no provider transition may run for an unverifiable candidate");
});
