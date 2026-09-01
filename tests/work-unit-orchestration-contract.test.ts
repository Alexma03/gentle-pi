import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
function asset(path: string): string {
	return readFileSync(new URL(path, root), "utf8");
}

test("orchestrator assets define DAG readiness, leases, and writer serialization", () => {
	const delegation = asset("assets/orchestrator-delegation.md");
	const workflow = asset("assets/sdd-orchestrator-workflow.md");
	assert.match(delegation, /DAG readiness gate/);
	assert.match(delegation, /writer lease/);
	assert.match(delegation, /read\/verify.*parallel/i);
	assert.match(delegation, /settlement.*release/i);
	assert.match(workflow, /readiness.*before.*native.*acquire/i);
	assert.match(workflow, /native attempt authority remains provider-owned/i);
	assert.match(workflow, /writer.*serialization/i);
});

test("phase agents carry cumulative handoff and work-unit ownership rules", () => {
	for (const name of ["sdd-tasks", "sdd-apply", "sdd-verify"]) {
		const content = asset(`assets/agents/${name}.md`);
		assert.match(content, /work-unit/i, name);
		assert.match(content, /dependency/i, name);
		assert.match(content, /native attempt authority/i, name);
	}
	assert.match(asset("assets/agents/sdd-apply.md"), /READ-MERGE-WRITE|cumulative.*apply-progress/i);
	assert.match(asset("assets/agents/sdd-verify.md"), /previous apply-progress|full cumulative apply-progress/i);
});

test("chain assets route DAG slices through apply and verification", () => {
	const full = asset("assets/chains/sdd-full.chain.md");
	const verify = asset("assets/chains/sdd-verify.chain.md");
	assert.match(full, /DAG readiness/i);
	assert.match(full, /final integration/i);
	assert.match(full, /feature-branch-chain/i);
	assert.match(verify, /previous apply-progress/i);
	assert.match(verify, /DAG readiness/i);
	assert.match(verify, /final verification/i);
});

test("status support stays artifact-only and never carries runtime attempt state", () => {
	const support = asset("assets/support/sdd-status-contract.md");
	const source = asset("lib/sdd-status.ts");
	assert.match(support, /artifact-only/i);
	assert.match(support, /never.*attempt.*token/i);
	assert.match(support, /work-unit.*readiness/i);
	assert.doesNotMatch(source, /attemptToken|attemptCounter|attempts\s*:/i);
});
