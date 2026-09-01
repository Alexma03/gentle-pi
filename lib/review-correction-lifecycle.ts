// Evidence-first correction lifecycle, protocol v1.5.
//
// An ordinary review permits exactly one bounded correction transaction. Since
// v1.5 the provider collects candidate-bound verification evidence BEFORE it
// offers `targeted_validation`, and the outcome it records decides which of
// three terminal branches follows. Those branches differ in what they consume:
// only `procedural_tooling_failed` ends the lifecycle, only `passed` unlocks
// validation, and `verification_failed` must cost nothing at all.
//
// This module is deliberately pure — no subprocess, no filesystem, no clock.
// The provider owns the evidence directory and the budget ledger; what Pi owns
// is the decision, and a decision made from data can be tested without a live
// binary. The rejected alternative was inlining these branches beside the
// existing validation conditionals, where the single-correction invariant would
// have been enforced by control flow instead of by data.

export const CORRECTION_OUTCOMES = Object.freeze(["passed", "verification_failed", "procedural_tooling_failed"] as const);
export type CorrectionOutcome = (typeof CORRECTION_OUTCOMES)[number];

export class CorrectionOutcomeError extends Error {
	constructor(received: unknown) {
		super(`review correction evidence outcome must be exactly one of ${CORRECTION_OUTCOMES.join(", ")}; received ${JSON.stringify(received)}`);
		this.name = "CorrectionOutcomeError";
	}
}

export class CorrectionEvidenceReplacedError extends Error {
	constructor(detail: string) {
		super(`correction-evidence-replaced: ${detail}`);
		this.name = "CorrectionEvidenceReplacedError";
	}
}

export interface CorrectionStatus {
	readonly lineageId: string;
	readonly targetIdentity: string;
	readonly authorityRevision: string;
	readonly correctionBudget: number;
	readonly changedLinesCharged: number;
}

export interface CorrectionEvidence {
	readonly outcome: string;
	readonly evidenceIdentity: string;
	readonly recordDigest: string;
	readonly candidateTree?: string;
	readonly rawPayloadSha256?: string;
}

export type CorrectionReviewMode = "ordinary" | "judgment-day";

export class CorrectionScopeError extends Error {
	constructor(message: string) {
		super(`correction-scope-invalid: ${message}`);
		this.name = "CorrectionScopeError";
	}
}

/** Frozen finding-to-path scope supplied by the native review authority. */
export interface CorrectionFindingScopeV1 {
	readonly id: string;
	readonly paths: readonly string[];
}

export interface CorrectionScopeRequestV1 {
	readonly mode: CorrectionReviewMode;
	readonly confirmedFindings: readonly CorrectionFindingScopeV1[];
	/** The one correction must account for every confirmed finding. */
	readonly findingIds: readonly string[];
	/** Git-derived paths touched by this correction; no unrelated path is valid. */
	readonly paths: readonly string[];
	readonly forecast: CorrectionForecastV1;
}

export interface CorrectionForecastV1 {
	readonly positive: true;
	readonly findingIds: readonly string[];
	readonly paths: readonly string[];
	readonly effects: readonly string[];
}

export interface BoundedCorrectionPlanV1 {
	readonly mode: CorrectionReviewMode;
	readonly findingIds: readonly string[];
	readonly paths: readonly string[];
	readonly correctionBatches: 1 | 2;
	readonly validatorRuns: 0 | 1;
	readonly judgmentRounds: 0 | 2;
	readonly reviewerRuns: 0;
	readonly refuterRuns: 0;
	readonly finalVerificationRuns: 1;
	readonly rerunLenses: false;
	readonly rerunRefutation: false;
	readonly forecast: CorrectionForecastV1;
	/** Scope is path/finding bounded; no changed-line quota is applied here. */
	readonly changedLineBudget: "none";
}

const MAX_CORRECTION_SCOPE_ENTRIES = 1024;

function safeCorrectionPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false;
	if (value.startsWith("/") || /^[A-Za-z]:\//.test(value)) return false;
	return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function scopeList(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CORRECTION_SCOPE_ENTRIES || value.some((entry) => !safeCorrectionPath(entry))) {
		throw new CorrectionScopeError(`${label} must contain bounded, canonical repository-relative paths`);
	}
	const sorted = [...value].sort((left, right) => left.localeCompare(right));
	if (new Set(sorted).size !== sorted.length) throw new CorrectionScopeError(`${label} must not contain duplicate paths`);
	return Object.freeze(sorted);
}

