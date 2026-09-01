/**
 * Provider-neutral runtime port for the single supported pi-subagents adapter.
 *
 * The port intentionally owns only portable task/result contracts and lifecycle
 * admission. Provider request/event shapes stay inside the Nicobailon adapter.
 */

export const SUBAGENT_RUNTIME_PROTOCOL_VERSION = 1 as const;
export const SUBAGENT_RUNTIME_PROVIDER = "nicobailon" as const;

export const MANDATORY_SUBAGENT_CAPABILITIES = [
	"spawn",
	"status",
	"stop",
	"events.asyncComplete",
] as const;

export type SubagentRuntimeCapability =
	| (typeof MANDATORY_SUBAGENT_CAPABILITIES)[number]
	| "events";

export interface SubagentRuntimeCapabilitiesV1 {
	readonly protocol: typeof SUBAGENT_RUNTIME_PROTOCOL_VERSION;
	readonly provider: typeof SUBAGENT_RUNTIME_PROVIDER;
	readonly capabilities: readonly SubagentRuntimeCapability[];
}

export interface SubagentTaskV1 {
	readonly task: string;
	readonly context: string;
	readonly dependencies: readonly string[];
	readonly expectedOutcome: string;
}

export const SUBAGENT_RESULT_STATUSES = [
	"completed",
	"failed",
	"cancelled",
	"stopped",
	"blocked",
] as const;

export type SubagentResultStatusV1 = (typeof SUBAGENT_RESULT_STATUSES)[number];

export interface SubagentResultV1 {
	readonly status: SubagentResultStatusV1;
	readonly summary: string;
	readonly evidence: readonly string[];
	readonly blockers: readonly string[];
}

export interface SubagentRuntimeHandleV1 {
	readonly id: string;
}

export const SUBAGENT_RUNTIME_STATUSES = [
	"queued",
	"running",
	...SUBAGENT_RESULT_STATUSES,
] as const;

export type SubagentRuntimeStatusNameV1 = (typeof SUBAGENT_RUNTIME_STATUSES)[number];

export interface SubagentRuntimeStatusV1 {
	readonly id: string;
	readonly status: SubagentRuntimeStatusNameV1;
	readonly result?: SubagentResultV1;
	readonly summary?: string;
	readonly evidence?: readonly string[];
	readonly blockers?: readonly string[];
	readonly updatedAt?: number;
}

/** Controller-owned values passed alongside a portable task. */
export interface SubagentStartOptionsV1 {
	readonly role?: string;
	readonly cwd?: string;
	readonly signal?: AbortSignal;
}

export interface SubagentRuntimeAdapterV1 {
	/** Negotiate a provider's explicit protocol/capability advertisement. */
	negotiate(): Promise<unknown>;
	/** Start one task. Implementations MUST use an async provider launch. */
	start(task: SubagentTaskV1, options?: SubagentStartOptionsV1): Promise<SubagentRuntimeHandleV1>;
	/** Read provider state and normalize it to this port's status shape. */
	status(handle: SubagentRuntimeHandleV1, signal?: AbortSignal): Promise<SubagentRuntimeStatusV1>;
	/** Request provider stop/cancellation for one handle. */
	cancel(handle: SubagentRuntimeHandleV1, reason?: string, signal?: AbortSignal): Promise<void>;
	/** Optional event-backed completion. No provider result RPC is implied. */
	waitForCompletion?(handle: SubagentRuntimeHandleV1, signal?: AbortSignal): Promise<SubagentResultV1>;
	dispose?(): void;
}

export type SubagentRuntimePortV1 = SubagentRuntimeV1;

export type SubagentRuntimeErrorCode =
	| "invalid_task"
	| "invalid_result"
	| "invalid_status"
	| "invalid_handle"
	| "not_negotiated"
	| "incompatible_protocol"
	| "missing_capability"
	| "provider_mismatch"
	| "operation_failed"
	| "result_timeout"
	| "cancelled";

export class SubagentRuntimeError extends Error {
	readonly code: SubagentRuntimeErrorCode;
	operation?: string;

