/**
 * The sole provider adapter for the provider-neutral subagent runtime.
 *
 * Nicobailon's package exposes a small event-bus RPC. This module is the only
 * place that knows its event names, request envelopes, and provider result
 * fields. No provider tool names or filesystem/package probes cross the port.
 */

import { randomUUID } from "node:crypto";
import {
	assertSubagentResultV1,
	assertSubagentTaskV1,
	MANDATORY_SUBAGENT_CAPABILITIES,
	type SubagentResultV1,
	type SubagentRuntimeAdapterV1,
	type SubagentRuntimeCapabilitiesV1,
	type SubagentRuntimeHandleV1,
	type SubagentRuntimeStatusV1,
	type SubagentTaskV1,
	SubagentRuntimeError,
} from "./subagent-runtime.ts";

export const NICOBailonRpcProtocolVersion = 1 as const;
export const NICOBailonRpcRequestEvent = "subagents:rpc:v1:request";
export const NICOBailonRpcReadyEvent = "subagents:rpc:v1:ready";
export const NICOBailonRpcReplyEventPrefix = "subagents:rpc:v1:reply:";
export const NICOBailonAsyncCompleteEvent = "subagent:async-complete";

// Upper-case aliases make the lock constants convenient for callers while the
// camel-case names mirror the provider's documentation.
export const NICOBAILON_RPC_PROTOCOL_VERSION = NICOBailonRpcProtocolVersion;
export const NICOBAILON_RPC_REQUEST_EVENT = NICOBailonRpcRequestEvent;
export const NICOBAILON_RPC_READY_EVENT = NICOBailonRpcReadyEvent;
export const NICOBAILON_RPC_REPLY_EVENT_PREFIX = NICOBailonRpcReplyEventPrefix;
export const NICOBAILON_ASYNC_COMPLETE_EVENT = NICOBailonAsyncCompleteEvent;

export type NicobailonRpcMethodV1 = "ping" | "spawn" | "status" | "stop";

export interface NicobailonRpcRequestV1 {
	readonly version: typeof NICOBailonRpcProtocolVersion;
	readonly requestId: string;
	readonly method: NicobailonRpcMethodV1;
	readonly params?: unknown;
}

export interface NicobailonRpcReplyV1 {
	readonly version: typeof NICOBailonRpcProtocolVersion;
	readonly requestId: string;
	readonly method?: NicobailonRpcMethodV1;
	readonly success: boolean;
	readonly data?: unknown;
	readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

export interface NicobailonEventBusV1 {
	on(event: string, handler: (payload: unknown) => void): (() => void) | void;
	emit(event: string, payload: unknown): void;
}

export interface CreateNicobailonSubagentAdapterOptions {
	readonly events: NicobailonEventBusV1;
	readonly requestTimeoutMs?: number;
	readonly now?: () => number;
	readonly requestId?: () => string;
}

export type NicobailonAdapterErrorCode =
	| "invalid_ready"
	| "invalid_reply"
	| "rpc_error"
	| "rpc_timeout"
	| "cancelled"
	| "missing_handle"
	| "invalid_provider_status";

export class NicobailonAdapterError extends Error {
	readonly code: NicobailonAdapterErrorCode;
	readonly requestId?: string;

	constructor(code: NicobailonAdapterErrorCode, message: string, requestId?: string) {
		super(message);
		this.name = "NicobailonAdapterError";
		this.code = code;
		this.requestId = requestId;
	}
}

const RPC_METHODS = ["ping", "spawn", "status", "stop"] as const;
const PROVIDER_STATUS_KEYS = new Set(["id", "runId", "asyncId", "state", "status", "result", "summary", "evidence", "blockers", "text", "details", "error", "success", "results"]);
const TERMINAL_STATUS = new Set<SubagentRuntimeStatusV1["status"]>(["completed", "failed", "cancelled", "stopped", "blocked"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\r\n\u0000]/.test(value);
}

function assertTimeout(value: number | undefined): number {
	const timeout = value ?? 30_000;
	if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new NicobailonAdapterError("rpc_timeout", "Nicobailon RPC timeout must be a positive safe integer.");
	return timeout;
}

function normalizeProviderStatus(value: unknown): SubagentRuntimeStatusV1["status"] {
	if (value === "queued" || value === "pending") return "queued";
	if (value === "running" || value === "active" || value === "started" || value === "stopping") return "running";
	if (value === "completed" || value === "complete" || value === "success" || value === "succeeded" || value === "done") return "completed";
	if (value === "failed" || value === "error" || value === "timed_out" || value === "timeout") return "failed";
	if (value === "cancelled" || value === "canceled") return "cancelled";
	if (value === "stopped" || value === "terminated") return "stopped";
	if (value === "blocked" || value === "rejected") return "blocked";
	throw new NicobailonAdapterError("invalid_provider_status", `Unknown Nicobailon subagent status: ${String(value)}.`);
}

function providerId(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	for (const key of ["runId", "id", "asyncId", "requestId"]) {
		if (validId(value[key])) return value[key];
	}
	for (const key of ["details", "result", "data"]) {
		const nested = providerId(value[key]);
		if (nested) return nested;
	}
	if (Array.isArray(value.results) && value.results.length === 1) return providerId(value.results[0]);
	return undefined;
}

function providerText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return undefined;
	for (const key of ["summary", "message", "text", "error"]) {
		if (typeof value[key] === "string") return value[key] as string;
	}
	for (const key of ["details", "result", "data"]) {
		const nested = providerText(value[key]);
		if (nested) return nested;
	}
	return undefined;
}

