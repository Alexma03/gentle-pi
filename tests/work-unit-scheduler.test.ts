import assert from "node:assert/strict";
import test from "node:test";
import {
	WorkUnitSchedulerError,
	WorkUnitSchedulerV1,
	selectReadyWorkUnits,
	validateWorkUnitGraph,
	type WorkUnitDefinitionV1,
} from "../lib/work-unit-scheduler.ts";

function unit(
	id: string,
	overrides: Partial<WorkUnitDefinitionV1> = {},
): WorkUnitDefinitionV1 {
	return {
		id,
		dependencies: [],
		repository: "repo",
		worktree: "tree-a",
		mode: "read",
		...overrides,
	};
}

function scheduler(units: readonly WorkUnitDefinitionV1[]): WorkUnitSchedulerV1 {
	return new WorkUnitSchedulerV1(units);
}

test("work-unit graph rejects unknown and duplicate dependencies before any readiness", () => {
	assert.throws(
		() => validateWorkUnitGraph([unit("build", { dependencies: ["missing"] })]),
		(error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "unknown_dependency",
	);
	assert.throws(
		() => validateWorkUnitGraph([unit("build", { dependencies: ["base", "base"] }), unit("base")]),
		(error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "duplicate_dependency",
	);
	assert.throws(
		() => validateWorkUnitGraph([unit("same"), unit("same")]),
		(error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "duplicate_unit",
	);
});

test("work-unit graph rejects self and indirect cycles with no partial scheduler", () => {
	for (const graph of [
		[unit("self", { dependencies: ["self"] })],
		[unit("a", { dependencies: ["b"] }), unit("b", { dependencies: ["a"] })],
		[unit("a", { dependencies: ["b"] }), unit("b", { dependencies: ["c"] }), unit("c", { dependencies: ["a"] })],
	]) {
		assert.throws(
			() => scheduler(graph),
			(error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "cyclic_dependency",
		);
	}
});

test("ready selection is dependency-aware and deterministic", () => {
	const plan = scheduler([
		unit("z-last", { dependencies: ["a-first"] }),
		unit("a-first"),
		unit("m-middle"),
		unit("child", { dependencies: ["m-middle"] }),
	]);
	assert.deepEqual(plan.readyUnits().map(({ id }) => id), ["a-first", "m-middle"]);
	assert.deepEqual(selectReadyWorkUnits([
		unit("z-last", { dependencies: ["a-first"] }),
		unit("a-first"),
		unit("m-middle"),
		unit("child", { dependencies: ["m-middle"] }),
	], ["a-first", "m-middle"]).map(({ id }) => id), ["child", "z-last"]);
	const first = plan.acquireLease("a-first", { idempotencyKey: "a-first-launch" });
	assert.deepEqual(plan.readyUnits().map(({ id }) => id), ["m-middle"]);
	plan.settle(first, {
		outcome: "passed",
		focusedChecks: ["unit check passed"],
		runtimeHarness: "N/A — pure scheduler",
		finalVerification: "not-applicable",
		rollbackBoundary: "scheduler graph",
	});
	assert.deepEqual(plan.readyUnits().map(({ id }) => id), ["m-middle", "z-last"]);
});

test("readiness must be proven before native acquire and incomplete dependencies never lease", () => {
	const plan = scheduler([unit("base"), unit("dependent", { dependencies: ["base"] })]);
	assert.equal(plan.readiness("dependent").state, "blocked");
	assert.throws(
		() => plan.assertReadyForNativeAcquire("dependent"),
		(error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "dependency_not_ready",
	);
	assert.throws(
		() => plan.acquireLease("dependent", { idempotencyKey: "dependent-launch" }),
		(error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "dependency_not_ready",
	);
	const base = plan.acquireLease("base", { idempotencyKey: "base-launch" });
	plan.settle(base, {
		outcome: "passed",
		focusedChecks: ["base check"],
		runtimeHarness: "N/A",
		finalVerification: "pending",
		rollbackBoundary: "base unit",
	});
	assert.doesNotThrow(() => plan.assertReadyForNativeAcquire("dependent"));
});

test("selectReadyWorkUnits is pure while scheduler readiness includes leased conflicts", () => {
	const units = [
		unit("writer", { mode: "write", writeSurface: ["src/a.ts"] }),
		unit("reader", { mode: "read" }),
		unit("verify", { mode: "verify" }),
	];
	assert.deepEqual(selectReadyWorkUnits(units).map(({ id }) => id), ["reader", "verify", "writer"]);
	const plan = scheduler(units);
	plan.acquireLease("writer", { idempotencyKey: "writer-launch" });
	assert.deepEqual(plan.readyUnits().map(({ id }) => id), []);
});

test("one writer per worktree serializes writers and blocks same-worktree reads while allowing isolated worktrees", () => {
	const plan = scheduler([
		unit("write-a", { mode: "write", writeSurface: ["src/a.ts"] }),
		unit("write-b", { mode: "write", writeSurface: ["src/b.ts"] }),
		unit("read-a", { mode: "read" }),
		unit("verify-b", { mode: "verify", worktree: "tree-b" }),
	]);
	const lease = plan.acquireLease("write-a", { idempotencyKey: "write-a-launch" });
	assert.throws(
		() => plan.acquireLease("write-b", { idempotencyKey: "write-b-launch" }),
		(error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "writer_conflict",
	);
	assert.throws(
		() => plan.acquireLease("read-a", { idempotencyKey: "read-a-launch" }),
		(error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "writer_conflict",
	);
	assert.doesNotThrow(() => plan.acquireLease("verify-b", { idempotencyKey: "verify-b-launch" }));
	plan.settle(lease, {
		outcome: "failed",
		focusedChecks: ["writer failed"],
		runtimeHarness: "not-run after failure",
		finalVerification: "not-applicable",
		rollbackBoundary: "write-a only",
	});
	assert.doesNotThrow(() => plan.acquireLease("write-b", { idempotencyKey: "write-b-retry" }));
});

test("independent read and verify leases run in parallel when no writer owns their worktree", () => {
	const plan = scheduler([
		unit("read-one", { mode: "read", worktree: "tree-a" }),
		unit("verify-one", { mode: "verify", worktree: "tree-a" }),
		unit("read-two", { mode: "read", worktree: "tree-b" }),
	]);
	const read = plan.acquireLease("read-one", { idempotencyKey: "read-one-launch" });
	const verify = plan.acquireLease("verify-one", { idempotencyKey: "verify-one-launch" });
	assert.notEqual(read.workUnitId, verify.workUnitId);
	assert.doesNotThrow(() => plan.acquireLease("read-two", { idempotencyKey: "read-two-launch" }));
});

test("duplicate lease requests are idempotent only for the same work unit and key", () => {
	const plan = scheduler([unit("read")]);
	const first = plan.acquireLease("read", { idempotencyKey: "same-request" });
	const duplicate = plan.acquireLease("read", { idempotencyKey: "same-request" });
	assert.deepEqual(duplicate, first);
	assert.throws(
		() => plan.acquireLease("read", { idempotencyKey: "different-request" }),
		(error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "lease_conflict",
	);
});

test("settling failure or cancellation releases the worktree lease and preserves terminal evidence", () => {
	const plan = scheduler([
		unit("failed-write", { mode: "write" }),
		unit("next-write", { mode: "write" }),
		unit("cancelled-read", { mode: "read", worktree: "tree-b" }),
	]);
	const failed = plan.acquireLease("failed-write", { idempotencyKey: "failed" });
	plan.settle(failed, { outcome: "failed", focusedChecks: ["failed"], runtimeHarness: "failed", finalVerification: "not-applicable", rollbackBoundary: "failed-write" });
	assert.equal(plan.status("failed-write").status, "failed");
	assert.doesNotThrow(() => plan.acquireLease("next-write", { idempotencyKey: "next" }));
	const cancelled = plan.acquireLease("cancelled-read", { idempotencyKey: "cancelled" });
	plan.settle(cancelled, { outcome: "cancelled", focusedChecks: ["cancelled"], runtimeHarness: "cancelled", finalVerification: "not-applicable", rollbackBoundary: "cancelled-read" });
	assert.equal(plan.status("cancelled-read").status, "cancelled");
	assert.equal(plan.activeLease("cancelled-read"), undefined);
});

test("settlement is idempotent for the same lease and conflicting settlement is rejected", () => {
	const plan = scheduler([unit("read")]);
	const lease = plan.acquireLease("read", { idempotencyKey: "settle-once" });
	const evidence = { outcome: "passed" as const, focusedChecks: ["check"], runtimeHarness: "N/A", finalVerification: "pending" as const, rollbackBoundary: "read" };
	const first = plan.settle(lease, evidence);
	assert.deepEqual(plan.settle(lease, evidence), first);
	assert.throws(
		() => plan.settle(lease, { ...evidence, outcome: "failed" }),
		(error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "settlement_conflict",
	);
});

test("integration stays blocked until every unit has evidence and final verification passes", () => {
	const plan = scheduler([
		unit("read"),
		unit("verify", { mode: "verify" }),
	]);
	for (const id of ["read", "verify"]) {
		const lease = plan.acquireLease(id, { idempotencyKey: `${id}-launch` });
		plan.settle(lease, { outcome: "passed", focusedChecks: [`${id} check`], runtimeHarness: "N/A", finalVerification: "pending", rollbackBoundary: `${id} only` });
	}
	assert.equal(plan.integrationReady(), false);
	assert.throws(() => plan.assertIntegrationReady(), /final verification/i);
	plan.recordFinalVerification({ passed: true, evidence: ["full verification passed"] });
	assert.equal(plan.integrationReady(), true);
	assert.doesNotThrow(() => plan.assertIntegrationReady());
	assert.doesNotThrow(() => plan.recordFinalVerification({ passed: true, evidence: ["full verification passed"] }));
	assert.throws(() => plan.recordFinalVerification({ passed: false, evidence: ["different result"] }), (error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "settlement_conflict");
});

test("public final-verification accessor returns the recorded detached evidence", () => {
	const plan = scheduler([unit("read")]);
	assert.equal(plan.finalVerification(), undefined);
	plan.recordFinalVerification({ passed: true, evidence: ["full verification passed"] });
	const verification = plan.finalVerification();
	assert.deepEqual(verification, { passed: true, evidence: ["full verification passed"] });
	assert.notEqual(verification?.evidence, ["full verification passed"]);
});

test("successful final verification requires bounded non-empty evidence", () => {
	const plan = scheduler([unit("read")]);
	assert.throws(
		() => plan.recordFinalVerification({ passed: true, evidence: [] }),
		(error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "invalid_settlement",
	);
	assert.equal(plan.integrationReady(), false);
});

test("successful final verification rejects sparse evidence and keeps integration blocked", () => {
	const plan = scheduler([unit("read")]);
	const lease = plan.acquireLease("read", { idempotencyKey: "sparse-evidence" });
	plan.settle(lease, {
		outcome: "passed",
		focusedChecks: ["read check"],
		runtimeHarness: "N/A",
		finalVerification: "pending",
		rollbackBoundary: "read",
	});
	const sparseEvidence = new Array<string>(1);
	assert.throws(
		() => plan.recordFinalVerification({ passed: true, evidence: sparseEvidence }),
		(error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "invalid_settlement",
	);
	assert.equal(plan.integrationReady(), false);
});

test("null write surfaces fail with a typed graph validation error", () => {
	assert.throws(
		() => scheduler([unit("invalid", { mode: undefined, writeSurface: null as unknown as readonly string[] })]),
		(error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "invalid_unit",
	);
});

test("settlement requires the complete bound lease identity", () => {
	const evidence = {
		outcome: "passed" as const,
		focusedChecks: ["check"],
		runtimeHarness: "N/A",
		finalVerification: "pending" as const,
		rollbackBoundary: "read",
	};
	const variants: readonly Partial<ReturnType<WorkUnitSchedulerV1["acquireLease"]>>[] = [
		{ repository: "another-repository" },
		{ worktree: "another-worktree" },
		{ mode: "verify" },
		{ writeSurface: ["src/other.ts"] },
	];
	for (const variant of variants) {
		const plan = scheduler([unit("read")]);
		const lease = plan.acquireLease("read", { idempotencyKey: "settle-identity" });
		assert.throws(
			() => plan.settle({ ...lease, ...variant }, evidence),
			(error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "lease_missing",
		);
		assert.equal(plan.status("read").status, "leased");
		assert.doesNotThrow(() => plan.settle(lease, evidence));
		assert.throws(
			() => plan.settle({ ...lease, worktree: "another-worktree" }, evidence),
			(error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "lease_missing",
		);
	}
});

test("settlement rejects forged cross-unit identities even with a copied lease key", () => {
	const plan = scheduler([unit("read-one"), unit("read-two")]);
	const first = plan.acquireLease("read-one", { idempotencyKey: "shared-lease" });
	const second = plan.acquireLease("read-two", { idempotencyKey: "shared-lease" });
	const evidence = {
		outcome: "passed" as const,
		focusedChecks: ["check"],
		runtimeHarness: "N/A",
		finalVerification: "pending" as const,
		rollbackBoundary: "read",
	};

	assert.throws(
		() => plan.settle({ ...first, workUnitId: "read-two", leaseKey: first.leaseKey }, evidence),
		(error: unknown) => error instanceof WorkUnitSchedulerError && error.code === "lease_missing",
	);
	assert.equal(plan.status("read-one").status, "leased");
	assert.equal(plan.status("read-two").status, "leased");
	assert.doesNotThrow(() => plan.settle(first, evidence));
	assert.doesNotThrow(() => plan.settle(second, evidence));
});
