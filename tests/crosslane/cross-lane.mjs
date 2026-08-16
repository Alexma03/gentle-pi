// Cross-lane battery for the Pi direct lane. LOCAL, out of CI on purpose:
// it requires the dev-binary override and drives a real gentle-ai binary
// through live scratch-repository lifecycles.
//
//   pnpm test:cross-lane            # requires the dev-binary override
//   pnpm test:cross-lane --with-model   # adds the real pi reviewer run
//
// The battery exists because the pinned decoder lane never sees new envelope
// schemas and the controller sequencing was never driven through a full
// lifecycle before merge. Three check groups:
//   1. Full direct-lane lifecycles against the override binary through
//      runtime/*.mjs (low to gate allow; medium consent/v3 granted).
//   2. Controller sequencing: at every step the client's decoded offered
//      next step must equal the native transition, and correction evidence
//      must be collected before targeted validation is ever offered
//      (the validate-before-evidence class, pending fix/validate-before-evidence).
//   3. Forward-decoder freshness: every live envelope captured from the
//      override binary must decode without unknown-key rejection - the
//      early warning that gentle-ai main grew a field gentle-pi lacks.
//
// Excluded from `pnpm test` by construction: the default suite globs
// tests/*.test.ts only.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	GENTLE_AI_DEV_BINARY_ENV,
	resolveGentleAiDevBinaryOverride,
} from "../../runtime/gentle-ai-binary.mjs";
import {
	createNativeReviewCli,
	gentleAiProcessEnvironment,
	nativeReviewAbandonAuthorization,
	NativeReviewConsentRequiredError,
} from "../../runtime/native-review-cli.mjs";
import {
	decodeReviewCapabilitiesV2,
	decodeReviewConsentV3,
	decodeReviewOperationV2,
	decodeReviewResultArtifactV2,
	decodeReviewStartV3,
	decodeReviewStatusV3,
} from "../../runtime/review-integration-v2.mjs";
// The recovered-successor checks drive the CONTROLLER (not just the runtime
// adapter) against the live binary; Node's default type stripping loads the
// authored TypeScript directly.
import { __testing } from "../../extensions/gentle-ai.ts";
import { CandidateViewRegistry, injectReviewCandidateView } from "../../lib/review-candidate-view.ts";

const WITH_MODEL = process.argv.includes("--with-model");
const CONTRACT = "gentle-ai.review-integration/v2";
const KNOWN_RED_SEQUENCING = "known-red pending fix/validate-before-evidence";

// A schema-incompatible failure mid-lifecycle means the forward decoder lags
// a field gentle-ai main already emits: the exact parity gap this battery
// exists to surface before merge. The sequencing check (the
// validate-before-evidence class, pending fix/validate-before-evidence)
// stays unevaluated until decoder parity lands.
function knownRedParity(message) {
	if (!message.includes("schema incompatible")) return message;
	return `known-red pending gentle-pi decoder parity with gentle-ai main: ${message}`;
}

const checks = [];
const rawEnvelopes = [];

function describeError(error) {
	if (!(error instanceof Error)) return String(error);
	const parts = [error.message];
	let cause = error.cause;
	while (cause !== undefined && cause !== null) {
		parts.push(cause instanceof Error ? cause.message : String(cause));
		cause = cause instanceof Error ? cause.cause : undefined;
	}
	let described = parts.join(" <- ");
	if (described.includes("schema incompatible")) {
		described += " (the decoder freshness lane below names the exact rejected field)";
	}
	return described;
}

function report(name, status, note) {
	checks.push({ name, status, note });
}

function pass(name, note) {
	report(name, "PASS", note);
}
function fail(name, note) {
	report(name, "FAIL", note);
}
function skip(name, note) {
	report(name, "SKIP", note);
}

// --- binary resolution: the dev-binary override is this battery's reason to exist ---

function resolveBatteryBinary() {
	const fromEnv = process.env[GENTLE_AI_DEV_BINARY_ENV];
	if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
	const override = resolveGentleAiDevBinaryOverride();
	if (override !== undefined) {
		// Project the registration into the env override so every downstream
		// dev-mode relaxation (version banner, capability floor) is active.
		process.env[GENTLE_AI_DEV_BINARY_ENV] = override.path;
		return override.path;
	}
	throw new Error(
		`no dev binary override: set ${GENTLE_AI_DEV_BINARY_ENV}=<absolute path> or register one with /gentle:dev-binary <path>`,
	);
}

// --- raw native access (the battery's independent view of the binary) ---

