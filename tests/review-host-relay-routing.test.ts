import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";
import { REVIEW_HOST_RELAY_FAILURE, REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE, ReviewHostRelayError, type ReviewHostRelayRequest } from "../lib/review-host-relay.ts";
import type { ReviewCollectInputV3, ReviewStatusV3 } from "../lib/review-integration-v2.ts";

// Wiring contract (gentle-pi#311 P4): the compact controller FINALIZE lane
// routes pi-slot capture inputs through the host relay ONLY when the
// provider-returned collect input carries the --materialize token. Every
// other lane and slot stays untouched.

const SHA = `sha256:${"1".repeat(64)}`;
const TREE = "2".repeat(40);

function repository(t: test.TestContext): string {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-relay-routing-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	execFileSync("git", ["init", "-b", "main"], { cwd });
	writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "."], { cwd });
	execFileSync("git", ["-c", "user.name=Relay Test", "-c", "user.email=relay@example.invalid", "commit", "-m", "initial"], { cwd });
	return cwd;
}

function bindingArguments(lineageId: string, lens: string, order: number): ReviewCollectInputV3["arguments"] {
	return [
		{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
		{ name: "expected-revision", value: SHA, token: `--expected-revision=${SHA}` },
		{ name: "target", value: SHA, token: `--target=${SHA}` },
		{ name: "repository-context", value: `rctx1_${"e".repeat(64)}`, token: `--repository-context=rctx1_${"e".repeat(64)}` },
		{ name: "lens", value: lens, token: `--lens=${lens}` },
		{ name: "order", value: String(order), token: `--order=${order}` },
		{ name: "subject-hash", value: `sha256:${String(order).repeat(64)}`, token: `--subject-hash=sha256:${String(order).repeat(64)}` },
	];
}

function relayCollectInput(lineageId: string, lens: string, order: number, materialize = true): ReviewCollectInputV3 {
	return {
		name: "reviewer_result",
		schema: "https://gentle-ai.dev/schema/review/reviewer/v1",
		captureOperation: "review.capture-result",
		arguments: [
			...bindingArguments(lineageId, lens, order),
			...(materialize ? [
				{ name: "agent", value: "pi", token: "--agent=pi" },
				{ name: "materialize", value: "true", token: "--materialize=true" },
			] : []),
		],
	};
}

function finalizeStatus(lineageId: string, inputs?: readonly ReviewCollectInputV3[]): ReviewStatusV3 {
	return {
		contract: "gentle-ai.review-integration/v2",
		applicability: "current_target",
		authority: { version: "compact-v2", lineageId, state: "reviewing", generation: 1, revision: SHA },
		receipt: { status: "none" },
		action: "finalize",
		replayability: "unknown",
		targetIdentity: SHA,
		projection: {
			schema: "gentle-ai.review-candidate-projection/v1",
			kind: "current-changes",
			projection: "workspace",
			baseTree: TREE,
			initialReviewTree: TREE,
			currentCandidateTree: TREE,
			pathsDigest: SHA,
			paths: ["app.ts"],
			intendedUntracked: [],
			intendedUntrackedProof: SHA,
			initialSnapshotIdentity: SHA,
			currentSnapshotIdentity: SHA,
		},
		candidates: [],
		...(inputs === undefined ? {} : { nextTransition: { kind: "collect", reasonCode: "reviewer_results_required", collect: { inputs: [...inputs] } } }),
		raw: { schema: "gentle-ai.review-integration.status/v3", action: "finalize", lineage_id: lineageId },
	} as unknown as ReviewStatusV3;
}

interface RoutingHarness {
	statusQueue: ReviewStatusV3[];
	statusCalls: Array<{ cwd: string; lineageId?: string }>;
	finalizeCalls: number;
	native: NativeReviewCli;
}

function nativeHarness(statuses: readonly ReviewStatusV3[]): RoutingHarness {
	const harness: RoutingHarness = {
		statusQueue: [...statuses],
		statusCalls: [],
		finalizeCalls: 0,
		native: undefined as unknown as NativeReviewCli,
	};
	harness.native = {
		start: async () => { throw new Error("unexpected start"); },
		finalize: async () => {
			harness.finalizeCalls += 1;
			return { lineageId: "relay-lineage", state: "approved", action: "approved", storeRevision: "r1" };
		},
		validate: async () => { throw new Error("unexpected validate"); },
		bindSdd: async () => { throw new Error("unexpected bindSdd"); },
		sddStatus: async () => ({ ready: false, artifactStore: "none", artifacts: {} as never, nextRecommended: "" }),
		reviewStatus: async () => { throw new Error("unexpected reviewStatus"); },
		targetStatus: async (request) => {
			harness.statusCalls.push({ cwd: request.cwd, ...(request.lineageId === undefined ? {} : { lineageId: request.lineageId }) });
			const next = harness.statusQueue.shift();
			if (next === undefined) throw new Error("status queue exhausted");
			return next;
		},
	};
	return harness;
}

function finalizeParameters(lineageId: string, input: Record<string, unknown> = {}): Record<string, unknown> {
	return { operation: "finalize", lineageId, input: JSON.stringify(input) };
}

async function runFinalize(cwd: string, harness: RoutingHarness, lineageId: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	return await __testing.executeReviewControllerOperation(
		finalizeParameters(lineageId, input),
		cwd,
		new Map(),
		harness.native,
	) as Record<string, unknown>;
}

test("materialize-marked pi slots route through the host relay in provider order and re-query STATUS", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const inputs = [
		relayCollectInput(lineageId, "review-risk", 0),
		relayCollectInput(lineageId, "review-reliability", 1),
	];
	const harness = nativeHarness([finalizeStatus(lineageId, inputs), finalizeStatus(lineageId)]);
	const relayed: ReviewHostRelayRequest[] = [];
	__testing.setReviewHostRelayRunnerForTesting(async (request: ReviewHostRelayRequest) => {
		relayed.push(request);
		return { promptByteLength: 64, resultByteLength: 32, submission: '{"admission_decision":"completed"}' };
	});

	const result = await runFinalize(cwd, harness, lineageId);

	assert.equal(relayed.length, 2);
	assert.deepEqual(relayed[0]!.captureArgumentTokens, inputs[0]!.arguments.map((argument) => argument.token));
	assert.deepEqual(relayed[0]!.submitArgumentTokens, bindingArguments(lineageId, "review-risk", 0).map((argument) => argument.token));
	assert.deepEqual(relayed[1]!.captureArgumentTokens, inputs[1]!.arguments.map((argument) => argument.token));
	assert.deepEqual(relayed[1]!.submitArgumentTokens, bindingArguments(lineageId, "review-reliability", 1).map((argument) => argument.token));

	assert.equal(harness.finalizeCalls, 0, "the relay never invokes native finalize itself");
	assert.equal(harness.statusCalls.length, 2, "STATUS is re-queried after all slots are captured");
	assert.deepEqual(harness.statusCalls[1], { cwd, lineageId });

	const hostRelay = result.host_relay as { transport: string; captured_slots: Array<Record<string, unknown>> };
	assert.equal(hostRelay.transport, "pi_host_relay");
	assert.equal(hostRelay.captured_slots.length, 2);
	assert.deepEqual(hostRelay.captured_slots.map((slot) => slot.lens), ["review-risk", "review-reliability"]);
	assert.equal(result.status, "in-progress");
});