	constructor(code: SubagentRuntimeErrorCode, message: string, operation?: string) {
		super(message);
		this.name = "SubagentRuntimeError";
		this.code = code;
		this.operation = operation;
	}
}

const TASK_KEYS = new Set(["task", "context", "dependencies", "expectedOutcome"]);
const RESULT_KEYS = new Set(["status", "summary", "evidence", "blockers"]);
const STATUS_KEYS = new Set(["id", "status", "result", "summary", "evidence", "blockers", "updatedAt"]);
const CAPABILITY_SET = new Set<string>(MANDATORY_SUBAGENT_CAPABILITIES);
const MAX_TASK_LENGTH = 64 * 1024;
const MAX_CONTEXT_LENGTH = 64 * 1024;
const MAX_OUTCOME_LENGTH = 16 * 1024;
const MAX_DEPENDENCY_LENGTH = 512;
const MAX_LIST_ITEMS = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => keys.has(key));
}

function validText(value: unknown, maxLength: number, allowEmpty = false): value is string {
	return typeof value === "string"
		&& value.length <= maxLength
		&& (allowEmpty || value.trim().length > 0)
		&& !value.includes("\u0000");
}

function validStringList(value: unknown, maxItemLength: number): value is readonly string[] {
	return Array.isArray(value)
		&& value.length <= MAX_LIST_ITEMS
		&& value.every((item) => validText(item, maxItemLength));
}

/** Return true only for the closed, provider-neutral task contract. */
export function isSubagentTaskV1(value: unknown): value is SubagentTaskV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, TASK_KEYS)) return false;
	return validText(value.task, MAX_TASK_LENGTH)
		&& validText(value.context, MAX_CONTEXT_LENGTH, true)
		&& validStringList(value.dependencies, MAX_DEPENDENCY_LENGTH)
		&& validText(value.expectedOutcome, MAX_OUTCOME_LENGTH);
}

/** Validate and return a detached task DTO. */
export function assertSubagentTaskV1(value: unknown): SubagentTaskV1 {
	if (!isSubagentTaskV1(value)) {
		throw new SubagentRuntimeError("invalid_task", "SubagentTaskV1 must contain only task, context, dependencies, and expectedOutcome with valid bounded values.");
	}
	return {
		task: value.task,
		context: value.context,
		dependencies: [...value.dependencies],
		expectedOutcome: value.expectedOutcome,
	};
}

/** Return true only for the closed, portable terminal result contract. */
export function isSubagentResultV1(value: unknown): value is SubagentResultV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, RESULT_KEYS)) return false;
	return SUBAGENT_RESULT_STATUSES.includes(value.status as SubagentResultStatusV1)
		&& validText(value.summary, MAX_CONTEXT_LENGTH, true)
		&& validStringList(value.evidence, MAX_CONTEXT_LENGTH)
		&& validStringList(value.blockers, MAX_CONTEXT_LENGTH);
}

/** Validate and return a detached result DTO. */
export function assertSubagentResultV1(value: unknown): SubagentResultV1 {
	if (!isSubagentResultV1(value)) {
		throw new SubagentRuntimeError("invalid_result", "SubagentResultV1 must contain only status, summary, evidence, and blockers with valid bounded values.");
	}
	return {
		status: value.status,
		summary: value.summary,
		evidence: [...value.evidence],
		blockers: [...value.blockers],
	};
}

function isRuntimeCapabilities(value: unknown): value is SubagentRuntimeCapabilitiesV1 {
	if (!isRecord(value)) return false;
	if (value.protocol !== SUBAGENT_RUNTIME_PROTOCOL_VERSION || value.provider !== SUBAGENT_RUNTIME_PROVIDER) return false;
	if (!Array.isArray(value.capabilities) || value.capabilities.length > 32) return false;
	const capabilities = value.capabilities;
	return capabilities.every((capability) => typeof capability === "string" && CAPABILITY_SET.has(capability))
		&& new Set(capabilities).size === capabilities.length
		&& MANDATORY_SUBAGENT_CAPABILITIES.every((capability) => capabilities.includes(capability));
}

