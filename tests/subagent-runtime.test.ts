import assert from "node:assert/strict";
import test from "node:test";
import {
	MANDATORY_SUBAGENT_CAPABILITIES,
	SubagentRuntimeError,
	SubagentRuntimeV1,
	assertSubagentResultV1,
	assertSubagentTaskV1,
	isSubagentResultV1,
	isSubagentTaskV1,
	type SubagentRuntimeAdapterV1,
	type SubagentRuntimeCapabilitiesV1,
	type SubagentRuntimeHandleV1,
	type SubagentRuntimeStatusV1,
	type SubagentResultV1,
	type SubagentTaskV1,
} from "../lib/subagent-runtime.ts";

const CAPABILITIES: SubagentRuntimeCapabilitiesV1 = {
	protocol: 1,
	provider: "nicobailon",
	capabilities: [...MANDATORY_SUBAGENT_CAPABILITIES],
};

const TASK: SubagentTaskV1 = {
	task: "Implement the runtime boundary.",
	context: "Use the approved architecture.",
	dependencies: ["design"],
	expectedOutcome: "A portable runtime contract with focused tests.",
};

function adapter(overrides: Partial<SubagentRuntimeAdapterV1> = {}): SubagentRuntimeAdapterV1 {
	const handle: SubagentRuntimeHandleV1 = { id: "run-1" };
	const status: SubagentRuntimeStatusV1 = { id: handle.id, status: "running" };
	return {
		negotiate: async () => CAPABILITIES,
		start: async () => handle,
		status: async () => status,
		cancel: async () => {},
		...overrides,
	};
}

test("portable task and result DTOs accept the exact v1 fields", () => {
	assert.equal(isSubagentTaskV1(TASK), true);
	assert.deepEqual(assertSubagentTaskV1(TASK), TASK);

	const result: SubagentResultV1 = {
		status: "completed",
		summary: "Runtime contract implemented.",
		evidence: ["focused tests: 2 passed"],
		blockers: [],
	};
	assert.equal(isSubagentResultV1(result), true);
	assert.deepEqual(assertSubagentResultV1(result), result);
});

test("portable DTO validation rejects missing, malformed, and provider-specific fields", () => {
	for (const invalid of [
		{ ...TASK, task: "" },
		{ ...TASK, dependencies: ["design", 3] },
		{ ...TASK, provider: "nicobailon" },
		{ ...TASK, expectedOutcome: 42 },
	]) {
		assert.equal(isSubagentTaskV1(invalid), false, JSON.stringify(invalid));
	}
	for (const invalid of [
		{ status: "completed", summary: "done", evidence: [], blockers: [], runId: "provider-id" },
		{ status: "unknown", summary: "done", evidence: [], blockers: [] },
		{ status: "failed", summary: "failed", evidence: [""], blockers: ["blocked"] },
	]) {
		assert.equal(isSubagentResultV1(invalid), false, JSON.stringify(invalid));
	}
	assert.throws(() => assertSubagentTaskV1({ ...TASK, task: "" }), /task/);
	assert.throws(() => assertSubagentResultV1({ status: "unknown", summary: "done", evidence: [], blockers: [] }), /status/);
});

test("runtime negotiates mandatory capabilities before start and exposes the negotiated snapshot", async () => {
	const calls: string[] = [];
	const runtime = new SubagentRuntimeV1(adapter({
		negotiate: async () => {
			calls.push("negotiate");
			return CAPABILITIES;
		},
		start: async () => {
			calls.push("start");
			return { id: "run-1" };
		},
	}));

	const negotiated = await runtime.negotiate();
	assert.deepEqual(negotiated, CAPABILITIES);
	assert.deepEqual(await runtime.negotiate(), CAPABILITIES);
	assert.deepEqual(await runtime.start(TASK), { id: "run-1" });
	assert.deepEqual(calls, ["negotiate", "start"]);
});

test("runtime fails closed for an incompatible protocol or missing mandatory capability", async () => {
	for (const capabilities of [
		{ ...CAPABILITIES, protocol: 2 },
		{ ...CAPABILITIES, capabilities: ["spawn", "status", "stop"] },
		{ ...CAPABILITIES, provider: "other" },
	] as SubagentRuntimeCapabilitiesV1[]) {
		let starts = 0;
		const runtime = new SubagentRuntimeV1(adapter({
			negotiate: async () => capabilities,
			start: async () => {
				starts += 1;
				return { id: "run" };
			},
		}));
		await assert.rejects(runtime.start(TASK), (error: unknown) => {
			assert.ok(error instanceof SubagentRuntimeError);
			assert.match(error.message, /capabilit|protocol|provider/i);
			return true;
		});
		assert.equal(starts, 0);
	}
});

test("runtime rejects invalid tasks before crossing the adapter boundary", async () => {
	let starts = 0;
	const runtime = new SubagentRuntimeV1(adapter({
		start: async () => {
			starts += 1;
			return { id: "run" };
		},
	}));
	await assert.rejects(runtime.start({ ...TASK, dependencies: ["ok", 3] } as unknown as SubagentTaskV1), /dependencies/);
	assert.equal(starts, 0);
});
