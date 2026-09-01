/**
 * Provider-neutral dependency DAG and work-unit lease coordinator.
 *
 * The scheduler owns only local readiness and serialization. Gentle AI remains
 * the source of truth for runtime attempts, opaque attempt tokens, counters,
 * and resets; callers MUST acquire a native attempt only after this module has
 * proven the work unit ready.
 */

export const WORK_UNIT_MODES = ["read", "verify", "write"] as const;
export type WorkUnitModeV1 = (typeof WORK_UNIT_MODES)[number];

export const WORK_UNIT_STATUSES = ["pending", "leased", "completed", "failed", "cancelled"] as const;
export type WorkUnitStatusV1 = (typeof WORK_UNIT_STATUSES)[number];

export const WORK_UNIT_OUTCOMES = ["passed", "failed", "cancelled", "blocked"] as const;
export type WorkUnitOutcomeV1 = (typeof WORK_UNIT_OUTCOMES)[number];

export type WorkUnitSchedulerErrorCode =
	| "invalid_unit"
	| "duplicate_unit"
	| "unknown_dependency"
	| "duplicate_dependency"
	| "cyclic_dependency"
	| "unknown_unit"
	| "dependency_not_ready"
	| "writer_conflict"
	| "lease_conflict"
	| "lease_missing"
	| "unit_complete"
	| "settlement_conflict"
	| "invalid_settlement"
	| "integration_blocked";

export class WorkUnitSchedulerError extends Error {
	readonly code: WorkUnitSchedulerErrorCode;
	readonly workUnitId?: string;
	constructor(code: WorkUnitSchedulerErrorCode, message: string, workUnitId?: string) {
		super(message);
		this.name = "WorkUnitSchedulerError";
		this.code = code;
		this.workUnitId = workUnitId;
	}
}

/** One atomic unit in the parent-owned dependency graph. */
export interface WorkUnitDefinitionV1 {
	readonly id: string;
	readonly dependencies: readonly string[];
	readonly repository?: string;
	readonly worktree?: string;
	/** `write` is the only mutating mode; read and verify may share a worktree. */
	readonly mode?: WorkUnitModeV1 | "reader" | "writer";
	/** A non-empty write surface implies `write` when mode is omitted. */
	readonly writeSurface?: readonly string[];
	/** Optional informational read surface; it never grants write authority. */
	readonly readSurface?: readonly string[];
}

export interface NormalizedWorkUnitV1 {
	readonly id: string;
	readonly dependencies: readonly string[];
	readonly repository: string;
	readonly worktree: string;
	readonly mode: WorkUnitModeV1;
	readonly writeSurface: readonly string[];
	readonly readSurface: readonly string[];
}

export interface WorkUnitLeaseRequestV1 {
	readonly workUnitId?: string;
	/** Caller-owned idempotency key. It is not a runtime attempt token. */
	readonly idempotencyKey?: string;
	/** Alias accepted for integrations that call this a request key. */
	readonly requestId?: string;
}

export interface WorkUnitLeaseV1 {
	readonly workUnitId: string;
	readonly leaseKey: string;
	readonly repository: string;
	readonly worktree: string;
	readonly mode: WorkUnitModeV1;
	readonly writeSurface: readonly string[];
}

export interface WorkUnitEvidenceV1 {
	readonly focusedChecks: readonly string[];
	readonly runtimeHarness: string;
	readonly finalVerification: "pending" | "passed" | "failed" | "not-applicable";
	readonly rollbackBoundary: string;
}

export interface WorkUnitSettlementInputV1 {
	readonly outcome: WorkUnitOutcomeV1;
	readonly focusedChecks: readonly string[];
	readonly runtimeHarness: string;
	readonly finalVerification: "pending" | "passed" | "failed" | "not-applicable";
	readonly rollbackBoundary: string;
	readonly summary?: string;
	readonly blockers?: readonly string[];
}

export interface WorkUnitSettlementV1 {
	readonly workUnitId: string;
	readonly status: Exclude<WorkUnitStatusV1, "pending" | "leased">;
	readonly outcome: WorkUnitOutcomeV1;
	readonly evidence: WorkUnitEvidenceV1;
	readonly summary: string;
	readonly blockers: readonly string[];
}