function strings(value: unknown): readonly string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 256);
}

function findProviderRecord(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value)) return undefined;
	if (Object.keys(value).some((key) => PROVIDER_STATUS_KEYS.has(key))) return value;
	for (const key of ["details", "result", "data"]) {
		const nested = findProviderRecord(value[key]);
		if (nested) return nested;
	}
	return undefined;
}

function resultFromProvider(value: unknown, fallbackStatus?: unknown): SubagentResultV1 {
	const record = findProviderRecord(value) ?? {};
	let status: SubagentResultV1["status"];
	try {
		const candidate = record.status ?? record.state ?? fallbackStatus ?? "failed";
		const normalized = normalizeProviderStatus(candidate);
		status = TERMINAL_STATUS.has(normalized) ? normalized : "failed";
	} catch {
		status = "failed";
	}
	const summary = providerText(record) ?? "";
	const evidence = strings(record.evidence);
	const blockers = strings(record.blockers);
	return assertSubagentResultV1({ status, summary, evidence, blockers });
}

function normalizeCapabilities(value: unknown): SubagentRuntimeCapabilitiesV1 {
	const record = isRecord(value) && isRecord(value.data) ? value.data : value;
	if (!isRecord(record)) throw new NicobailonAdapterError("invalid_ready", "Nicobailon ping did not return an object.");
	if (record.version !== 1 || (record.protocol !== undefined && record.protocol !== 1)) {
		throw new NicobailonAdapterError("invalid_ready", "Nicobailon runtime must advertise protocol 1.");
	}
	const methods = Array.isArray(record.methods) ? record.methods.filter((method): method is string => typeof method === "string") : [];
	const rawCapabilities = record.capabilities;
	const capabilityNames = Array.isArray(rawCapabilities)
		? rawCapabilities.filter((capability): capability is string => typeof capability === "string")
		: [];
	const capabilityObject = isRecord(rawCapabilities) ? rawCapabilities : {};
	const hasCapability = (name: string): boolean => capabilityNames.includes(name) || capabilityObject[name] === true;
	const events = isRecord(record.events) ? record.events : {};
	const requiredMethods = ["spawn", "status", "stop"];
	if (!requiredMethods.every((method) => methods.includes(method) || hasCapability(method))) {
		throw new NicobailonAdapterError("invalid_ready", "Nicobailon ping is missing a required lifecycle method.");
	}
	if (!(hasCapability("spawn") || hasCapability("asyncSpawn"))) throw new NicobailonAdapterError("invalid_ready", "Nicobailon runtime must advertise async spawn capability.");
	if (!hasCapability("status")) throw new NicobailonAdapterError("invalid_ready", "Nicobailon runtime must advertise status capability.");
	if (!hasCapability("stop")) throw new NicobailonAdapterError("invalid_ready", "Nicobailon runtime must advertise stop capability.");
	if (events.asyncComplete !== NICOBailonAsyncCompleteEvent) throw new NicobailonAdapterError("invalid_ready", "Nicobailon runtime must advertise events.asyncComplete.");
	return {
		protocol: 1,
		provider: "nicobailon",
		capabilities: [...MANDATORY_SUBAGENT_CAPABILITIES],
	};
}