export function assertSubagentRuntimeCapabilitiesV1(value: unknown): SubagentRuntimeCapabilitiesV1 {
	if (!isRuntimeCapabilities(value)) {
		throw new SubagentRuntimeError(
			"incompatible_protocol",
			`Nicobailon subagent runtime must advertise protocol 1, provider nicobailon, and capabilities ${MANDATORY_SUBAGENT_CAPABILITIES.join(", ")}.`,
		);
	}
	return {
		protocol: 1,
		provider: "nicobailon",
		capabilities: [...value.capabilities],
	};
}

export function hasSubagentRuntimeCapability(
	capabilities: SubagentRuntimeCapabilitiesV1,
	capability: SubagentRuntimeCapability,
): boolean {
	return capabilities.capabilities.includes(capability);
}

function assertHandle(value: unknown): SubagentRuntimeHandleV1 {
	if (!isRecord(value) || !validText(value.id, 512) || /[\r\n]/.test(value.id)) {
		throw new SubagentRuntimeError("invalid_handle", "Subagent runtime handle must contain one non-empty id without newlines.");
	}
	return { id: value.id };
}

function assertStatus(value: unknown, expectedId: string): SubagentRuntimeStatusV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, STATUS_KEYS) || value.id !== expectedId) {
		throw new SubagentRuntimeError("invalid_status", "Subagent runtime status is malformed or belongs to a different handle.");
	}
	if (!SUBAGENT_RUNTIME_STATUSES.includes(value.status as SubagentRuntimeStatusNameV1)) {
		throw new SubagentRuntimeError("invalid_status", `Unknown subagent runtime status: ${String(value.status)}.`);
	}
	if (value.result !== undefined && !isSubagentResultV1(value.result)) {
		throw new SubagentRuntimeError("invalid_status", "Subagent runtime status contains an invalid result.");
	}
	if (value.summary !== undefined && !validText(value.summary, MAX_CONTEXT_LENGTH, true)) {
		throw new SubagentRuntimeError("invalid_status", "Subagent runtime status summary is malformed.");
	}
	if (value.evidence !== undefined && !validStringList(value.evidence, MAX_CONTEXT_LENGTH)) {
		throw new SubagentRuntimeError("invalid_status", "Subagent runtime status evidence is malformed.");
	}
	if (value.blockers !== undefined && !validStringList(value.blockers, MAX_CONTEXT_LENGTH)) {
		throw new SubagentRuntimeError("invalid_status", "Subagent runtime status blockers are malformed.");
	}
	if (value.updatedAt !== undefined && (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0)) {
		throw new SubagentRuntimeError("invalid_status", "Subagent runtime status updatedAt is malformed.");
	}
	return {
		id: expectedId,
		status: value.status as SubagentRuntimeStatusNameV1,
		...(value.result !== undefined ? { result: assertSubagentResultV1(value.result) } : {}),
		...(value.summary !== undefined ? { summary: value.summary as string } : {}),
		...(value.evidence !== undefined ? { evidence: [...(value.evidence as readonly string[])] } : {}),
		...(value.blockers !== undefined ? { blockers: [...(value.blockers as readonly string[])] } : {}),
		...(value.updatedAt !== undefined ? { updatedAt: value.updatedAt as number } : {}),
	};
}