export interface WorkUnitReadinessV1 {
	readonly id: string;
	readonly status: WorkUnitStatusV1;
	readonly state: "ready" | "blocked" | "leased" | "completed" | "failed" | "cancelled";
	readonly dependencies: readonly string[];
	readonly incompleteDependencies: readonly string[];
	readonly conflict: boolean;
	/** True means the caller may now invoke provider/native attempt acquire. */
	readonly nativeAcquireReady: boolean;
}

export interface WorkUnitStatusSnapshotV1 {
	readonly unit: NormalizedWorkUnitV1;
	readonly status: WorkUnitStatusV1;
	readonly lease?: WorkUnitLeaseV1;
	readonly settlement?: WorkUnitSettlementV1;
}

interface MutableRecord {
	readonly unit: NormalizedWorkUnitV1;
	status: WorkUnitStatusV1;
	lease?: WorkUnitLeaseV1;
	settlement?: WorkUnitSettlementV1;
}

interface FinalVerificationV1 {
	readonly passed: boolean;
	readonly evidence: readonly string[];
}

const DEFAULT_REPOSITORY = "repository";
const DEFAULT_WORKTREE = "worktree";
const MAX_UNITS = 512;
const MAX_ID_LENGTH = 512;
const MAX_SURFACE_ENTRIES = 1024;

function isNonEmptyText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function assertIdentifier(value: unknown, label: string): string {
	if (!isNonEmptyText(value) || value.length > MAX_ID_LENGTH) {
		throw new WorkUnitSchedulerError("invalid_unit", `${label} must be a bounded non-empty string.`);
	}
	return value.trim();
}

function normalizeSurface(value: readonly string[] | undefined, label: string): readonly string[] {
	if (value === undefined) return Object.freeze([]);
	if (!Array.isArray(value) || value.length > MAX_SURFACE_ENTRIES || value.some((entry) => !isNonEmptyText(entry))) {
		throw new WorkUnitSchedulerError("invalid_unit", `${label} must contain bounded non-empty strings.`);
	}
	const entries = value.map((entry) => entry.trim());
	if (new Set(entries).size !== entries.length) {
		throw new WorkUnitSchedulerError("invalid_unit", `${label} must not contain duplicates.`);
	}
	return Object.freeze([...entries].sort((left, right) => left.localeCompare(right)));
}

function normalizeMode(unit: WorkUnitDefinitionV1): WorkUnitModeV1 {
	if (unit.mode === undefined) return unit.writeSurface !== undefined && unit.writeSurface.length > 0 ? "write" : "read";
	if (unit.mode === "reader") return "read";
	if (unit.mode === "writer") return "write";
	if (!WORK_UNIT_MODES.includes(unit.mode)) {
		throw new WorkUnitSchedulerError("invalid_unit", `Unknown work-unit mode: ${String(unit.mode)}.`, unit.id);
	}
	return unit.mode;
}

function normalizeUnit(unit: WorkUnitDefinitionV1): NormalizedWorkUnitV1 {
	if (typeof unit !== "object" || unit === null) {
		throw new WorkUnitSchedulerError("invalid_unit", "Work unit must be an object.");
	}
	const id = assertIdentifier(unit.id, "Work-unit id");
	if (!Array.isArray(unit.dependencies) || unit.dependencies.some((dependency) => !isNonEmptyText(dependency))) {
		throw new WorkUnitSchedulerError("invalid_unit", `Work-unit ${id} dependencies must contain non-empty strings.`, id);
	}
	const dependencies = unit.dependencies.map((dependency) => dependency.trim()).sort((left, right) => left.localeCompare(right));
	if (new Set(dependencies).size !== dependencies.length) {
		throw new WorkUnitSchedulerError("duplicate_dependency", `Work-unit ${id} declares a duplicate dependency.`, id);
	}
	const repository = unit.repository === undefined ? DEFAULT_REPOSITORY : assertIdentifier(unit.repository, `Work-unit ${id} repository`);
	const worktree = unit.worktree === undefined ? DEFAULT_WORKTREE : assertIdentifier(unit.worktree, `Work-unit ${id} worktree`);
	const mode = normalizeMode(unit);
	const writeSurface = normalizeSurface(unit.writeSurface, `Work-unit ${id} write surface`);
	const readSurface = normalizeSurface(unit.readSurface, `Work-unit ${id} read surface`);
	if (mode === "write" && writeSurface.length === 0) {
		// The surface can be intentionally broad, but make that explicit in the
		// normalized contract so callers do not mistake an omitted list for a
		// read-only unit.
	}
	if (mode !== "write" && writeSurface.length > 0) {
		throw new WorkUnitSchedulerError("invalid_unit", `Non-writer work-unit ${id} cannot declare a write surface.`, id);
	}
	return Object.freeze({
		id,
		dependencies: Object.freeze([...dependencies]),
		repository,
		worktree,
		mode,
		writeSurface,
		readSurface,
	});
}

