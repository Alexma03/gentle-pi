import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	NicobailonAdapterError,
	NICObailonSubagentAdapter,
	NICOBailonRpcRequestEvent,
	NICOBailonRpcReplyEventPrefix,
	NICOBailonRpcReadyEvent,
	NICOBailonAsyncCompleteEvent,
	createNicobailonSubagentAdapter,
	type NicobailonEventBusV1,
	type NicobailonRpcRequestV1,
} from "../lib/nicobailon-subagent-adapter.ts";
import {
	MANDATORY_SUBAGENT_CAPABILITIES,
	type SubagentTaskV1,
} from "../lib/subagent-runtime.ts";

const TASK: SubagentTaskV1 = {
	task: "Implement the runtime boundary.",
	context: "Use the approved architecture.",
	dependencies: ["design"],
	expectedOutcome: "A portable runtime contract with focused tests.",
};

const READY = {
	version: 1,
	methods: ["ping", "spawn", "status", "stop"],
	capabilities: {
		spawn: true,
		asyncSpawn: true,
		status: true,
		stop: true,
	},
	events: {
		ready: NICOBailonRpcReadyEvent,
		request: NICOBailonRpcRequestEvent,
		replyPrefix: NICOBailonRpcReplyEventPrefix,
		asyncComplete: NICOBailonAsyncCompleteEvent,
	},
};

class EventBus implements NicobailonEventBusV1 {
	readonly events = new Map<string, Set<(payload: unknown) => void>>();
	readonly emitted: Array<{ event: string; payload: unknown }> = [];

	on(event: string, handler: (payload: unknown) => void): () => void {
		const handlers = this.events.get(event) ?? new Set();
		handlers.add(handler);
		this.events.set(event, handlers);
		return () => handlers.delete(handler);
	}

	emit(event: string, payload: unknown): void {
		this.emitted.push({ event, payload });
		for (const handler of [...(this.events.get(event) ?? [])]) handler(payload);
	}
}

function reply(bus: EventBus, request: NicobailonRpcRequestV1, data: unknown): void {
	bus.emit(`${NICOBailonRpcReplyEventPrefix}${request.requestId}`, {
		version: 1,
		requestId: request.requestId,
		method: request.method,
		success: true,
		data,
	});
}

function adapterWithResponder(
	respond: (bus: EventBus, request: NicobailonRpcRequestV1) => void,
): { bus: EventBus; adapter: NICObailonSubagentAdapter } {
	const bus = new EventBus();
	bus.on(NICOBailonRpcRequestEvent, (payload) => respond(bus, payload as NicobailonRpcRequestV1));
	return { bus, adapter: createNicobailonSubagentAdapter({ events: bus, requestTimeoutMs: 100 }) };
}

test("RPC lock records the exact protocol, methods, and event channels", () => {
	const lock = JSON.parse(readFileSync(join(process.cwd(), "contracts", "pi-subagents-rpc-v1.lock.json"), "utf8"));
	assert.deepEqual(lock, {
		version: 1,
		provider: "nicobailon",
		package: "pi-subagents",
		protocol: 1,
		requiredCapabilities: [...MANDATORY_SUBAGENT_CAPABILITIES],
		methods: { ping: "ping", spawn: "spawn", status: "status", stop: "stop" },
		events: {
			ready: NICOBailonRpcReadyEvent,
			request: NICOBailonRpcRequestEvent,
			replyPrefix: NICOBailonRpcReplyEventPrefix,
			asyncComplete: NICOBailonAsyncCompleteEvent,
		},
		spawn: { async: true },
		completion: "status-or-events.asyncComplete",
	});
});

test("adapter negotiates from a protocol-1 ping and starts an async task", async () => {
	const { bus, adapter } = adapterWithResponder((events, request) => {
		if (request.method === "ping") reply(events, request, READY);
		if (request.method === "spawn") reply(events, request, { runId: "run-1", state: "queued" });
	});

	const capabilities = await adapter.negotiate();
	assert.deepEqual(capabilities.capabilities, [...MANDATORY_SUBAGENT_CAPABILITIES]);
	const handle = await adapter.start(TASK, { role: "gentle-ai-worker", cwd: "/repo" });
	assert.deepEqual(handle, { id: "run-1" });

	const requests = bus.emitted
		.filter((entry) => entry.event === NICOBailonRpcRequestEvent)
		.map((entry) => entry.payload as NicobailonRpcRequestV1);
	assert.deepEqual(requests.map((request) => request.method), ["ping", "spawn"]);
	assert.equal(requests[1]?.params && (requests[1].params as Record<string, unknown>).async, true);
	assert.equal((requests[1]?.params as Record<string, unknown>).agent, "gentle-ai-worker");
	assert.equal((requests[1]?.params as Record<string, unknown>).cwd, "/repo");
});

