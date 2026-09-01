import assert from "node:assert/strict";
import test from "node:test";
import {
	CorrectionScopeError,
	resolveBoundedCorrectionPlan,
	type CorrectionScopeRequestV1,
} from "../lib/review-correction-lifecycle.ts";

function request(overrides: Partial<CorrectionScopeRequestV1> = {}): CorrectionScopeRequestV1 {
	return {
		mode: "ordinary",
		confirmedFindings: [
			{ id: "finding-a", paths: ["src/a.ts", "src/shared.ts"] },
			{ id: "finding-b", paths: ["src/b.ts"] },
		],
		findingIds: ["finding-a", "finding-b"],
		paths: ["src/a.ts", "src/b.ts", "src/shared.ts"],
		forecast: {
			positive: true,
			findingIds: ["finding-a", "finding-b"],
			paths: ["src/a.ts", "src/b.ts", "src/shared.ts"],
			effects: ["Correct only the confirmed findings in the frozen scope"],
		},
		...overrides,
	};
}

test("ordinary correction scope is bounded to confirmed findings and relevant paths", () => {
	const plan = resolveBoundedCorrectionPlan(request());
	assert.deepEqual(plan.findingIds, ["finding-a", "finding-b"]);
	assert.deepEqual(plan.paths, ["src/a.ts", "src/b.ts", "src/shared.ts"]);
	assert.equal(plan.correctionBatches, 1);
	assert.equal(plan.validatorRuns, 1);
	assert.equal(plan.reviewerRuns, 0);
	assert.equal(plan.refuterRuns, 0);
	assert.equal(plan.rerunLenses, false);
	assert.equal(plan.rerunRefutation, false);
	assert.equal(plan.changedLineBudget, "none");
	assert.equal(Object.hasOwn(plan, "changedLines"), false);
});

test("correction scope rejects unknown or duplicate findings and paths outside the frozen finding scope", () => {
	for (const invalid of [
		{ findingIds: ["finding-a", "missing"] },
		{ findingIds: ["finding-a", "finding-a"] },
		{ paths: ["src/a.ts", "src/a.ts"] },
		{ paths: ["src/a.ts", "docs/readme.md"] },
	]) {
		assert.throws(
			() => resolveBoundedCorrectionPlan(request(invalid)),
			(error: unknown) => error instanceof CorrectionScopeError,
		);
	}
});

test("correction scope rejects unsafe paths and an empty correction selection", () => {
	for (const paths of [["/etc/passwd"], ["../outside.ts"], ["src/../outside.ts"], ["src\\outside.ts"], []]) {
		assert.throws(
			() => resolveBoundedCorrectionPlan(request({ paths })),
			(error: unknown) => error instanceof CorrectionScopeError,
		);
	}
	assert.throws(() => resolveBoundedCorrectionPlan(request({ findingIds: [] })), CorrectionScopeError);
});

test("correction scope requires a positive forecast matching the exact finding and path scope", () => {
	assert.throws(
		() => resolveBoundedCorrectionPlan(request({ forecast: undefined })),
		CorrectionScopeError,
	);
	assert.throws(
		() => resolveBoundedCorrectionPlan(request({ forecast: { ...request().forecast!, positive: false } })),
		CorrectionScopeError,
	);
	assert.throws(
		() => resolveBoundedCorrectionPlan(request({ forecast: { ...request().forecast!, paths: ["src/a.ts"] } })),
		CorrectionScopeError,
	);
});

test("Judgment Day keeps two judge rounds and zero refutation or validator work", () => {
	const plan = resolveBoundedCorrectionPlan(request({ mode: "judgment-day" }));
	assert.equal(plan.correctionBatches, 2);
	assert.equal(plan.judgmentRounds, 2);
	assert.equal(plan.validatorRuns, 0);
	assert.equal(plan.refuterRuns, 0);
	assert.equal(plan.rerunLenses, false);
	assert.equal(plan.rerunRefutation, false);
});

test("correction scope returns detached data and does not mutate its request", () => {
	const input = request();
	const before = structuredClone(input);
	const plan = resolveBoundedCorrectionPlan(input);
	assert.notEqual(plan.findingIds, input.findingIds);
	assert.notEqual(plan.paths, input.paths);
	assert.deepEqual(input, before);
});

test("correction paths remain explicitly bounded to each confirmed finding", () => {
	const pathsByFinding = [
		{ findingId: "finding-a", paths: ["src/a.ts", "src/shared.ts"] },
		{ findingId: "finding-b", paths: ["src/b.ts"] },
	];
	const input = request({
		pathsByFinding,
		forecast: { ...request().forecast!, pathsByFinding },
	} as Partial<CorrectionScopeRequestV1>);
	const plan = resolveBoundedCorrectionPlan(input);
	assert.deepEqual(plan.pathsByFinding, pathsByFinding);

	const crossBounded = request({
		pathsByFinding: [
			{ findingId: "finding-a", paths: ["src/b.ts"] },
			{ findingId: "finding-b", paths: ["src/a.ts", "src/shared.ts"] },
		],
	} as Partial<CorrectionScopeRequestV1>);
	assert.throws(
		() => resolveBoundedCorrectionPlan(crossBounded),
		(error: unknown) => error instanceof CorrectionScopeError,
	);
});

test("correction scope rejects ambiguous shared paths without an explicit assignment", () => {
	const shared = "src/shared.ts";
	const sharedFindings = request({
		confirmedFindings: [
			{ id: "finding-a", paths: [shared] },
			{ id: "finding-b", paths: [shared] },
		],
		findingIds: ["finding-a", "finding-b"],
		paths: [shared],
		forecast: {
			positive: true,
			findingIds: ["finding-a", "finding-b"],
			paths: [shared],
			effects: ["Correct the shared path for both findings"],
		},
	});
	assert.throws(
		() => resolveBoundedCorrectionPlan(sharedFindings),
		(error: unknown) => error instanceof CorrectionScopeError,
	);

	const explicit = request({
		confirmedFindings: sharedFindings.confirmedFindings,
		findingIds: sharedFindings.findingIds,
		paths: [shared],
		pathsByFinding: {
			"finding-a": [shared],
			"finding-b": [shared],
		},
		forecast: {
			...sharedFindings.forecast,
			pathsByFinding: {
				"finding-a": [shared],
				"finding-b": [shared],
			},
		},
	} as Partial<CorrectionScopeRequestV1>);
	assert.deepEqual(resolveBoundedCorrectionPlan(explicit).pathsByFinding, [
		{ findingId: "finding-a", paths: [shared] },
		{ findingId: "finding-b", paths: [shared] },
	]);
});