function assertAcyclic(units: readonly NormalizedWorkUnitV1[]): void {
	const graph = new Map(units.map((unit) => [unit.id, unit.dependencies]));
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) throw new WorkUnitSchedulerError("cyclic_dependency", `Work-unit dependency cycle includes ${id}.`, id);
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of graph.get(id) ?? []) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const unit of [...units].sort((left, right) => left.id.localeCompare(right.id))) visit(unit.id);
}

/** Validate and detach a complete parent-owned work-unit DAG. */
export function validateWorkUnitGraph(units: readonly WorkUnitDefinitionV1[]): readonly NormalizedWorkUnitV1[] {
	if (!Array.isArray(units) || units.length === 0 || units.length > MAX_UNITS) {
		throw new WorkUnitSchedulerError("invalid_unit", `Work-unit graph must contain between 1 and ${MAX_UNITS} units.`);
	}
	const normalized = units.map(normalizeUnit);
	const ids = new Set<string>();
	for (const unit of normalized) {
		if (ids.has(unit.id)) throw new WorkUnitSchedulerError("duplicate_unit", `Work-unit id ${unit.id} is declared more than once.`, unit.id);
		ids.add(unit.id);
	}
	for (const unit of normalized) {
		for (const dependency of unit.dependencies) {
			if (!ids.has(dependency)) throw new WorkUnitSchedulerError("unknown_dependency", `Work-unit ${unit.id} depends on unknown unit ${dependency}.`, unit.id);
		}
	}
	assertAcyclic(normalized);
	return Object.freeze([...normalized].sort((left, right) => left.id.localeCompare(right.id)));
}

function statusOf(records: ReadonlyMap<string, MutableRecord>, id: string): WorkUnitStatusV1 | undefined {
	return records.get(id)?.status;
}

function dependencyReady(records: ReadonlyMap<string, MutableRecord>, unit: NormalizedWorkUnitV1): boolean {
	return unit.dependencies.every((dependency) => statusOf(records, dependency) === "completed");
}

function sameWorktree(left: NormalizedWorkUnitV1, right: NormalizedWorkUnitV1): boolean {
	return left.repository === right.repository && left.worktree === right.worktree;
}

function leaseConflicts(candidate: NormalizedWorkUnitV1, active: NormalizedWorkUnitV1): boolean {
	if (!sameWorktree(candidate, active)) return false;
	// Read/verify work is non-mutating and may proceed together. Any writer
	// claims the entire bound worktree, regardless of path-surface overlap.
	return candidate.mode === "write" || active.mode === "write";
}

function leaseKeyFor(request: WorkUnitLeaseRequestV1 | undefined, workUnitId: string): string {
	const key = request?.idempotencyKey ?? request?.requestId ?? workUnitId;
	if (!isNonEmptyText(key) || key.length > MAX_ID_LENGTH) {
		throw new WorkUnitSchedulerError("invalid_unit", "Lease idempotency key must be a bounded non-empty string.", workUnitId);
	}
	return key.trim();
}

function detachedLease(lease: WorkUnitLeaseV1): WorkUnitLeaseV1 {
	return Object.freeze({ ...lease, writeSurface: Object.freeze([...lease.writeSurface]) });
}

function detachedEvidence(evidence: WorkUnitEvidenceV1): WorkUnitEvidenceV1 {
	return Object.freeze({
		...evidence,
		focusedChecks: Object.freeze([...evidence.focusedChecks]),
	});
}