test("Pi-authored review documents are inadmissible for host-mediated materialize slots", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const harness = nativeHarness([finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-reliability", 0)])]);
	let relayCalls = 0;
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		relayCalls += 1;
		return { promptByteLength: 1, resultByteLength: 1, submission: "{}" };
	});

	const result = await runFinalize(cwd, harness, lineageId, { review_result: { lens_results: [{ findings: [], evidence: ["reviewed"] }] } });

	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "pi-host-relay-slots-are-host-mediated");
	assert.equal(result.mutation_performed, false);
	assert.equal(result.mutation_outcome, "none");
	assert.equal(relayCalls, 0);
	assert.equal(harness.finalizeCalls, 0);
});

test("an old binary reports the relay as unavailable without touching existing behavior", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const harness = nativeHarness([finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-reliability", 0)])]);
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE, "materialize", REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE, { exitCode: 2, stderr: "flag provided but not defined: -materialize" });
	});

	const result = await runFinalize(cwd, harness, lineageId);

	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "pi-host-relay-unavailable");
	assert.equal(result.reason, REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE);
	assert.equal(result.mutation_performed, false);
	assert.equal(result.mutation_outcome, "none");
	assert.equal(harness.finalizeCalls, 0);
});

test("a handshake refusal surfaces the provider refusal verbatim through the controller envelope", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const refusal = "the active runtime is not eligible for immutable receipt review; supported immutable review runtimes: claude-code, codex, opencode";
	const harness = nativeHarness([finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-reliability", 0)])]);
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.HANDSHAKE_REFUSED, "materialize", refusal, { exitCode: 1, stderr: refusal });
	});

	const result = await runFinalize(cwd, harness, lineageId);

	assert.equal(result.outcome, "pi-host-relay-handshake-refused");
	assert.equal(result.reason, refusal);
	assert.equal(result.refusal, refusal);
});

test("a transport failure mid-collection stops immediately and directs STATUS re-query", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const inputs = [
		relayCollectInput(lineageId, "review-risk", 0),
		relayCollectInput(lineageId, "review-reliability", 1),
	];
	const harness = nativeHarness([finalizeStatus(lineageId, inputs)]);
	let calls = 0;
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		calls += 1;
		if (calls === 1) return { promptByteLength: 8, resultByteLength: 8, submission: '{"admission_decision":"completed"}' };
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_FAILED, "pi", "pi subprocess failed", { exitCode: 4 });
	});

	const result = await runFinalize(cwd, harness, lineageId);

	assert.equal(calls, 2);
	assert.equal(result.status, "blocked");
	assert.equal(result.outcome, "pi-host-relay-transport-failure");
	assert.deepEqual(result.failure, { kind: "pi-failed", stage: "pi", exit_code: 4, timed_out: false });
	assert.equal((result.captured_slots as unknown[]).length, 1);
	assert.equal(result.mutation_performed, true);
	assert.match(String(result.next_action), /Re-query negotiated STATUS/);
	assert.match(String(result.next_action), /exact same bound slot/);
	assert.equal(harness.finalizeCalls, 0);
	assert.equal(harness.statusCalls.length, 1, "no automatic relaunch after transport failure");
});

test("collect inputs without the provider-issued materialize token never reach the relay", async (t) => {
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	const cwd = repository(t);
	const lineageId = "relay-lineage";
	const harness = nativeHarness([
		finalizeStatus(lineageId, [relayCollectInput(lineageId, "review-reliability", 0, false)]),
		finalizeStatus(lineageId),
	]);
	let relayCalls = 0;
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		relayCalls += 1;
		return { promptByteLength: 1, resultByteLength: 1, submission: "{}" };
	});

	// The existing lane may fail on the synthetic projection; only the relay
	// boundary is under test here: it must never be consulted.
	try {
		await runFinalize(cwd, harness, lineageId);
	} catch {
		// Existing-lane behavior for this synthetic fixture is out of scope.
	}
	assert.equal(relayCalls, 0);
});