function scopeIds(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CORRECTION_SCOPE_ENTRIES || value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.trim() !== entry || /[\u0000-\u001f\u007f]/.test(entry))) {
		throw new CorrectionScopeError("findingIds must contain bounded, canonical identifiers");
	}
	const sorted = [...value].sort((left, right) => left.localeCompare(right));
	if (new Set(sorted).size !== sorted.length) throw new CorrectionScopeError("findingIds must not contain duplicates");
	return Object.freeze(sorted);
}

/**
 * Resolve one immutable, finding/path-bounded correction plan. This planner
 * owns no attempt token, line counter, lens discovery, refuter dispatch, or
 * rerun; ordinary and Judgment Day actor semantics remain provider-owned.
 */
export function resolveBoundedCorrectionPlan(request: CorrectionScopeRequestV1): BoundedCorrectionPlanV1 {
	if (!request || typeof request !== "object" || (request.mode !== "ordinary" && request.mode !== "judgment-day")) {
		throw new CorrectionScopeError("mode must be ordinary or judgment-day");
	}
	if (!Array.isArray(request.confirmedFindings) || request.confirmedFindings.length === 0 || request.confirmedFindings.length > MAX_CORRECTION_SCOPE_ENTRIES) {
		throw new CorrectionScopeError("confirmedFindings must contain at least one frozen finding");
	}
	const findings = request.confirmedFindings.map((finding) => {
		if (!finding || typeof finding !== "object" || typeof finding.id !== "string" || finding.id.length === 0 || finding.id.trim() !== finding.id) {
			throw new CorrectionScopeError("each confirmed finding needs one canonical identifier");
		}
		return { id: finding.id, paths: scopeList(finding.paths, `finding ${finding.id} paths`) };
	});
	const findingIds = scopeIds(request.findingIds);
	const knownIds = findings.map(({ id }) => id).sort((left, right) => left.localeCompare(right));
	if (new Set(knownIds).size !== knownIds.length) throw new CorrectionScopeError("confirmedFindings must not contain duplicate identifiers");
	if (JSON.stringify(findingIds) !== JSON.stringify(knownIds)) throw new CorrectionScopeError("the correction must address exactly every confirmed finding");
	const paths = scopeList(request.paths, "correction paths");
	const relevantPaths = new Set(findings.flatMap(({ paths: findingPaths }) => findingPaths));
	if (paths.some((path) => !relevantPaths.has(path))) throw new CorrectionScopeError("correction paths must belong to a confirmed finding scope");
	const forecast = request.forecast;
	if (!forecast || typeof forecast !== "object" || forecast.positive !== true) throw new CorrectionScopeError("correction requires a positive pre-edit forecast");
	const forecastFindingIds = scopeIds(forecast.findingIds);
	const forecastPaths = scopeList(forecast.paths, "forecast paths");
	if (JSON.stringify(forecastFindingIds) !== JSON.stringify(findingIds) || JSON.stringify(forecastPaths) !== JSON.stringify(paths)) {
		throw new CorrectionScopeError("forecast must preserve the exact finding and path scope");
	}
	if (!Array.isArray(forecast.effects) || forecast.effects.length === 0 || forecast.effects.length > MAX_CORRECTION_SCOPE_ENTRIES || forecast.effects.some((effect) => typeof effect !== "string" || effect.length === 0 || effect.length > 4096 || /[\u0000-\u001f\u007f]/.test(effect))) {
		throw new CorrectionScopeError("forecast effects must be bounded non-empty text");
	}
	const judgmentDay = request.mode === "judgment-day";
	return Object.freeze({
		mode: request.mode,
		findingIds,
		paths,
		correctionBatches: judgmentDay ? 2 : 1,
		validatorRuns: judgmentDay ? 0 : 1,
		judgmentRounds: judgmentDay ? 2 : 0,
		reviewerRuns: 0,
		refuterRuns: 0,
		finalVerificationRuns: 1,
		rerunLenses: false,
		rerunRefutation: false,
		forecast: Object.freeze({
			positive: true,
			findingIds: forecastFindingIds,
			paths: forecastPaths,
			effects: Object.freeze([...forecast.effects]),
		}),
		changedLineBudget: "none",
	});
}

/** Semantic aliases for callers that use scope rather than plan vocabulary. */
export const resolveCorrectionScope = resolveBoundedCorrectionPlan;
export const createBoundedCorrectionPlan = resolveBoundedCorrectionPlan;

interface CorrectionStepBase {
	readonly kind: string;
	readonly lineageId: string;
	readonly transactionOpen: boolean;
	readonly unlocksTargetedValidation: boolean;
}

export interface RunTargetedValidationStep extends CorrectionStepBase {
	readonly kind: "run-targeted-validation";
	readonly transactionOpen: false;
	readonly unlocksTargetedValidation: true;
	// The provider issues the request. Pi re-queries STATUS for it instead of
	// fabricating one, so the step names the operation it expects to collect.
	readonly expectCaptureOperation: "external.run_targeted_validation";
	readonly evidenceIdentity: string;
}