function normalizeSettlement(input: WorkUnitSettlementInputV1, workUnitId: string): WorkUnitSettlementInputV1 {
	if (!input || typeof input !== "object" || !WORK_UNIT_OUTCOMES.includes(input.outcome)) {
		throw new WorkUnitSchedulerError("invalid_settlement", `Settlement for ${workUnitId} must provide a known outcome.`, workUnitId);
	}
	if (!Array.isArray(input.focusedChecks) || input.focusedChecks.length > MAX_SURFACE_ENTRIES || input.focusedChecks.some((check) => !isNonEmptyText(check))) {
		throw new WorkUnitSchedulerError("invalid_settlement", `Settlement for ${workUnitId} must include focused-check evidence.`, workUnitId);
	}
	if (!isNonEmptyText(input.runtimeHarness) || input.runtimeHarness.length > 4096 || !["pending", "passed", "failed", "not-applicable"].includes(input.finalVerification) || !isNonEmptyText(input.rollbackBoundary) || input.rollbackBoundary.length > 4096 || (input.summary !== undefined && (typeof input.summary !== "string" || input.summary.length > 4096 || /[\u0000-\u001f\u007f]/.test(input.summary))) || (input.blockers !== undefined && (!Array.isArray(input.blockers) || input.blockers.length > MAX_SURFACE_ENTRIES || input.blockers.some((blocker) => !isNonEmptyText(blocker))))) {
		throw new WorkUnitSchedulerError("invalid_settlement", `Settlement for ${workUnitId} must include runtime, final-verification, and rollback evidence.`, workUnitId);
	}
	return {
		outcome: input.outcome,
		focusedChecks: Object.freeze([...input.focusedChecks]),
		runtimeHarness: input.runtimeHarness,
		finalVerification: input.finalVerification,
		rollbackBoundary: input.rollbackBoundary,
		summary: input.summary,
		blockers: input.blockers === undefined ? [] : Object.freeze([...input.blockers]),
	};
}

function settlementStatus(outcome: WorkUnitOutcomeV1): Exclude<WorkUnitStatusV1, "pending" | "leased"> {
	return outcome === "passed" ? "completed" : outcome === "cancelled" ? "cancelled" : outcome === "blocked" ? "failed" : "failed";
}

function settlementMatches(settlement: WorkUnitSettlementV1, input: WorkUnitSettlementInputV1): boolean {
	return settlement.outcome === input.outcome
		&& JSON.stringify(settlement.evidence.focusedChecks) === JSON.stringify(input.focusedChecks)
		&& settlement.evidence.runtimeHarness === input.runtimeHarness
		&& settlement.evidence.finalVerification === input.finalVerification
		&& settlement.evidence.rollbackBoundary === input.rollbackBoundary
		&& settlement.summary === (input.summary ?? "")
		&& JSON.stringify(settlement.blockers) === JSON.stringify(input.blockers ?? []);
}

/**
 * Return all graph-ready units in stable id order. This pure helper is useful
 * before any provider/native attempt acquire and has no lease or attempt state.
 */
export function selectReadyWorkUnits(units: readonly WorkUnitDefinitionV1[], completedDependencies: readonly string[] = []): readonly NormalizedWorkUnitV1[] {
	const graph = validateWorkUnitGraph(units);
	if (!Array.isArray(completedDependencies) || completedDependencies.some((id) => !isNonEmptyText(id))) {
		throw new WorkUnitSchedulerError("unknown_unit", "Completed dependency identities must be bounded non-empty strings.");
	}
	const knownIds = new Set(graph.map(({ id }) => id));
	const complete = new Set(completedDependencies.map((id) => id.trim()));
	if ([...complete].some((id) => !knownIds.has(id))) throw new WorkUnitSchedulerError("unknown_unit", "Completed dependency identities must belong to the work-unit graph.");
	const result: NormalizedWorkUnitV1[] = [];
	// A pure graph has no execution state, so an omitted completion set exposes
	// roots; callers may pass provider-owned completed identities for later DAG
	// layers without introducing local attempt state.
	for (const unit of graph) {
		if (unit.dependencies.every((dependency) => complete.has(dependency))) result.push(unit);
	}
	return Object.freeze([...result].sort((left, right) => left.id.localeCompare(right.id)));
}

/** Parent-owned scheduler for DAG readiness, leases, and integration evidence. */
export class WorkUnitSchedulerV1 {
	private readonly records: Map<string, MutableRecord>;
	private finalVerification?: FinalVerificationV1;

	constructor(units: readonly WorkUnitDefinitionV1[]) {
		const graph = validateWorkUnitGraph(units);
		this.records = new Map(graph.map((unit) => [unit.id, { unit, status: "pending" }]));
	}

	get units(): readonly NormalizedWorkUnitV1[] {
		return Object.freeze([...this.records.values()].map(({ unit }) => unit));
	}

	private requireRecord(id: string): MutableRecord {
		const record = this.records.get(id);
		if (record === undefined) throw new WorkUnitSchedulerError("unknown_unit", `Unknown work-unit ${id}.`, id);
		return record;
	}

	private activeRecords(): readonly MutableRecord[] {
		return [...this.records.values()].filter((record) => record.lease !== undefined && record.status === "leased");
	}