test("adapter normalizes status and maps cancellation to the provider stop method", async () => {
	const { bus, adapter } = adapterWithResponder((events, request) => {
		if (request.method === "ping") reply(events, request, READY);
		if (request.method === "status") reply(events, request, { runId: "run-1", state: "running" });
		if (request.method === "stop") reply(events, request, { runId: "run-1", state: "stopping" });
	});
	await adapter.negotiate();
	assert.deepEqual(await adapter.status({ id: "run-1" }), { id: "run-1", status: "running" });
	await adapter.cancel({ id: "run-1" }, "user requested stop");
	const methods = bus.emitted
		.filter((entry) => entry.event === NICOBailonRpcRequestEvent)
		.map((entry) => (entry.payload as NicobailonRpcRequestV1).method);
	assert.deepEqual(methods, ["ping", "status", "stop"]);
});

test("adapter fails closed when ping omits the mandatory async completion event", async () => {
	const { adapter } = adapterWithResponder((events, request) => {
		if (request.method === "ping") reply(events, request, {
			...READY,
			events: { ...READY.events, asyncComplete: "subagent:wrong-event" },
		});
	});
	await assert.rejects(
		adapter.negotiate(),
		(error: unknown) => error instanceof NicobailonAdapterError && error.code === "invalid_ready",
	);
});

test("adapter rejects a conflicting protocol marker even when the envelope version is valid", async () => {
	const { adapter } = adapterWithResponder((events, request) => {
		if (request.method === "ping") reply(events, request, { ...READY, protocol: 2 });
	});
	await assert.rejects(
		adapter.negotiate(),
		(error: unknown) => error instanceof NicobailonAdapterError && error.code === "invalid_ready",
	);
});

test("adapter correlates concurrent replies by request id and ignores a mismatched payload", async () => {
	const bus = new EventBus();
	const ids = ["ping-1", "status-1", "status-2"];
	const adapter = createNicobailonSubagentAdapter({
		events: bus,
		requestTimeoutMs: 100,
		requestId: () => ids.shift() ?? "unexpected",
	});
	bus.on(NICOBailonRpcRequestEvent, (payload) => {
		const request = payload as NicobailonRpcRequestV1;
		if (request.method === "ping") reply(bus, request, READY);
		if (request.method !== "status") return;
		if (request.requestId === "status-1") {
			setTimeout(() => bus.emit(`${NICOBailonRpcReplyEventPrefix}${request.requestId}`, {
				version: 1,
				requestId: "other-request",
				method: "status",
				success: true,
				data: { runId: "run-other", state: "failed" },
			}), 1);
			setTimeout(() => reply(bus, request, { runId: "run-1", state: "running" }), 5);
			return;
		}
		setTimeout(() => reply(bus, request, { runId: "run-2", state: "completed" }), 1);
	});

	await adapter.negotiate();
	const [first, second] = await Promise.all([
		adapter.status({ id: "run-1" }),
		adapter.status({ id: "run-2" }),
	]);
	assert.equal(first.status, "running");
	assert.equal(second.status, "completed");
});

test("adapter maps async completion events without inventing a result RPC", async () => {
	const { bus, adapter } = adapterWithResponder((events, request) => {
		if (request.method === "ping") reply(events, request, READY);
		if (request.method === "spawn") reply(events, request, { runId: "run-1", state: "queued" });
	});
	await adapter.negotiate();
	const handle = await adapter.start(TASK, { role: "gentle-ai-worker" });
	const completion = adapter.waitForCompletion(handle);
	bus.emit(NICOBailonAsyncCompleteEvent, {
		runId: "run-1",
		state: "completed",
		summary: "finished",
		evidence: ["event evidence"],
		blockers: [],
	});
	assert.deepEqual(await completion, {
		status: "completed",
		summary: "finished",
		evidence: ["event evidence"],
		blockers: [],
	});
	const methods = bus.emitted
		.filter((entry) => entry.event === NICOBailonRpcRequestEvent)
		.map((entry) => (entry.payload as NicobailonRpcRequestV1).method);
	assert.deepEqual(methods, ["ping", "spawn"]);
});