function rawInvoke(binary, cwd, args) {
	const stdout = execFileSync(binary, args, {
		cwd,
		encoding: "utf8",
		env: gentleAiProcessEnvironment(),
	});
	const body = JSON.parse(stdout);
	if (body !== null && typeof body === "object" && typeof body.schema === "string") {
		rawEnvelopes.push({ schema: body.schema, source: args.slice(0, 2).join(" "), body });
	}
	return body;
}

function rawStatus(binary, cwd) {
	return rawInvoke(binary, cwd, [
		"review", "status", "--contract", CONTRACT, "--cwd", cwd,
		"--projection", "workspace", "--next-transition",
	]);
}

// --- scratch repositories ---

function git(cwd, ...args) {
	execFileSync("git", args, { cwd, encoding: "utf8" });
}

function scratchRepo(root, name) {
	const cwd = join(root, name);
	mkdirSync(cwd, { recursive: true });
	git(cwd, "init", "-q", "-b", "main");
	git(cwd, "config", "user.email", "crosslane@example.com");
	git(cwd, "config", "user.name", "Cross Lane Battery");
	git(cwd, "commit", "-q", "--allow-empty", "-m", "chore: root");
	return cwd;
}

function write(cwd, name, content) {
	const path = join(cwd, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function commitAll(cwd, message) {
	git(cwd, "add", "-A");
	git(cwd, "commit", "-q", "-m", message);
}

// --- transition parity: the controller's offered next step vs the native one ---

function transitionSummary(kind, reasonCode, executeOperation, collectOperations) {
	return JSON.stringify({ kind, reasonCode, executeOperation, collectOperations });
}

function summarizeDecoded(transition) {
	return transitionSummary(
		transition?.kind ?? "(none)",
		transition?.reasonCode ?? "(none)",
		transition?.execute?.operation,
		transition?.collect?.inputs.map((input) => input.captureOperation),
	);
}

function summarizeRaw(transition) {
	return transitionSummary(
		transition?.kind ?? "(none)",
		transition?.reason_code ?? "(none)",
		transition?.execute?.operation,
		transition?.collect?.inputs.map((input) => input.capture_operation),
	);
}

function assertOfferedStepMatchesNative(step, decodedStatus, rawDocument) {
	const offered = summarizeDecoded(decodedStatus.nextTransition);
	const native = summarizeRaw(rawDocument.next_transition);
	if (offered !== native) {
		throw new Error(`${step}: controller offered ${offered} but native transition is ${native}`);
	}
}

function executeTokens(transition) {
	return transition.execute.arguments.map(
		(argument) => argument.token ?? `--${argument.name.replaceAll("_", "-")}=${argument.value}`,
	);
}

function rawArgumentValues(input) {
	const values = {};
	for (const argument of input.arguments ?? []) values[argument.name] = argument.value;
	return values;
}

function substitute(tokens, slots) {
	return tokens.map((token) => {
		let out = token;
		for (const [slot, value] of Object.entries(slots)) out = out.replaceAll(`{{${slot}}}`, value);
		return out;
	});
}

// --- checks ---

async function lowLifecycle(binary, cli, root) {
	const cwd = scratchRepo(root, "pi-low");
	write(cwd, "docs/ordinary-guide.md", "# Ordinary guide\n\nline one\n");
	commitAll(cwd, "docs: guide");
	write(cwd, "docs/ordinary-guide.md", "# Ordinary guide\n\nline one\nline two, purely passive documentation\n");

	let raw = rawStatus(binary, cwd);
	let status = await cli.targetStatus({ cwd });
	assertOfferedStepMatchesNative("pre-start", status, raw);
	if (status.nextTransition?.execute?.operation !== "review.start") {
		throw new Error(`expected review.start, got ${summarizeDecoded(status.nextTransition)}`);
	}
	const start = await cli.start({ cwd, targetIdentity: status.targetIdentity, projection: "workspace" });
	if (start.riskLevel !== "low" || start.state !== "reviewing" || start.lensesRequired) {
		throw new Error(`low start decoded riskLevel=${start.riskLevel} state=${start.state} lensesRequired=${start.lensesRequired}`);
	}

	raw = rawStatus(binary, cwd);
	status = await cli.targetStatus({ cwd });
	assertOfferedStepMatchesNative("pre-finalize", status, raw);
	if (status.nextTransition?.execute?.operation !== "review.finalize") {
		throw new Error(`expected review.finalize, got ${summarizeDecoded(status.nextTransition)}`);
	}
	const finalize = await cli.finalizeTransition({ cwd, argumentTokens: executeTokens(status.nextTransition) });
	if (finalize.state !== "approved") throw new Error(`finalize state=${finalize.state}`);

	git(cwd, "add", "-A");
	const validate = await cli.validate({ cwd, gate: "pre-commit", lineageId: finalize.lineageId });
	if (!validate.allowed || validate.result !== "allow") {
		throw new Error(`gate result=${validate.result} allowed=${validate.allowed}`);
	}
	return "start (low, zero lenses) -> finalize approved -> pre-commit validate allow, offered step matched native at every hop";
}

async function mediumConsent(binary, cli, root) {
	const cwd = scratchRepo(root, "pi-medium");
	write(cwd, "src/mul.js", "export function mul(a, b) {\n  return a * b;\n}\n");
	commitAll(cwd, "feat: mul");
	write(cwd, "src/mul.js", "export function mul(a, b) {\n  return a * b;\n}\nexport function twice(a) {\n  return a + a;\n}\n");

	const raw = rawStatus(binary, cwd);
	const status = await cli.targetStatus({ cwd });
	assertOfferedStepMatchesNative("pre-start", status, raw);
	let consent;
	try {
		await cli.start({ cwd, targetIdentity: status.targetIdentity, projection: "workspace" });
		throw new Error("medium start unexpectedly proceeded without surfacing consent");
	} catch (error) {
		if (!(error instanceof NativeReviewConsentRequiredError)) throw error;
		consent = error.consent;
	}
	if (consent.schema !== "gentle-ai.review-integration.consent/v3") {
		throw new Error(`consent schema=${consent.schema}`);
	}
	rawEnvelopes.push({ schema: consent.schema, source: "review start (consent)", body: consent.raw });
	const answer = await cli.answerConsent({ cwd, consent, answer: "granted" });
	if (answer.kind !== "started") throw new Error(`granted answer kind=${answer.kind}`);
	const granted = answer.start;
	if (granted.state !== "reviewing" || granted.riskLevel !== "medium" || granted.selectedLenses.length !== 1) {
		throw new Error(`granted state=${granted.state} risk=${granted.riskLevel} lenses=${granted.selectedLenses.length}`);
	}
	return { cwd, note: "consent/v3 surfaced through the direct decoder lane; granted answer created a reviewing medium lineage" };
}

// sequencingLifecycle drives a scripted correction on its own medium lineage
// and checks, at every step, that the client's decoded offered step equals
// the native transition - including the evidence-before-validation ordering.
async function sequencingLifecycle(binary, cli, root) {
	const cwd = scratchRepo(root, "pi-sequencing");
	const base = "export function greet(name) {\n  return \"hi \" + name;\n}\n";
	write(cwd, "src/greet.js", base);
	commitAll(cwd, "feat: greet");
	write(cwd, "src/greet.js", `${base}export function shout(name) {\n  return name.toUpperCase() + "!";\n}\n`);

	let raw = rawStatus(binary, cwd);
	let status = await cli.targetStatus({ cwd });
	assertOfferedStepMatchesNative("pre-start", status, raw);
	let consent;
	try {
		await cli.start({ cwd, targetIdentity: status.targetIdentity, projection: "workspace" });
		throw new Error("medium start unexpectedly proceeded without surfacing consent");
	} catch (error) {
		if (!(error instanceof NativeReviewConsentRequiredError)) throw error;
		consent = error.consent;
	}
	const sequencingAnswer = await cli.answerConsent({ cwd, consent, answer: "granted" });
	if (sequencingAnswer.kind !== "started") throw new Error(`granted answer kind=${sequencingAnswer.kind}`);

	// Reviewer slot: capture one deterministic candidate-causal blocker.
	raw = rawStatus(binary, cwd);
	status = await cli.targetStatus({ cwd });
	assertOfferedStepMatchesNative("reviewer-slot", status, raw);
	const reviewerInput = status.nextTransition?.collect?.inputs[0];
	if (reviewerInput?.captureOperation !== "review.capture-result") {
		throw new Error(`expected review.capture-result, got ${summarizeDecoded(status.nextTransition)}`);
	}
	const args = rawArgumentValues(raw.next_transition.collect.inputs[0]);
	const reviewerFile = join(root, "pi-reviewer.json");
	writeFileSync(reviewerFile, JSON.stringify({
		subject_hash: args["subject-hash"],
		inspection: { status: "completed", paths: ["src/greet.js"] },
		evidence: ["shout calls toUpperCase without a nullish guard; introduced by the candidate hunk"],
		findings: [{
			claim: "shout calls toUpperCase on its argument without a null/undefined guard",
			severity: "BLOCKER",
			evidence_class: "deterministic",
			causal_disposition: "introduced",
			lens: "review-reliability",
			location: "src/greet.js:5",
			proof_refs: ["src/greet.js:4-6 calls name.toUpperCase() with no nullish guard in the candidate tree"],
		}],
	}));
	rawInvoke(binary, cwd, [
		"review", "capture-result",
		"--lineage", args.lineage,
		"--expected-revision", args["expected-revision"],
		"--target", args.target,
		"--repository-context", args["repository-context"],
		"--lens", args.lens,
		"--order", args.order,
		"--subject-hash", args["subject-hash"],
		"--input", reviewerFile,
	]);

	// Finalize into correction_required through the client.
	raw = rawStatus(binary, cwd);
	status = await cli.targetStatus({ cwd });
	assertOfferedStepMatchesNative("post-capture", status, raw);
	if (status.nextTransition?.execute?.operation !== "review.finalize") {
		throw new Error(`expected review.finalize, got ${summarizeDecoded(status.nextTransition)}`);
	}
	const finalize = await cli.finalizeTransition({ cwd, argumentTokens: executeTokens(status.nextTransition) });
	if (finalize.state !== "correction_required") throw new Error(`finalize state=${finalize.state}`);

	// Correction plan forecast is submitted BEFORE editing.
	raw = rawStatus(binary, cwd);
	status = await cli.targetStatus({ cwd });
	assertOfferedStepMatchesNative("correction-plan", status, raw);
	const planInput = raw.next_transition?.collect?.inputs[0];
	if (planInput?.capture_operation !== "external.plan_correction") {
		throw new Error(`expected external.plan_correction, got ${summarizeRaw(raw.next_transition)}`);
	}
	const planTokens = substitute(planInput.submission.argument_tokens, { value: "2" });
	rawInvoke(binary, root, ["review", planInput.submission.operation_token, ...planTokens]);

	// Bounded fix edit.
	write(cwd, "src/greet.js", `${base}export function shout(name) {\n  if (name == null) return "!";\n  return name.toUpperCase() + "!";\n}\n`);

	// THE sequencing class check: correction evidence must be collected
	// before any targeted validation is offered.
	raw = rawStatus(binary, cwd);
	status = await cli.targetStatus({ cwd });
	assertOfferedStepMatchesNative("post-fix", status, raw);
	const inputs = status.nextTransition?.kind === "collect" ? status.nextTransition.collect?.inputs ?? [] : [];
	// An offered validation STEP is a targeted-validation collect input. The
	// bare `validation_request` field is descriptive context both live
	// emitters (pinned 2.2.3 and 2.4.0-main, probed 2026-08-16) publish
	// alongside the evidence collect at `correction_required`.
	const validationOffered =
		inputs.some((input) => input.captureOperation === "external.run_targeted_validation" || input.captureOperation === "review.capture-validation");
	const evidenceInputs = inputs.filter((input) => input.captureOperation === "review.capture-evidence");
	if (validationOffered) {
		throw new Error(`${KNOWN_RED_SEQUENCING}: targeted validation was offered before correction evidence was captured`);
	}
	if (evidenceInputs.length !== 1) {
		throw new Error(`${KNOWN_RED_SEQUENCING}: expected exactly one review.capture-evidence input before validation, got ${summarizeDecoded(status.nextTransition)}`);
	}
	pass("sequencing: evidence collected before targeted validation", "correction status offers exactly one review.capture-evidence and no validation until evidence lands");

	const evidenceArgs = rawArgumentValues(raw.next_transition.collect.inputs[0]);
	const evidence = await cli.captureEvidence({
		cwd,
		lineageId: evidenceArgs.lineage,
		targetIdentity: evidenceArgs.target,
		expectedRevision: evidenceArgs["expected-revision"],
		outcome: "passed",
		evidenceDocument: `cross-lane battery: node --check src/greet.js passed; shout(null) now returns "!" instead of throwing\n`,
	});
	if (evidence.outcome !== "passed") throw new Error(`evidence outcome=${evidence.outcome}`);

	// Only now may targeted validation be offered.
	raw = rawStatus(binary, cwd);
	status = await cli.targetStatus({ cwd });
	assertOfferedStepMatchesNative("post-evidence", status, raw);
	const validationInput = raw.next_transition?.collect?.inputs[0];
	if (
		validationInput?.capture_operation !== "external.run_targeted_validation" &&
		validationInput?.capture_operation !== "review.capture-validation"
	) {
		throw new Error(`expected targeted validation after evidence, got ${summarizeRaw(raw.next_transition)}`);
	}
	if (status.validationRequest === undefined) {
		throw new Error("decoded status is missing the validation request after evidence capture");
	}
	const validatorFile = join(root, "pi-validator.json");
	writeFileSync(validatorFile, JSON.stringify({
		targeted_validation_request_hash: status.validationRequest.requestHash,
		correction_target_identity: status.validationRequest.correctionTargetIdentity,
		original_criteria: { passed: true, evidence: ["frozen correction tree guards name == null before toUpperCase per the embedded diff"] },
		correction_regression: { passed: true, evidence: ["greet() is untouched by the correction diff; only shout gained the guard"] },
		follow_ups: [],
	}));
	const validationTokens = substitute(validationInput.submission.argument_tokens, { value: validatorFile });
	const approved = rawInvoke(binary, root, ["review", validationInput.submission.operation_token, ...validationTokens]);
	const approvedState = approved?.result?.state ?? approved?.state;
	if (approvedState !== "approved") throw new Error(`validation finalize state=${approvedState}`);
	return "offered step matched native at every hop; plan -> fix -> evidence -> targeted validation -> approved receipt";
}

// abandonLifecycle drives the audited abandon end-to-end through the real
// adapter runtime against the real binary: start a low lineage, abandon it
// with the adapter-built maintainer authorization, and confirm the native
// gate accepted the binding, committed a quarantine record, and no longer
// offers the lineage as live authority. RED-provable: the check asserts the
// adapter-built binding is exactly the nine-line
// gentle-ai.review-abandon-authorization/v2 discarded-work binding, so a
// v1-emitting builder (the drift class that escaped to a live Pi session)
// fails this check before the binary is even invoked - and would be refused
// by the native gate anyway.
async function abandonLifecycle(binary, cli, root) {
	const cwd = scratchRepo(root, "pi-abandon");
	write(cwd, "docs/abandon-guide.md", "# Abandon guide\n\nline one\n");
	commitAll(cwd, "docs: abandon guide");
	write(cwd, "docs/abandon-guide.md", "# Abandon guide\n\nline one\nline two, purely passive documentation\n");

	let raw = rawStatus(binary, cwd);
	let status = await cli.targetStatus({ cwd });
	assertOfferedStepMatchesNative("pre-start", status, raw);
	const start = await cli.start({ cwd, targetIdentity: status.targetIdentity, projection: "workspace" });
	if (start.state !== "reviewing") throw new Error(`abandon precondition start state=${start.state}`);

	raw = rawStatus(binary, cwd);
	if (raw.authority?.lineage_id !== start.lineageId || typeof raw.authority?.revision !== "string") {
		throw new Error(`live authority missing for started lineage ${start.lineageId}: ${JSON.stringify(raw.authority)}`);
	}
	// A fresh lineage before any capture carries the smallest discarded-work
	// summary the v2 binding names: no captured lens results, no findings,
	// no evidence records.
	const request = {
		cwd,
		lineage: raw.authority.lineage_id,
		expectedRevision: raw.authority.revision,
		snapshotIdentity: raw.projection.initial_snapshot_identity,
		capturedLensResults: [],
		findingsPresent: false,
		evidenceRecordsPresent: false,
		actor: "cross-lane-battery",
		reason: "operator_disposition",
	};
	const authorization = nativeReviewAbandonAuthorization(request);
	const expectedBinding = [
		"gentle-ai.review-abandon-authorization/v2",
		`lineage=${request.lineage}`,
		`revision=${request.expectedRevision}`,
		`snapshot_identity=${request.snapshotIdentity}`,
		"reason=operator_disposition",
		"captured_lens_results=",
		"findings_present=false",
		"evidence_records_present=false",
		"actor=cross-lane-battery",
	].join("\n");
	if (authorization !== expectedBinding) {
		throw new Error(
			`adapter built ${authorization.split("\n")[0]} instead of the exact nine-line gentle-ai.review-abandon-authorization/v2 binding: the audited-abandon drift class (v1 emission) is back`,
		);
	}
	const result = await cli.abandon({ ...request, maintainerAuthorization: authorization });
	if (result.record?.status !== "committed") throw new Error(`abandon record status=${result.record?.status}`);
	if (result.record?.abandonment?.schema !== "gentle-ai.review-abandon-authorization/v2") {
		throw new Error(`abandon record binding schema=${result.record?.abandonment?.schema}`);
	}

	// The abandoned lineage must no longer be offered as live authority.
	raw = rawStatus(binary, cwd);
	status = await cli.targetStatus({ cwd });
	assertOfferedStepMatchesNative("post-abandon", status, raw);
	if (raw.authority !== null && raw.authority !== undefined) {
		throw new Error(`post-abandon status still reports live authority ${JSON.stringify(raw.authority)}`);
	}
	if (status.nextTransition?.execute?.operation !== "review.start") {
		throw new Error(`post-abandon expected a fresh review.start, got ${summarizeDecoded(status.nextTransition)}`);
	}
	return "adapter-built nine-line v2 binding accepted natively; quarantine record committed; post-abandon status offers only a fresh start";
}

// recoveredSuccessorLifecycle reproduces the maintainer's live scenario
// (2026-08-16, Engram #12461/#12466): a lineage recovered EXTERNALLY through
// the native CLI, then driven by the Pi controller from STATUS alone.
//   1. approve a low documentation lineage;
//   2. change the scope with a code edit (medium risk);
//   3. native `review recover --disposition scope_changed` with the explicit
//      LF-only gentle-ai.review-recovery-authorization/v1 binding (an ACTIVE
//      reviewing predecessor refuses recovery, so approval comes first);
//   4. defect A: the controller's dispatch binding must hydrate from the
//      STATUS the controller itself decodes — before that STATUS, dispatch
//      refuses with current-binding-missing;
//   5. defect B: finalize at reviewer_results_required must surface the
//      provider-offered review.capture-result step, never the correction
//      evidence-first-ordering lane;
//   6. the drive completes to one really captured lens.
async function recoveredSuccessorLifecycle(binary, cli, root) {
	const cwd = scratchRepo(root, "pi-recovered");
	write(cwd, "docs/recover-guide.md", "# Recover guide\n\nline one\n");
	write(cwd, "src/mul.js", "export function mul(a, b) {\n  return a * b;\n}\n");
	commitAll(cwd, "feat: base");
	write(cwd, "docs/recover-guide.md", "# Recover guide\n\nline one\nline two, purely passive documentation\n");

	// Low predecessor to approval.
	let raw = rawStatus(binary, cwd);
	let status = await cli.targetStatus({ cwd });
	assertOfferedStepMatchesNative("pre-start", status, raw);
	const start = await cli.start({ cwd, targetIdentity: status.targetIdentity, projection: "workspace" });
	if (start.riskLevel !== "low" || start.state !== "reviewing") throw new Error(`predecessor start risk=${start.riskLevel} state=${start.state}`);
	status = await cli.targetStatus({ cwd });
	if (status.nextTransition?.execute?.operation !== "review.finalize") {
		throw new Error(`expected review.finalize, got ${summarizeDecoded(status.nextTransition)}`);
	}
	const finalize = await cli.finalizeTransition({ cwd, argumentTokens: executeTokens(status.nextTransition) });
	if (finalize.state !== "approved") throw new Error(`predecessor finalize state=${finalize.state}`);

	// External scope change: code joins the approved documentation change.
	write(cwd, "src/mul.js", "export function mul(a, b) {\n  return a * b;\n}\nexport function twice(a) {\n  return a + a;\n}\n");
	raw = rawStatus(binary, cwd);
	const successor = "recovered-successor-crosslane";
	const authorization = [
		"gentle-ai.review-recovery-authorization/v1",
		`predecessor_lineage=${finalize.lineageId}`,
		`predecessor_revision=${finalize.storeRevision}`,
		`target_identity=${raw.target_identity}`,
		"actor=cross-lane-battery",
		"reason=scope changed after approval",
	].join("\n");
	rawInvoke(binary, cwd, [
		"review", "recover", "--cwd", cwd,
		"--predecessor-lineage", finalize.lineageId,
		"--expected-predecessor-revision", finalize.storeRevision,
		"--successor-lineage", successor,
		"--disposition", "scope_changed",
		"--actor", "cross-lane-battery",
		"--reason", "scope changed after approval",
		"--maintainer-authorization", authorization,
	]);

	const registry = new CandidateViewRegistry();
	try {
		// Defect A: before the controller decodes the successor's STATUS, the
		// dispatch registry knows nothing — the refusal is the pre-fix shape.
		let refused = false;
		try {
			injectReviewCandidateView({ agent: "review-reliability", task: "probe", mode: "task" }, registry);
		} catch (error) {
			refused = /no current controller-owned candidate view lineage binding/.test(String(error instanceof Error ? error.message : error));
		}
		if (!refused) throw new Error("pre-STATUS dispatch unexpectedly resolved a binding for the recovered successor");
		await __testing.executeReviewControllerOperation({ operation: "status", lineageId: successor }, cwd, new Map(), cli, undefined, undefined, undefined, registry);
		if (!registry.hasCurrentBinding()) {
			throw new Error("controller STATUS did not hydrate the candidate-view dispatch binding for the recovered successor");
		}
		const dispatch = { agent: "review-reliability", task: "review the recovered successor", mode: "task" };
		injectReviewCandidateView(dispatch, registry);
		if (!dispatch.task.includes(successor)) throw new Error("hydrated dispatch context is not bound to the recovered successor lineage");
		pass(
			"recovered binding: STATUS hydrates controller dispatch",
			"external scope_changed successor driven from STATUS alone: pre-STATUS dispatch refused, post-STATUS dispatch injected the successor candidate context (a controller without STATUS hydration fails here)",
		);

		// Defect B: document-free finalize at reviewer_results_required.
		const finalizeEnvelope = await __testing.executeReviewControllerOperation({ operation: "finalize", lineageId: successor, input: JSON.stringify({}) }, cwd, new Map(), cli, undefined, undefined, undefined, registry);
		if (finalizeEnvelope.status !== "blocked" || finalizeEnvelope.outcome !== "reviewer-results-required" || finalizeEnvelope.mutation_performed !== false) {
			throw new Error(`finalize routed to ${String(finalizeEnvelope.outcome ?? finalizeEnvelope.status)} instead of the blocked reviewer-results-required step`);
		}
		if (!/capture the reviewer result first/i.test(String(finalizeEnvelope.reason)) || !String(finalizeEnvelope.reason).includes("review.capture-result")) {
			throw new Error("finalize block is missing the actionable review.capture-result direction");
		}
		if (JSON.stringify(finalizeEnvelope).includes("evidence-first-ordering")) {
			throw new Error("finalize still leaked the correction evidence-first-ordering lane");
		}
		pass(
			"recovered routing: finalize offers capture-result, never evidence ordering",
			"document-free finalize at reviewer_results_required returned the actionable review.capture-result block with zero mutations (a finalize that misroutes into evidence ordering fails here)",
		);

		// Complete the drive to one really captured lens through the exact
		// provider collect input.
		raw = rawStatus(binary, cwd);
		const input = raw.next_transition?.collect?.inputs?.[0];
		if (input?.capture_operation !== "review.capture-result") throw new Error(`expected review.capture-result, got ${summarizeRaw(raw.next_transition)}`);
		const args = rawArgumentValues(input);
		const reviewerFile = join(root, "pi-recovered-reviewer.json");
		writeFileSync(reviewerFile, JSON.stringify({
			subject_hash: args["subject-hash"],
			inspection: { status: "completed", paths: (input.changed_path_manifest ?? []).map((entry) => entry.path) },
			evidence: ["twice(a) returns a + a: pure arithmetic introduced by the candidate hunk with no external effects"],
			findings: [],
		}));
		const artifact = rawInvoke(binary, cwd, [
			"review", "capture-result",
			"--lineage", args.lineage,
			"--expected-revision", args["expected-revision"],
			"--target", args.target,
			"--repository-context", args["repository-context"],
			"--lens", args.lens,
			"--order", args.order,
			"--subject-hash", args["subject-hash"],
			"--input", reviewerFile,
		]);
		if (artifact?.schema !== "gentle-ai.review-result-artifact/v2") throw new Error(`successor lens capture returned schema=${artifact?.schema}`);
		return "low predecessor approved -> native scope_changed recover (explicit v1 binding) -> controller drove the successor from STATUS alone to one captured lens";
	} finally {
		try {
			registry.cleanup(registry.resolveCurrentForLens("review-reliability").token);
		} catch {
			// No hydrated view to clean when the check failed before binding.
		}
	}
}

async function modelReview(binary, cli, cwd) {
	const raw = rawStatus(binary, cwd);
	const input = raw.next_transition?.collect?.inputs?.[0];
	if (input?.capture_operation !== "review.capture-result") {
		throw new Error(`expected review.capture-result, got ${summarizeRaw(raw.next_transition)}`);
	}
	const args = rawArgumentValues(input);
	const artifact = rawInvoke(binary, cwd, [
		"review", "capture-result",
		"--lineage", args.lineage,
		"--expected-revision", args["expected-revision"],
		"--target", args.target,
		"--repository-context", args["repository-context"],
		"--lens", args.lens,
		"--order", args.order,
		"--subject-hash", args["subject-hash"],
		"--agent", "pi",
	]);
	if (artifact?.schema !== "gentle-ai.review-result-artifact/v2") {
		throw new Error(`model capture returned schema=${artifact?.schema}`);
	}
	return "Go-owned locked-down pi reviewer captured a native result artifact";
}

// --- forward-decoder freshness over every captured live envelope ---

function decoderFor(schema, binaryDigest) {
	switch (schema) {
		case "gentle-ai.review-integration.status/v3":
		case "gentle-ai.review-integration.status/v4":
		case "gentle-ai.review-integration.status/v5":
			return (body) => decodeReviewStatusV3(body);
		case "gentle-ai.review-integration.start/v3":
			return (body) => decodeReviewStartV3(body);
		case "gentle-ai.review-integration.consent/v3":
			return (body) => decodeReviewConsentV3(body);
		case "gentle-ai.review-integration.operation/v2":
			return (body) => decodeReviewOperationV2(body);
		case "gentle-ai.review-result-artifact/v2":
			return (body) => decodeReviewResultArtifactV2(body);
		case "gentle-ai.review-integration.capabilities/v2":
		case "gentle-ai.review-integration.capabilities/v2.1":
		case "gentle-ai.review-integration.capabilities/v2.2":
			return (body) => decodeReviewCapabilitiesV2(body, binaryDigest);
		default:
			return undefined;
	}
}

function decoderFreshness(binary) {
	const digest = `sha256:${createHash("sha256").update(readFileSync(binary)).digest("hex")}`;
	const outcomes = new Map();
	for (const envelope of rawEnvelopes) {
		const state = outcomes.get(envelope.schema) ?? { total: 0, failures: [] };
		state.total += 1;
		const decoder = decoderFor(envelope.schema, digest);
		if (decoder === undefined) {
			state.failures.push(`no forward decoder maps ${envelope.schema} (${envelope.source})`);
		} else {
			try {
				decoder(envelope.body);
			} catch (error) {
				state.failures.push(`${envelope.source}: ${describeError(error)}`);
			}
		}
		outcomes.set(envelope.schema, state);
	}
	for (const schema of [...outcomes.keys()].sort()) {
		const state = outcomes.get(schema);
		const unique = [...new Set(state.failures)].slice(0, 3);
		if (state.failures.length === 0) {
			pass(`decoder freshness: ${schema}`, `${state.total} live envelope(s) decoded without unknown-key rejection`);
		} else {
			fail(`decoder freshness: ${schema}`, `${state.failures.length}/${state.total} rejected: ${unique.join(" | ")}`);
		}
	}
}

// --- driver ---

async function main() {
	const binary = resolveBatteryBinary();
	console.log(`cross-lane battery (Pi direct lane)`);
	console.log(`binary: ${binary}`);
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-crosslane-"));
	const cli = createNativeReviewCli(undefined, binary);
	try {
		// Capture one live capabilities envelope for the freshness lane.
		rawInvoke(binary, root, ["review", "capabilities", "--contract", CONTRACT]);

		try {
			pass("low lifecycle to gate allow", await lowLifecycle(binary, cli, root));
		} catch (error) {
			fail("low lifecycle to gate allow", knownRedParity(describeError(error)));
		}

		let mediumRepo;
		try {
			const outcome = await mediumConsent(binary, cli, root);
			mediumRepo = outcome.cwd;
			pass("medium consent/v3 granted round-trip", outcome.note);
		} catch (error) {
			fail("medium consent/v3 granted round-trip", describeError(error));
		}

		try {
			pass("sequencing lifecycle to approved receipt", await sequencingLifecycle(binary, cli, root));
		} catch (error) {
			const message = describeError(error);
			const name = message.startsWith(KNOWN_RED_SEQUENCING)
				? "sequencing: evidence collected before targeted validation"
				: "sequencing lifecycle to approved receipt";
			fail(name, knownRedParity(message));
		}

		try {
			pass("audited abandon end-to-end (v2 discarded-work binding)", await abandonLifecycle(binary, cli, root));
		} catch (error) {
			fail("audited abandon end-to-end (v2 discarded-work binding)", knownRedParity(describeError(error)));
		}

		try {
			pass("external native recover to captured successor lens", await recoveredSuccessorLifecycle(binary, cli, root));
		} catch (error) {
			fail("external native recover to captured successor lens", knownRedParity(describeError(error)));
		}

		if (WITH_MODEL && mediumRepo !== undefined) {
			try {
				pass("medium reviewer model run (pi)", await modelReview(binary, cli, mediumRepo));
			} catch (error) {
				fail("medium reviewer model run (pi)", describeError(error));
			}
		} else {
			skip("medium reviewer model run (pi)", "pass --with-model to run the Go-owned pi reviewer (model spend)");
		}

		decoderFreshness(binary);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

	const nameWidth = Math.max(...checks.map((check) => check.name.length), "check".length);
	console.log("");
	console.log(`${"check".padEnd(nameWidth)}  status  note`);
	let failed = 0;
	for (const check of checks) {
		console.log(`${check.name.padEnd(nameWidth)}  ${check.status.padEnd(6)}  ${check.note}`);
		if (check.status === "FAIL") failed += 1;
	}
	console.log("");
	console.log(`total: ${checks.length} checks, ${failed} failed`);
	if (failed > 0) process.exitCode = 1;
}

await main();