function resultFromStatus(status: SubagentRuntimeStatusV1): SubagentResultV1 {
	if (status.result !== undefined) return assertSubagentResultV1(status.result);
	const terminalStatus: SubagentResultStatusV1 = status.status === "completed"
		? "completed"
		: status.status === "blocked"
			? "blocked"
			: status.status === "cancelled"
				? "cancelled"
					: status.status === "stopped"
						? "stopped"
							: "failed";
	return assertSubagentResultV1({
		status: terminalStatus,
		summary: status.summary ?? "",
		evidence: status.evidence ?? [],
		blockers: status.blockers ?? [],
	});
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(new SubagentRuntimeError("cancelled", "Subagent runtime operation was cancelled."));
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = () => {
			finish(() => reject(new SubagentRuntimeError("cancelled", "Subagent runtime operation was cancelled.")));
		};
		timer = setTimeout(() => finish(resolve), ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function waitForCompletionWithin(
	adapter: SubagentRuntimeAdapterV1,
	handle: SubagentRuntimeHandleV1,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<SubagentResultV1> {
	if (signal?.aborted) return Promise.reject(new SubagentRuntimeError("cancelled", "Subagent result operation was cancelled.", "result"));
	const completionSignal = new AbortController();
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const onAbort = () => {
			completionSignal.abort();
			finish(() => reject(new SubagentRuntimeError("cancelled", "Subagent result operation was cancelled.", "result")));
		};
		timer = setTimeout(() => {
			completionSignal.abort();
			finish(() => reject(new SubagentRuntimeError("result_timeout", "Timed out waiting for subagent completion event.", "result")));
		}, timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		let pending: Promise<SubagentResultV1>;
		try {
			pending = adapter.waitForCompletion!(handle, completionSignal.signal);
		} catch (error) {
			finish(() => reject(error));
			return;
		}
		pending.then(
			(result) => finish(() => resolve(result)),
			(error) => finish(() => reject(error)),
		);
	});
}

/** One negotiated, provider-neutral runtime session. */
export class SubagentRuntimeV1 {
	private negotiatedCapabilities: SubagentRuntimeCapabilitiesV1 | undefined;
	private negotiation: Promise<SubagentRuntimeCapabilitiesV1> | undefined;
	private readonly adapter: SubagentRuntimeAdapterV1;
	private readonly options: { pollIntervalMs?: number; resultTimeoutMs?: number };

	constructor(
		adapter: SubagentRuntimeAdapterV1,
		options: { pollIntervalMs?: number; resultTimeoutMs?: number } = {},
	) {
		this.adapter = adapter;
		this.options = options;
	}

	get capabilities(): SubagentRuntimeCapabilitiesV1 | undefined {
		return this.negotiatedCapabilities;
	}

	get isNegotiated(): boolean {
		return this.negotiatedCapabilities !== undefined;
	}

	async negotiate(): Promise<SubagentRuntimeCapabilitiesV1> {
		if (this.negotiatedCapabilities !== undefined) return this.negotiatedCapabilities;
		if (this.negotiation !== undefined) return this.negotiation;
		this.negotiation = (async () => {
			try {
				const capabilities = assertSubagentRuntimeCapabilitiesV1(await this.adapter.negotiate());
				this.negotiatedCapabilities = capabilities;
				return capabilities;
			} catch (error) {
				if (error instanceof SubagentRuntimeError) throw error;
				throw new SubagentRuntimeError("operation_failed", error instanceof Error ? error.message : String(error), "negotiate");
			} finally {
				this.negotiation = undefined;
			}
		})();
		return this.negotiation;
	}

	private async requireCapability(capability: SubagentRuntimeCapability, operation: string): Promise<void> {
		let capabilities: SubagentRuntimeCapabilitiesV1;
		try {
			capabilities = await this.negotiate();
		} catch (error) {
			if (error instanceof SubagentRuntimeError) {
				error.operation ??= operation;
			}
			throw error;
		}
		if (!hasSubagentRuntimeCapability(capabilities, capability)) {
			throw new SubagentRuntimeError("missing_capability", `Subagent runtime does not advertise required capability '${capability}'.`, operation);
		}
	}

	async start(task: SubagentTaskV1, options: SubagentStartOptionsV1 = {}): Promise<SubagentRuntimeHandleV1> {
		const portableTask = assertSubagentTaskV1(task);
		await this.requireCapability("spawn", "start");
		if (options.role !== undefined && (!validText(options.role, 512) || /[\r\n]/.test(options.role))) {
			throw new SubagentRuntimeError("operation_failed", "Subagent start role is malformed.", "start");
		}
		try {
			return assertHandle(await this.adapter.start(portableTask, options));
		} catch (error) {
			if (error instanceof SubagentRuntimeError) throw error;
			throw new SubagentRuntimeError("operation_failed", error instanceof Error ? error.message : String(error), "start");
		}
	}

	async status(handle: SubagentRuntimeHandleV1, signal?: AbortSignal): Promise<SubagentRuntimeStatusV1> {
		const portableHandle = assertHandle(handle);
		await this.requireCapability("status", "status");
		try {
			return assertStatus(await this.adapter.status(portableHandle, signal), portableHandle.id);
		} catch (error) {
			if (error instanceof SubagentRuntimeError) throw error;
			throw new SubagentRuntimeError("operation_failed", error instanceof Error ? error.message : String(error), "status");
		}
	}

	async result(handle: SubagentRuntimeHandleV1, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SubagentResultV1> {
		const portableHandle = assertHandle(handle);
		await this.requireCapability("status", "result");
		await this.requireCapability("events.asyncComplete", "result");
		const timeoutMs = options.timeoutMs ?? this.options.resultTimeoutMs ?? 30_000;
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
			throw new SubagentRuntimeError("result_timeout", "Subagent result timeout must be a positive safe integer.", "result");
		}
		const deadline = Date.now() + timeoutMs;
		let observed = await this.status(portableHandle, options.signal);
		while (observed.status === "queued" || observed.status === "running") {
			if (options.signal?.aborted) throw new SubagentRuntimeError("cancelled", "Subagent result operation was cancelled.", "result");
			if (Date.now() >= deadline) throw new SubagentRuntimeError("result_timeout", `Timed out waiting for subagent '${portableHandle.id}' completion.`, "result");
			if (this.adapter.waitForCompletion !== undefined) {
				try {
					const completed = await waitForCompletionWithin(
						this.adapter,
						portableHandle,
						Math.max(1, deadline - Date.now()),
						options.signal,
					);
					return assertSubagentResultV1(completed);
				} catch (error) {
					if (error instanceof SubagentRuntimeError && error.code === "result_timeout") {
						// A provider event can race status publication. Re-read status once
						// before deciding the bounded result wait has expired.
					} else if (error instanceof SubagentRuntimeError) {
						throw error;
					} else {
						throw new SubagentRuntimeError("operation_failed", error instanceof Error ? error.message : String(error), "result");
					}
				}
			}
			await wait(Math.min(this.options.pollIntervalMs ?? 25, Math.max(1, deadline - Date.now())), options.signal);
			observed = await this.status(portableHandle, options.signal);
		}
		return resultFromStatus(observed);
	}

	async cancel(handle: SubagentRuntimeHandleV1, reason = "cancelled", signal?: AbortSignal): Promise<void> {
		const portableHandle = assertHandle(handle);
		await this.requireCapability("stop", "cancel");
		if (!validText(reason, MAX_CONTEXT_LENGTH, true) || /[\r\n]/.test(reason)) {
			throw new SubagentRuntimeError("operation_failed", "Subagent cancellation reason is malformed.", "cancel");
		}
		try {
			await this.adapter.cancel(portableHandle, reason, signal);
		} catch (error) {
			if (error instanceof SubagentRuntimeError) throw error;
			throw new SubagentRuntimeError("operation_failed", error instanceof Error ? error.message : String(error), "cancel");
		}
	}

	dispose(): void {
		this.adapter.dispose?.();
	}
}

export function createSubagentRuntime(
	adapter: SubagentRuntimeAdapterV1,
	options?: { pollIntervalMs?: number; resultTimeoutMs?: number },
): SubagentRuntimeV1 {
	return new SubagentRuntimeV1(adapter, options);
}

// Compatibility aliases for callers that use the architecture's "core" name.
export type SubagentRuntimeCoreV1 = SubagentRuntimeV1;
export type SubagentRuntimeCapabilities = SubagentRuntimeCapabilitiesV1;
export type SubagentRuntimeHandle = SubagentRuntimeHandleV1;
export type SubagentResult = SubagentResultV1;
export type SubagentTask = SubagentTaskV1;
