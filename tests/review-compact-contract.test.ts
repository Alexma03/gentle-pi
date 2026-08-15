import assert from "node:assert/strict";
import test from "node:test";
import {
	CompactReviewContractError,
	parseNativeCompactFinalizeInput,
	toNativeValidatorDocument,
} from "../lib/review-compact-contract.ts";

const REQUEST_HASH = "a".repeat(64);

// gentle-pi#311 P5: the FINALIZE input contract carries only the negotiated
// collection answers. Pi-authored reviewer, refuter, and validator-proof
// payloads are retired — lens results are admitted natively, and the
// adversarial roles execute through Go-owned pi processes via
// provider-rendered self-contained vectors.
test("compact finalize parser rejects the retired Pi-authored payload fields", () => {
	for (const retired of [
		{ review_result: { lens_results: [] } },
		{ refuter_batch: { schema: "gentle-ai.refuter-result-batch/v1", request_hash: REQUEST_HASH, results: [] } },
		{ validation_proof: { original_criteria: { passed: true, evidence: ["ok"] }, correction_regression: { passed: true, evidence: ["ok"] } } },
	]) {
		assert.throws(
			() => parseNativeCompactFinalizeInput({ cwd: "/repo", ...retired }),
			(error: unknown) => error instanceof CompactReviewContractError && error.code === "unknown-key",
		);
	}
});

test("compact finalize parser enforces the final evidence pairing and forecast range", () => {
	assert.throws(
		() => parseNativeCompactFinalizeInput({ cwd: "/repo", final_evidence: "passed" }),
		(error: unknown) => error instanceof CompactReviewContractError && error.code === "field-pair",
	);
	assert.throws(
		() => parseNativeCompactFinalizeInput({ cwd: "/repo", final_verification_passed: true }),
		(error: unknown) => error instanceof CompactReviewContractError && error.code === "field-pair",
	);
	assert.throws(() => parseNativeCompactFinalizeInput({ cwd: "/repo", correction_line_forecast: 0 }), CompactReviewContractError);
	assert.equal(parseNativeCompactFinalizeInput({ cwd: "/repo", correction_line_forecast: 3 }).correction_line_forecast, 3);
	assert.throws(() => parseNativeCompactFinalizeInput({ cwd: "/repo", lineageId: "bad lineage!" }), CompactReviewContractError);
});

test("native finalize preserves arbitrary non-empty evidence text byte-for-byte", () => {
	const evidence = " \tleading evidence\nterminal newlines\n\n";
	assert.equal(parseNativeCompactFinalizeInput({ cwd: "/repo", final_evidence: evidence, final_verification_passed: true }).final_evidence, evidence);
	for (const outcome of ["passed", "verification_failed", "procedural_tooling_failed"] as const) {
		assert.equal(parseNativeCompactFinalizeInput({ cwd: "/repo", final_evidence: evidence, final_verification_outcome: outcome }).final_verification_outcome, outcome);
	}
	assert.throws(() => parseNativeCompactFinalizeInput({ cwd: "/repo", final_evidence: evidence, final_verification_outcome: "failed" }), CompactReviewContractError);
	assert.throws(() => parseNativeCompactFinalizeInput({ cwd: "/repo", final_evidence: evidence, final_verification_passed: true, final_verification_outcome: "passed" }), CompactReviewContractError);
	assert.throws(() => parseNativeCompactFinalizeInput({ cwd: "/repo", final_evidence: "", final_verification_passed: true }), CompactReviewContractError);
});

test("targeted validation document keeps its strict provider-bound shape", () => {
	const validation = {
		request_hash: REQUEST_HASH,
		correction_ids: ["RISK-001"],
		original_criteria: { passed: true, evidence: ["acceptance passes"] },
		correction_regression: { passed: true, evidence: ["regression suite passes"] },
		fix_caused_findings: [],
		follow_ups: [{ finding_id: "RISK-001", location: "lib/a.ts:1", summary: "Track the remaining cleanup", proof_refs: ["differential-test:covered"] }],
	};
	const parsed = parseNativeCompactFinalizeInput({ cwd: "/repo", validation, final_evidence: "full suite passed", final_verification_passed: true });
	assert.deepEqual(parsed.validation, validation);
	assert.deepEqual(toNativeValidatorDocument(parsed.validation!), {
		original_criteria: validation.original_criteria,
		correction_regression: validation.correction_regression,
		follow_ups: [{ observation: "Track the remaining cleanup", proof_refs: ["differential-test:covered"] }],
	});

	for (const invalid of [
		{ ...validation, request_hash: "not-a-digest" },
		{ ...validation, fix_caused_findings: [{ id: "FIX-001" }] },
		{ ...validation, original_criteria: { passed: true, evidence: [] } },
		{ ...validation, correction_regression: { passed: "yes", evidence: ["ok"] } },
		{ ...validation, follow_ups: [{ ...validation.follow_ups[0], proof_refs: [] }] },
		{ ...validation, extra_field: true },
	]) {
		assert.throws(() => parseNativeCompactFinalizeInput({ cwd: "/repo", validation: invalid, final_evidence: "evidence", final_verification_passed: true }), CompactReviewContractError);
	}
});
