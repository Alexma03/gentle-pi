#!/usr/bin/env node
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHA = `sha256:${"a".repeat(64)}`;
const TREE = "b".repeat(40);

function createPi() {
	const tools = new Map();
	return {
		tools,
		pi: {
			on() {},
			registerCommand() {},
			registerFlag() {},
			registerTool(definition) { tools.set(definition.name, definition); },
		},
	};
}

function context() {
	return {
		cwd: ROOT,
		hasUI: false,
		ui: { notify() {} },
		sessionManager: { getSessionId: () => "runtime-harness" },
	};
}

function correctionPlanBinding(lineageId) {
	const arguments_ = [
		{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
		{ name: "expected-revision", value: SHA, token: `--expected-revision=${SHA}` },
		{ name: "target", value: SHA, token: `--target=${SHA}` },
		{ name: "repository-context", value: `rctx1_${"c".repeat(64)}`, token: `--repository-context=rctx1_${"c".repeat(64)}` },
		{ name: "lens", value: "review-risk", token: "--lens=review-risk" },
		{ name: "order", value: "0", token: "--order=0" },
		{ name: "subject-hash", value: SHA, token: `--subject-hash=${SHA}` },
	];
	return {
		name: "correction_plan",
		schema: "gentle-ai.review-correction-plan/v1",
		captureOperation: "review.capture-correction-plan",
		arguments: arguments_,
		submission: {
			operationToken: "capture-correction-plan",
			argumentTokens: [...arguments_.map((argument) => argument.token), "--correction-lines={{value}}"],
			values: [{ slot: "correction_lines", domain: "positive_integer", substitutionLocation: 7, minimum: 1, maximum: 1 }],
		},
	};
}

function currentStatus(lineageId) {
	const input = correctionPlanBinding(lineageId);
	return {
		contract: "gentle-ai.review-integration/v2",
		applicability: "current_target",
		authority: { version: "compact-v2", lineageId, state: "correction_required", generation: 1, revision: SHA },
		receipt: { status: "expected_missing" },
		action: "stop",
		replayability: "not_replayable",
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
		repair: { schema: "gentle-ai.review-authority-repair-assessment/v1", status: "unsupported", counts: { lineages: 0, compactLineages: 0, legacyLineages: 0, events: 0, bytes: 0, eligibleCandidates: 0, unsupportedLineages: 0, conflicts: 0 }, supportedOperations: ["review/complete-fix", "review/validate-fix"], authorizationSchema: "gentle-ai.review-repair-authorization/v1" },
		candidates: [],
		nextTransition: { kind: "collect", reasonCode: "correction_plan_required", collect: { inputs: [input] } },
		raw: { schema: "gentle-ai.review-integration.status/v5" },
	};
}

async function run() {
	const lineageId = "runtime-last-event";
	const calls = [];
	const nativeReviewCli = {
		async targetStatus(request) {
			calls.push({ operation: "status", request });
			return currentStatus(lineageId);
		},
		async captureCorrectionPlan(request) {
			calls.push({ operation: "capture-correction-plan", request });
			return {
				schema: "gentle-ai.review-last-event-closure/v1",
				operation: "review.capture-correction-plan",
				lineageId,
				state: "correction_required",
				targetIdentity: SHA,
				requestHash: SHA,
				correctionLines: 1,
				storeRevision: SHA,
			};
		},
	};
	const { pi, tools } = createPi();
	createGentleAiExtension({ nativeReviewCli })(pi);
	const controller = tools.get("gentle_review");
	const capture = tools.get("gentle_review_capture");
	assert.ok(controller, "runtime must register the public status controller");
	assert.ok(capture, "runtime must register the one-slot capture tool");
	assert.equal(controller.parameters.properties.operation.enum.includes("finalize"), false);

	const status = await controller.execute("runtime-status", { operation: "status", lineageId }, undefined, undefined, context());
	const collectBindings = status.details.collectBindings;
	assert.equal(status.details.status, "blocked");
	assert.equal(collectBindings.length, 1);

	const captured = await capture.execute(
		"runtime-capture",
		{ lineageId, collectBinding: collectBindings[0].collectBinding, correctionLines: 1 },
		undefined,
		undefined,
		context(),
	);
	assert.equal(captured.details.status, "closed");
	assert.equal(captured.details.outcome, "native-last-event-closure");
	assert.equal(captured.details.closure.operation, "review.capture-correction-plan");
	assert.deepEqual(calls.map(({ operation }) => operation), ["status", "status", "capture-correction-plan"]);
	assert.equal(calls.some(({ operation }) => operation === "finalize" || operation === "capture-evidence" || operation === "advance" || operation === "validate"), false);
}

run().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