	private hasConflict(unit: NormalizedWorkUnitV1): boolean {
		return this.activeRecords().some((record) => leaseConflicts(unit, record.unit));
	}

	readiness(id: string): WorkUnitReadinessV1 {
		const record = this.requireRecord(id);
		const incompleteDependencies = record.unit.dependencies.filter((dependency) => statusOf(this.records, dependency) !== "completed");
		const conflict = record.status === "pending" && dependencyReady(this.records, record.unit) && this.hasConflict(record.unit);
		const ready = record.status === "pending" && incompleteDependencies.length === 0 && !conflict;
		const state = record.status === "leased" ? "leased" : record.status === "completed" ? "completed" : record.status === "failed" ? "failed" : record.status === "cancelled" ? "cancelled" : ready ? "ready" : "blocked";
		return Object.freeze({
			id,
			status: record.status,
			state,
			dependencies: Object.freeze([...record.unit.dependencies]),
			incompleteDependencies: Object.freeze([...incompleteDependencies]),
			conflict,
			nativeAcquireReady: ready,
		});
	}

	readinessSnapshot(): readonly WorkUnitReadinessV1[] {
		return Object.freeze([...this.records.keys()].sort((left, right) => left.localeCompare(right)).map((id) => this.readiness(id)));
	}

	readyUnits(): readonly NormalizedWorkUnitV1[] {
		return Object.freeze([...this.records.values()]
			.filter((record) => this.readiness(record.unit.id).nativeAcquireReady)
			.map(({ unit }) => unit)
			.sort((left, right) => left.id.localeCompare(right.id)));
	}

	/** Assert the dependency/writer gate before invoking native attempt acquire. */
	assertReadyForNativeAcquire(id: string): void {
		const readiness = this.readiness(id);
		if (readiness.state === "blocked") {
			const reason = readiness.conflict ? "a writer lease conflicts with the bound worktree" : `dependencies incomplete: ${readiness.incompleteDependencies.join(", ") || "unknown"}`;
			throw new WorkUnitSchedulerError(readiness.conflict ? "writer_conflict" : "dependency_not_ready", `Work-unit ${id} is not ready for native attempt acquire: ${reason}.`, id);
		}
		if (!readiness.nativeAcquireReady) throw new WorkUnitSchedulerError("unit_complete", `Work-unit ${id} cannot acquire a new native attempt from state ${readiness.status}.`, id);
	}

	/** Alias for callers that name this gate `assertReady`. */
	assertReady(id: string): void {
		this.assertReadyForNativeAcquire(id);
	}

	acquireLease(idOrRequest: string | WorkUnitLeaseRequestV1, request: WorkUnitLeaseRequestV1 = {}): WorkUnitLeaseV1 {
		const id = typeof idOrRequest === "string" ? idOrRequest : idOrRequest.workUnitId;
		if (!isNonEmptyText(id)) throw new WorkUnitSchedulerError("unknown_unit", "A work-unit id is required.");
		const record = this.requireRecord(id);
		const key = leaseKeyFor(typeof idOrRequest === "string" ? request : idOrRequest, id);
		if (record.lease !== undefined) {
			if (record.lease.leaseKey === key) return detachedLease(record.lease);
			throw new WorkUnitSchedulerError("lease_conflict", `Work-unit ${id} already has a different active lease.`, id);
		}
		this.assertReadyForNativeAcquire(id);
		const conflict = this.activeRecords().find((active) => leaseConflicts(record.unit, active.unit));
		if (conflict !== undefined) throw new WorkUnitSchedulerError("writer_conflict", `Work-unit ${id} conflicts with active work-unit ${conflict.unit.id} in the bound worktree.`, id);
		const lease = detachedLease({
			workUnitId: id,
			leaseKey: key,
			repository: record.unit.repository,
			worktree: record.unit.worktree,
			mode: record.unit.mode,
			writeSurface: record.unit.writeSurface,
		});
		record.lease = lease;
		record.status = "leased";
		return detachedLease(lease);
	}

	/** Alias retained for terse orchestration adapters. */
	lease(idOrRequest: string | WorkUnitLeaseRequestV1, request?: WorkUnitLeaseRequestV1): WorkUnitLeaseV1 {
		return this.acquireLease(idOrRequest, request);
	}

	activeLease(id: string): WorkUnitLeaseV1 | undefined {
		return this.requireRecord(id).lease === undefined ? undefined : detachedLease(this.requireRecord(id).lease!);
	}