export interface RecaptureRequiredStep extends CorrectionStepBase {
	readonly kind: "recapture-required";
	readonly transactionOpen: true;
	readonly unlocksTargetedValidation: false;
	readonly attemptConsumed: false;
	readonly budgetConsumed: 0;
	readonly changedLinesCharged: number;
	readonly autoRetry: false;
	// Carries the identity this capture supersedes. A new capture is mandatory:
	// there is deliberately no field that would let a caller resubmit the same
	// candidate bytes under the prior identity.
	readonly supersedes: string;
	readonly requiresNewCapture: true;
	readonly guidance: string;
}

export interface TerminalEscalationStep extends CorrectionStepBase {
	readonly kind: "terminal-escalation";
	readonly transactionOpen: false;
	readonly unlocksTargetedValidation: false;
	readonly retryEligible: false;
	readonly launchesReviewer: false;
	readonly launchesValidator: false;
	readonly launchesCorrection: false;
	readonly escalation: string;
	readonly evidenceIdentity: string;
}

export type CorrectionStep = RunTargetedValidationStep | RecaptureRequiredStep | TerminalEscalationStep;

function requireOutcome(value: unknown): CorrectionOutcome {
	if (typeof value !== "string" || !(CORRECTION_OUTCOMES as readonly string[]).includes(value)) throw new CorrectionOutcomeError(value);
	return value as CorrectionOutcome;
}

export function resolveCorrectionStep(status: CorrectionStatus, evidence: CorrectionEvidence): CorrectionStep {
	const outcome = requireOutcome(evidence?.outcome);

	if (outcome === "passed") {
		return Object.freeze({
			kind: "run-targeted-validation",
			lineageId: status.lineageId,
			transactionOpen: false,
			unlocksTargetedValidation: true,
			expectCaptureOperation: "external.run_targeted_validation",
			evidenceIdentity: evidence.evidenceIdentity,
		} as const);
	}

	if (outcome === "verification_failed") {
		return Object.freeze({
			kind: "recapture-required",
			lineageId: status.lineageId,
			transactionOpen: true,
			unlocksTargetedValidation: false,
			attemptConsumed: false,
			budgetConsumed: 0,
			// Reported, never recomputed: a failed verification must not move the
			// accounting the provider already holds in either direction.
			changedLinesCharged: status.changedLinesCharged,
			autoRetry: false,
			supersedes: evidence.evidenceIdentity,
			requiresNewCapture: true,
			guidance: "Verification failed. Change the candidate and capture new evidence; the correction transaction stays open and nothing has been charged. Do not retry the same bytes.",
		} as const);
	}

	return Object.freeze({
		kind: "terminal-escalation",
		lineageId: status.lineageId,
		transactionOpen: false,
		unlocksTargetedValidation: false,
		retryEligible: false,
		launchesReviewer: false,
		launchesValidator: false,
		launchesCorrection: false,
		escalation: "Procedural tooling failed while capturing verification evidence. This is a terminal escalation: no reviewer, correction, or validator runs afterwards, and retry eligibility is not considered. It needs one human decision.",
		evidenceIdentity: evidence.evidenceIdentity,
	} as const);
}

export interface DistinctEvidenceCheck {
	readonly prior: CorrectionEvidence;
	readonly next: CorrectionEvidence;
	// Whether the earlier record is still resolvable, and what its bytes hash to
	// NOW. Both are observations the caller supplies; this function judges them
	// rather than performing IO, which keeps the invariant unit-testable.
	readonly priorStillResolvable: boolean;
	readonly priorRecordDigestNow: string;
}

export function assertDistinctCorrectionEvidence(check: DistinctEvidenceCheck): void {
	const { prior, next, priorStillResolvable, priorRecordDigestNow } = check;

	if (next.evidenceIdentity === prior.evidenceIdentity) {
		throw new CorrectionEvidenceReplacedError(`the provider reused evidence identity ${prior.evidenceIdentity} for a second capture; each capture must land in its own immutable directory`);
	}
	if (!priorStillResolvable) {
		throw new CorrectionEvidenceReplacedError(`the earlier evidence record ${prior.evidenceIdentity} is no longer resolvable; a failed capture must survive alongside its successor, not be replaced`);
	}
	if (priorRecordDigestNow !== prior.recordDigest) {
		throw new CorrectionEvidenceReplacedError(`the earlier evidence record ${prior.evidenceIdentity} now digests to ${priorRecordDigestNow} instead of ${prior.recordDigest}; its bytes must be immutable`);
	}
}