function parseJsonText(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function completionId(value: unknown): string | undefined {
	return providerId(value);
}

/** Nicobailon event-bus RPC adapter implementing the runtime port adapter contract. */
export class NICObailonSubagentAdapter implements SubagentRuntimeAdapterV1 {
	private readonly options: CreateNicobailonSubagentAdapterOptions;
	private capabilities: SubagentRuntimeCapabilitiesV1 | undefined;
	private negotiation: Promise<SubagentRuntimeCapabilitiesV1> | undefined;
	private readonly readyPayloads: unknown[] = [];
	private readonly completions = new Map<string, SubagentResultV1>();
	private readonly waiters = new Map<string, Set<{ resolve: (result: SubagentResultV1) => void; reject: (error: unknown) => void }>>();
	private readonly unsubscribers: Array<() => void> = [];
	private readonly requestTimeoutMs: number;
	private readonly requestId: () => string;
	private disposed = false;

	constructor(options: CreateNicobailonSubagentAdapterOptions) {
		this.options = options;
		this.requestTimeoutMs = assertTimeout(options.requestTimeoutMs);
		this.requestId = options.requestId ?? randomUUID;
		this.listen(NICOBailonRpcReadyEvent, (payload) => this.readyPayloads.push(payload));
		this.listen(NICOBailonAsyncCompleteEvent, (payload) => this.handleCompletion(payload));
	}

	private listen(event: string, handler: (payload: unknown) => void): void {
		const unsubscribe = this.options.events.on(event, handler);
		if (typeof unsubscribe === "function") this.unsubscribers.push(unsubscribe);
	}

	private async request(method: NicobailonRpcMethodV1, params?: unknown, signal?: AbortSignal): Promise<unknown> {
		if (this.disposed) throw new NicobailonAdapterError("rpc_error", "Nicobailon subagent adapter is disposed.");
		const requestId = this.requestId();
		if (!validId(requestId)) throw new NicobailonAdapterError("invalid_reply", "Nicobailon RPC request id is malformed.");
		const request: NicobailonRpcRequestV1 = { version: 1, requestId, method, ...(params === undefined ? {} : { params }) };
		return new Promise((resolve, reject) => {
			let settled = false;
			let unsubscribe: (() => void) | void;
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				if (typeof unsubscribe === "function") unsubscribe();
				unsubscribe = undefined;
			};
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new NicobailonAdapterError("rpc_timeout", `Nicobailon RPC ${method} timed out for request ${requestId}.`, requestId));
			}, this.requestTimeoutMs);
			const abort = () => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new NicobailonAdapterError("cancelled", `Nicobailon RPC ${method} was cancelled.`, requestId));
			};
			unsubscribe = this.options.events.on(`${NICOBailonRpcReplyEventPrefix}${requestId}`, (payload) => {
				if (settled) return;
				if (!isRecord(payload) || payload.requestId !== requestId) return;
				if (payload.version !== 1 || (payload.method !== undefined && payload.method !== method)) {
					settled = true;
					cleanup();
					reject(new NicobailonAdapterError("invalid_reply", `Nicobailon RPC ${method} reply has an incompatible version or method.`, requestId));
					return;
				}
				settled = true;
				cleanup();
				if (payload.success !== true) {
					const error = isRecord(payload.error) && typeof payload.error.message === "string" ? payload.error.message : "Nicobailon RPC request failed.";
					reject(new NicobailonAdapterError("rpc_error", error, requestId));
					return;
				}
				if (!Object.hasOwn(payload, "data")) {
					reject(new NicobailonAdapterError("invalid_reply", `Nicobailon RPC ${method} reply omitted data.`, requestId));
					return;
				}
				resolve(payload.data);
			});
			signal?.addEventListener("abort", abort, { once: true });
			try {
				this.options.events.emit(NICOBailonRpcRequestEvent, request);
			} catch (error) {
				if (settled) return;
				settled = true;
				cleanup();
				reject(new NicobailonAdapterError("rpc_error", error instanceof Error ? error.message : String(error), requestId));
			}
		});
	}

	private handleCompletion(payload: unknown): void {
		const id = completionId(payload);
		if (!id) return;
		const result = resultFromProvider(parseJsonText(payload));
		this.completions.set(id, result);
		const waiters = this.waiters.get(id);
		if (!waiters) return;
		this.waiters.delete(id);
		for (const waiter of waiters) waiter.resolve(result);
	}

	async negotiate(): Promise<SubagentRuntimeCapabilitiesV1> {
		if (this.capabilities !== undefined) return this.capabilities;
		if (this.negotiation !== undefined) return this.negotiation;
		this.negotiation = (async () => {
			try {
				const ready = this.readyPayloads.shift();
				const raw = ready ?? await this.request("ping");
				this.capabilities = normalizeCapabilities(raw);
				return this.capabilities;
			} catch (error) {
				if (error instanceof NicobailonAdapterError) throw error;
				throw new NicobailonAdapterError("invalid_ready", error instanceof Error ? error.message : String(error));
			} finally {
				this.negotiation = undefined;
			}
		})();
		return this.negotiation;
	}

	async start(task: SubagentTaskV1, options: { readonly role?: string; readonly cwd?: string; readonly signal?: AbortSignal } = {}): Promise<SubagentRuntimeHandleV1> {
		assertSubagentTaskV1(task);
		await this.negotiate();
		if (!validId(options.role)) throw new NicobailonAdapterError("rpc_error", "Nicobailon spawn requires a controller-owned role.");
		if (options.cwd !== undefined && !validId(options.cwd)) throw new NicobailonAdapterError("rpc_error", "Nicobailon spawn cwd is malformed.");
		const params = {
			agent: options.role,
			task: task.task,
			async: true,
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		};
		const data = await this.request("spawn", params, options.signal);
		const id = providerId(data);
		if (!id) throw new NicobailonAdapterError("missing_handle", "Nicobailon spawn reply did not contain a run id.");
		return { id };
	}

	async status(handle: SubagentRuntimeHandleV1, signal?: AbortSignal): Promise<SubagentRuntimeStatusV1> {
		await this.negotiate();
		if (!validId(handle?.id)) throw new NicobailonAdapterError("missing_handle", "Nicobailon status requires a valid handle id.");
		const data = parseJsonText(await this.request("status", { id: handle.id }, signal));
		const record = findProviderRecord(data);
		if (!record) throw new NicobailonAdapterError("invalid_provider_status", "Nicobailon status reply did not contain a status object.");
		const status = normalizeProviderStatus(record.status ?? record.state);
		const result = record.result !== undefined ? resultFromProvider(record.result, status) : TERMINAL_STATUS.has(status) ? resultFromProvider(record, status) : undefined;
		return {
			id: handle.id,
			status,
			...(result === undefined ? {} : { result }),
			...(typeof record.summary === "string" ? { summary: record.summary } : {}),
			...(Array.isArray(record.evidence) ? { evidence: strings(record.evidence) } : {}),
			...(Array.isArray(record.blockers) ? { blockers: strings(record.blockers) } : {}),
			...(typeof record.updatedAt === "number" ? { updatedAt: record.updatedAt } : {}),
		};
	}

	async waitForCompletion(handle: SubagentRuntimeHandleV1, signal?: AbortSignal): Promise<SubagentResultV1> {
		if (!validId(handle?.id)) throw new NicobailonAdapterError("missing_handle", "Nicobailon completion requires a valid handle id.");
		const cached = this.completions.get(handle.id);
		if (cached !== undefined) return assertSubagentResultV1(cached);
		return new Promise((resolve, reject) => {
			const waiters = this.waiters.get(handle.id) ?? new Set();
			const waiter = { resolve, reject };
			waiters.add(waiter);
			this.waiters.set(handle.id, waiters);
			const onAbort = () => {
				waiters.delete(waiter);
				if (waiters.size === 0) this.waiters.delete(handle.id);
				reject(new NicobailonAdapterError("cancelled", `Nicobailon completion for ${handle.id} was cancelled.`));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	async cancel(handle: SubagentRuntimeHandleV1, reason = "cancelled", signal?: AbortSignal): Promise<void> {
		await this.negotiate();
		if (!validId(handle?.id)) throw new NicobailonAdapterError("missing_handle", "Nicobailon stop requires a valid handle id.");
		if (!validId(reason) || /[\r\n]/.test(reason)) throw new NicobailonAdapterError("rpc_error", "Nicobailon stop reason is malformed.");
		await this.request("stop", { id: handle.id, reason }, signal);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
		for (const waiters of this.waiters.values()) {
			for (const waiter of waiters) waiter.reject(new NicobailonAdapterError("cancelled", "Nicobailon adapter was disposed."));
		}
		this.waiters.clear();
	}
}

export type NicobailonSubagentAdapterV1 = NICObailonSubagentAdapter;
export const NicobailonSubagentAdapter = NICObailonSubagentAdapter;

export function createNicobailonSubagentAdapter(options: CreateNicobailonSubagentAdapterOptions): NICObailonSubagentAdapter {
	return new NICObailonSubagentAdapter(options);
}