	settle(lease: WorkUnitLeaseV1, input: WorkUnitSettlementInputV1): WorkUnitSettlementV1 {
		if (!lease || !isNonEmptyText(lease.workUnitId)) throw new WorkUnitSchedulerError("lease_missing", "Settlement requires a scheduler lease.");
		const record = this.requireRecord(lease.workUnitId);
		const normalized = normalizeSettlement(input, lease.workUnitId);
		if (record.settlement !== undefined) {
			if (settlementMatches(record.settlement, normalized)) return record.settlement;
			throw new WorkUnitSchedulerError("settlement_conflict", `Work-unit ${lease.workUnitId} already has a different settlement.`, lease.workUnitId);
		}
		if (record.lease === undefined || record.lease.leaseKey !== lease.leaseKey) {
			throw new WorkUnitSchedulerError("lease_missing", `Lease for work-unit ${lease.workUnitId} is not active or belongs to another request.`, lease.workUnitId);
		}
		const settlement: WorkUnitSettlementV1 = Object.freeze({
			workUnitId: lease.workUnitId,
			status: settlementStatus(normalized.outcome),
			outcome: normalized.outcome,
			evidence: detachedEvidence({
				focusedChecks: normalized.focusedChecks,
				runtimeHarness: normalized.runtimeHarness,
				finalVerification: normalized.finalVerification,
				rollbackBoundary: normalized.rollbackBoundary,
			}),
			summary: normalized.summary ?? "",
			blockers: Object.freeze([...(normalized.blockers ?? [])]),
		});
		record.settlement = settlement;
		record.status = settlement.status;
		// Releasing the lease is the only local cleanup. Native attempt settlement
		// remains the caller/provider's responsibility and is not mirrored here.
		record.lease = undefined;
		return settlement;
	}

	/** Release a lease as a cancellation without introducing a reset operation. */
	cancel(lease: WorkUnitLeaseV1, input: Omit<WorkUnitSettlementInputV1, "outcome"> = { focusedChecks: ["cancelled before completion"], runtimeHarness: "not-run", finalVerification: "not-applicable", rollbackBoundary: "cancelled work-unit" }): WorkUnitSettlementV1 {
		return this.settle(lease, { ...input, outcome: "cancelled" });
	}

	status(id: string): WorkUnitStatusSnapshotV1 {
		const record = this.requireRecord(id);
		return Object.freeze({
			unit: record.unit,
			status: record.status,
			...(record.lease === undefined ? {} : { lease: detachedLease(record.lease) }),
			...(record.settlement === undefined ? {} : { settlement: record.settlement }),
		});
	}

	statusSnapshot(): readonly WorkUnitStatusSnapshotV1[] {
		return Object.freeze([...this.records.keys()].sort((left, right) => left.localeCompare(right)).map((id) => this.status(id)));
	}

	recordFinalVerification(input: FinalVerificationV1): void {
		if (!input || typeof input !== "object" || typeof input.passed !== "boolean" || !Array.isArray(input.evidence) || input.evidence.some((entry) => !isNonEmptyText(entry))) {
			throw new WorkUnitSchedulerError("invalid_settlement", "Final verification requires a boolean result and evidence.");
		}
		const next = { passed: input.passed, evidence: Object.freeze([...input.evidence]) } as const;
		if (this.finalVerification !== undefined) {
			if (this.finalVerification.passed === next.passed && JSON.stringify(this.finalVerification.evidence) === JSON.stringify(next.evidence)) return;
			throw new WorkUnitSchedulerError("settlement_conflict", "Final verification is already recorded with different evidence.");
		}
		this.finalVerification = Object.freeze(next);
	}

	integrationReady(): boolean {
		if (this.finalVerification?.passed !== true) return false;
		return [...this.records.values()].every((record) => record.status === "completed" && record.settlement !== undefined && record.settlement.evidence.focusedChecks.length > 0 && record.settlement.evidence.finalVerification !== "failed");
	}

	assertIntegrationReady(): void {
		if (!this.integrationReady()) throw new WorkUnitSchedulerError("integration_blocked", "Integration remains blocked until every work unit has passed focused evidence and final verification.");
	}

	finalVerification(): FinalVerificationV1 | undefined {
		return this.finalVerification === undefined ? undefined : Object.freeze({ passed: this.finalVerification.passed, evidence: Object.freeze([...this.finalVerification.evidence]) });
	}
}
