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
//      runtime/*.mjs (terminal approval burns authority; medium consent/v3 granted).
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
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

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
import { CandidateViewRegistry } from "../../lib/review-candidate-view.ts";

const WITH_MODEL = process.argv.includes("--with-model");
const CONTRACT = "gentle-ai.review-integration/v2";
const FAKE_PI_VALIDATOR_PATH_PREFIX = "gentle-pi-validator-result-";
const SANDBOX_ENVIRONMENT_NAMES = [
	"HOME",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"TMPDIR",
];

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

function snapshotProcessEnvironment() {
	return new Map(Object.entries(process.env));
}

function restoreProcessEnvironment(snapshot) {
	for (const name of Object.keys(process.env)) {
		if (!snapshot.has(name)) delete process.env[name];
	}
	for (const [name, value] of snapshot) process.env[name] = value;
}

function processEnvironmentMatches(snapshot) {
	const names = Object.keys(process.env);
	return names.length === snapshot.size && names.every((name) => snapshot.get(name) === process.env[name]);
}

function configureSandboxEnvironment(root) {
	const sandbox = {
		HOME: join(root, "home"),
		XDG_CONFIG_HOME: join(root, "xdg-config"),
		XDG_CACHE_HOME: join(root, "xdg-cache"),
		XDG_DATA_HOME: join(root, "xdg-data"),
		XDG_STATE_HOME: join(root, "xdg-state"),
		TMPDIR: join(root, "tmp"),
	};
	for (const name of SANDBOX_ENVIRONMENT_NAMES) {
		mkdirSync(sandbox[name], { recursive: true, mode: 0o700 });
		process.env[name] = sandbox[name];
	}
	return sandbox;
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

function sandboxReviewModeInvoke(binary, cwd, args) {
	return JSON.parse(execFileSync(binary, args, {
		cwd,
		encoding: "utf8",
		env: gentleAiProcessEnvironment(),
	}));
}

function sandboxReviewModeStatus(binary, cwd, expectedEffective, expectedSource, phase) {
	const response = sandboxReviewModeInvoke(binary, cwd, [
		"review", "mode", "status", "--scope", "global", "--cwd", cwd, "--json",
	]);
	const status = response?.status;
	if (status?.effective !== expectedEffective || status.source !== expectedSource) {
		throw new Error(`${phase}: sandbox RDD mode expected effective=${expectedEffective} source=${expectedSource}, got ${JSON.stringify(status)}`);
	}
	return status;
}

function enableSandboxReviewMode(binary, cwd) {
	sandboxReviewModeInvoke(binary, cwd, [
		"review", "mode", "enable", "--scope", "global", "--cwd", cwd, "--json",
	]);
}

function rawStatus(binary, cwd, lineageId) {
	const args = [
		"review", "status", "--contract", CONTRACT, "--cwd", cwd,
		"--projection", "workspace", "--agent", "pi", "--next-transition",
	];
	if (lineageId !== undefined) args.push("--lineage", lineageId);
	return rawInvoke(binary, cwd, args);
}

// START negotiates the Pi transport itself. Every later STATUS in this direct
// lane must name that same public transport so it observes the same compact-v2
// lifecycle rather than an agent-less view of it.
function piDirectCli(cli) {
	const targetStatus = cli.targetStatus.bind(cli);
	cli.targetStatus = (request) => targetStatus({ ...request, agent: "pi" });
	return cli;
}

// --- scratch repositories ---

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
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

// `review.capture-validation --execute=true` owns its Pi subprocess. This
// battery supplies only a deterministic executable in its own scratch root.
// The Go sandbox retains PATH, so each call carries its exact JSON in a
// battery-owned opaque PATH entry; the fake reads the Go-rendered prompt and
// emits that value only. It has no repository, HOME, network, model, provider,
// profile, or active-worktree access.
function installFakePi(root) {
	const directory = join(root, "fake-pi-bin");
	const executable = join(directory, "pi");
	const log = join(root, "fake-pi-invocations.log");
	const original = { path: process.env.PATH };
	const basePath = `${directory}${delimiter}${original.path ?? ""}`;
	mkdirSync(directory, { recursive: true });
	writeFileSync(executable, `#!/bin/sh
set -eu
/bin/cat >/dev/null
result=""
old_ifs=$IFS
IFS=:
for entry in $PATH; do
  case "$entry" in
    ${FAKE_PI_VALIDATOR_PATH_PREFIX}*)
      encoded="\${entry#${FAKE_PI_VALIDATOR_PATH_PREFIX}}"
      result=$(printf '%b' "$encoded")
      break
      ;;
  esac
done
IFS=$old_ifs
if [ -z "$result" ]; then
  printf '%s\\n' fake-pi-targeted-validator:missing-result >> '${log}'
  exit 64
fi
printf '%s\\n' fake-pi-targeted-validator:emitted-result >> '${log}'
printf '%s' "$result"
`);
	chmodSync(executable, 0o700);
	process.env.PATH = basePath;

	function restore(name, value) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	return {
		setResult(result) {
			const octal = Buffer.from(result, "utf8").toString("hex").match(/../g)?.map((byte) => `\\${Number.parseInt(byte, 16).toString(8).padStart(3, "0")}`).join("");
			if (octal === undefined) throw new Error("fake Pi validator result could not be encoded for its isolated environment");
			process.env.PATH = `${directory}${delimiter}${FAKE_PI_VALIDATOR_PATH_PREFIX}${octal}${delimiter}${original.path ?? ""}`;
		},
		clearResult() {
			process.env.PATH = basePath;
		},
		invocationCount() {
			if (!existsSync(log)) return 0;
			return readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("fake-pi-targeted-validator:")).length;
		},
		logSummary() {
			return existsSync(log) ? readFileSync(log, "utf8").trim() : "not invoked";
		},
		assertInvocation(before, step) {
			const count = this.invocationCount();
			if (count !== before + 1) {
				throw new Error(`${step}: fake Pi invocation count=${count}, expected ${before + 1}`);
			}
		},
		restore() {
			restore("PATH", original.path);
			if (process.env.PATH !== original.path) {
				throw new Error("fake Pi cleanup did not restore the sandbox process environment");
			}
		},
	};
}

function targetedValidatorDocument(validationRequest, originalEvidence, regressionEvidence) {
	if (typeof validationRequest?.requestHash !== "string" || typeof validationRequest?.correctionTargetIdentity !== "string") {
		throw new Error("targeted validation is missing its request hash or correction target identity");
	}
	const findingIds = validationRequest.fixFindingIds;
	if (!Array.isArray(findingIds) || findingIds.length === 0 || findingIds.some((id) => typeof id !== "string" || id.length === 0)) {
		throw new Error("targeted validation is missing its bound correction finding IDs");
	}
	const findingEvidence = `bound correction finding IDs: ${findingIds.join(", ")}`;
	return JSON.stringify({
		targeted_validation_request_hash: validationRequest.requestHash,
		correction_target_identity: validationRequest.correctionTargetIdentity,
		original_criteria: { passed: true, evidence: [originalEvidence, findingEvidence] },
		correction_regression: { passed: true, evidence: [regressionEvidence, findingEvidence] },
		follow_ups: [],
	});
}

async function captureTargetedValidation(fakePi, cli, cwd, validationInput, validationRequest, lineageId, step, originalEvidence, regressionEvidence) {
	if (validationInput?.captureOperation !== "review.capture-validation") {
		throw new Error(`${step}: expected review.capture-validation, got ${validationInput?.captureOperation ?? "(none)"}`);
	}
	const argumentTokens = validationInput.arguments.map((argument) => argument.token);
	if (argumentTokens.some((token) => token === undefined)) {
		throw new Error(`${step}: provider validation capture omitted an exact argument token`);
	}
	const before = fakePi.invocationCount();
	fakePi.setResult(targetedValidatorDocument(validationRequest, originalEvidence, regressionEvidence));
	let captured;
	try {
		captured = await cli.captureProviderRole({
			cwd,
			captureOperation: "review.capture-validation",
			argumentTokens,
		});
	} catch (error) {
		throw new Error(`${step}: Go-owned validation capture rejected exact tokens ${argumentTokens.join(" ")} ${JSON.stringify(error instanceof Error ? error.diagnostics : undefined)}; fake Pi=${fakePi.logSummary()}`, { cause: error });
	} finally {
		fakePi.clearResult();
	}
	fakePi.assertInvocation(before, step);
	if (!captured.captured || captured.role !== "targeted-validator" || captured.lineageId !== lineageId) {
		throw new Error(`${step}: provider validation capture did not preserve the exact lineage: ${JSON.stringify(captured)}`);
	}
	return captured;
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

async function assertTerminalApprovalBurn(binary, cli, cwd, lineageId, step) {
	const raw = rawStatus(binary, cwd, lineageId);
	const status = await cli.targetStatus({ cwd, lineageId });
	assertOfferedStepMatchesNative(`${step}: post-burn`, status, raw);
	if (raw.applicability !== "unrelated" || status.applicability !== "unrelated") {
		throw new Error(`${step}: approved lineage STATUS must be absent from the current target, raw=${raw.applicability} decoded=${status.applicability}`);
	}
	if (raw.authority !== undefined || status.authority !== undefined) {
		throw new Error(`${step}: terminal approval left live authority ${JSON.stringify(raw.authority)}`);
	}
	if (raw.receipt?.status !== "not_applicable" || raw.receipt?.identity !== undefined || status.receipt.status !== "not_applicable" || status.receipt.identity !== undefined) {
		throw new Error(`${step}: terminal approval left receipt evidence raw=${JSON.stringify(raw.receipt)} decoded=${JSON.stringify(status.receipt)}`);
	}
	if (raw.validation_request !== undefined || status.validationRequest !== undefined) {
		throw new Error(`${step}: terminal approval left validation evidence`);
	}
	if (raw.action !== "start" || status.action !== "start" || status.nextTransition?.execute?.operation !== "review.start") {
		throw new Error(`${step}: approved lineage STATUS manufactured approval instead of a fresh start, raw=${summarizeRaw(raw.next_transition)} decoded=${summarizeDecoded(status.nextTransition)}`);
	}
	if (git(cwd, "diff", "--cached", "--name-only") !== "") {
		throw new Error(`${step}: terminal approval left staged repository content`);
	}
	return "approved finalize response is the approval proof; exact-lineage STATUS is unrelated with no authority, receipt, validation, or staging and offers fresh review.start";
}

async function startActiveMediumLineage(binary, cli, cwd, step) {
	let raw = rawStatus(binary, cwd);
	let status = await cli.targetStatus({ cwd });
	assertOfferedStepMatchesNative(`${step}: pre-start`, status, raw);
	let consent;
	try {
		await cli.start({ cwd, targetIdentity: status.targetIdentity, projection: "workspace" });
		throw new Error(`${step}: medium start unexpectedly proceeded without consent`);
	} catch (error) {
		if (!(error instanceof NativeReviewConsentRequiredError)) {
			throw new Error(`${step}: START did not follow its fresh candidate transition ${summarizeDecoded(status.nextTransition)}`, { cause: error });
		}
		consent = error.consent;
	}
	const answer = await cli.answerConsent({ cwd, consent, answer: "granted" });
	if (answer.kind !== "started" || answer.start.state !== "reviewing" || answer.start.riskLevel !== "medium") {
		throw new Error(`${step}: granted medium start did not create a live reviewing authority`);
	}
	raw = rawStatus(binary, cwd, answer.start.lineageId);
	status = await cli.targetStatus({ cwd, lineageId: answer.start.lineageId });
	assertOfferedStepMatchesNative(`${step}: active`, status, raw);
	if (raw.authority?.lineage_id !== answer.start.lineageId || raw.authority?.state !== "reviewing") {
		throw new Error(`${step}: active authority is missing or changed ${JSON.stringify(raw.authority)}`);
	}
	return { start: answer.start, raw, status };
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

	raw = rawStatus(binary, cwd, start.lineageId);
	status = await cli.targetStatus({ cwd, lineageId: start.lineageId });
	assertOfferedStepMatchesNative("pre-finalize", status, raw);
	if (status.nextTransition?.execute?.operation !== "review.finalize") {
		throw new Error(`expected review.finalize, got ${summarizeDecoded(status.nextTransition)} after start ${JSON.stringify({ state: start.state, action: start.action, raw: start.raw })}; post-start STATUS ${JSON.stringify(raw)}`);
	}
	const finalize = await cli.finalizeTransition({ cwd, argumentTokens: executeTokens(status.nextTransition) });
	if (finalize.state !== "approved") throw new Error(`finalize state=${finalize.state}`);
	const burn = await assertTerminalApprovalBurn(binary, cli, cwd, finalize.lineageId, "low lifecycle");

	const validate = await cli.validate({ cwd, gate: "pre-commit", lineageId: finalize.lineageId });
	if (validate.allowed || validate.result !== "invalidated" || validate.action !== "repository-policy" || validate.delivery !== "unmanaged") {
		throw new Error(`gate must be informational/unmanaged after burn: result=${validate.result} allowed=${validate.allowed} action=${validate.action} delivery=${validate.delivery}`);
	}
	return `start (low, zero lenses) -> finalize approved -> ${burn}; pre-commit gate is informational/non-deciding unmanaged, not a receipt allow`;
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
	return { cwd, lineageId: granted.lineageId, note: "consent/v3 surfaced through the direct decoder lane; granted answer created a reviewing medium lineage" };
}

// sequencingLifecycle drives a scripted correction on its own medium lineage
// and checks, at every step, that the client's decoded offered step equals
// the native transition - including the evidence-before-validation ordering.
async function sequencingLifecycle(binary, cli, root, fakePi) {
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
	const sequencingLineageId = sequencingAnswer.start.lineageId;

	// Reviewer slot: capture one deterministic candidate-causal blocker.
	raw = rawStatus(binary, cwd, sequencingLineageId);
	status = await cli.targetStatus({ cwd, lineageId: sequencingLineageId });
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
	raw = rawStatus(binary, cwd, sequencingLineageId);
	status = await cli.targetStatus({ cwd, lineageId: sequencingLineageId });
	assertOfferedStepMatchesNative("post-capture", status, raw);
	if (status.nextTransition?.execute?.operation !== "review.finalize") {
		throw new Error(`expected review.finalize, got ${summarizeDecoded(status.nextTransition)}`);
	}
	const finalize = await cli.finalizeTransition({ cwd, argumentTokens: executeTokens(status.nextTransition) });
	if (finalize.state !== "correction_required") throw new Error(`finalize state=${finalize.state}`);

	// Correction plan forecast is submitted BEFORE editing.
	raw = rawStatus(binary, cwd, sequencingLineageId);
	status = await cli.targetStatus({ cwd, lineageId: sequencingLineageId });
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
	raw = rawStatus(binary, cwd, sequencingLineageId);
	status = await cli.targetStatus({ cwd, lineageId: sequencingLineageId });
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
		throw new Error("targeted validation was offered before correction evidence was captured");
	}
	if (evidenceInputs.length !== 1) {
		throw new Error(`expected exactly one review.capture-evidence input before validation, got ${summarizeDecoded(status.nextTransition)}`);
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
	raw = rawStatus(binary, cwd, sequencingLineageId);
	status = await cli.targetStatus({ cwd, lineageId: sequencingLineageId });
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
	const capturedValidation = status.nextTransition?.collect?.inputs?.[0];
	await captureTargetedValidation(
		fakePi,
		cli,
		cwd,
		capturedValidation,
		status.validationRequest,
		sequencingLineageId,
		"sequencing targeted validation",
		"frozen correction tree guards name == null before toUpperCase per the embedded diff",
		"greet() is untouched by the correction diff; only shout gained the guard",
	);
	raw = rawStatus(binary, cwd, sequencingLineageId);
	status = await cli.targetStatus({ cwd, lineageId: sequencingLineageId });
	assertOfferedStepMatchesNative("post-validation-capture", status, raw);
	if (status.nextTransition?.execute?.operation !== "review.finalize") {
		throw new Error(`provider validation capture did not offer finalization, got ${summarizeDecoded(status.nextTransition)}`);
	}
	const finalizeTokens = executeTokens(status.nextTransition);
	if (!finalizeTokens.includes("--captured-evidence=true")) {
		throw new Error(`provider validation capture must finalize with --captured-evidence=true, got ${finalizeTokens.join(" ")}`);
	}
	const approvalFinalize = await cli.finalizeTransition({ cwd, argumentTokens: finalizeTokens });
	if (approvalFinalize.state !== "approved") throw new Error(`post-validation finalize state=${approvalFinalize.state}`);
	const burn = await assertTerminalApprovalBurn(binary, cli, cwd, sequencingLineageId, "sequencing lifecycle");
	return `offered step matched native at every hop through approval; plan -> fix -> evidence -> targeted validation -> ${burn}`;
}

// abandonLifecycle drives the audited abandon end-to-end through the real
// adapter runtime against the real binary: start an independent active medium
// lineage, abandon it with the adapter-built maintainer authorization, and confirm the native
// gate accepted the binding, committed a quarantine record, and no longer
// offers the lineage as live authority. RED-provable: the check asserts the
// adapter-built binding is exactly the nine-line
// gentle-ai.review-abandon-authorization/v2 discarded-work binding, so a
// v1-emitting builder (the drift class that escaped to a live Pi session)
// fails this check before the binary is even invoked - and would be refused
// by the native gate anyway.
async function abandonLifecycle(binary, cli, root) {
	const cwd = scratchRepo(root, "pi-abandon");
	write(cwd, "src/abandon.js", "export function retain(value) {\n  return value;\n}\n");
	commitAll(cwd, "feat: abandon authority");
	write(cwd, "src/abandon.js", "export function retain(value) {\n  return value;\n}\nexport function duplicate(value) {\n  return value + value;\n}\n");

	const active = await startActiveMediumLineage(binary, cli, cwd, "abandon lifecycle");
	const start = active.start;
	let raw = active.raw;
	let status;
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
	raw = rawStatus(binary, cwd, start.lineageId);
	status = await cli.targetStatus({ cwd, lineageId: start.lineageId });
	assertOfferedStepMatchesNative("post-abandon", status, raw);
	if (raw.authority !== null && raw.authority !== undefined) {
		throw new Error(`post-abandon status still reports live authority ${JSON.stringify(raw.authority)}`);
	}
	if (status.nextTransition?.execute?.operation !== "review.start") {
		throw new Error(`post-abandon expected a fresh review.start, got ${summarizeDecoded(status.nextTransition)}`);
	}
	return "independent active medium lineage used the adapter-built nine-line v2 binding; native quarantine record committed; post-abandon status offers only a fresh start before any terminal approval burn";
}

// A native approval burns its authority. This public-contract check proves a
// burned predecessor cannot seed live recovery after the workspace candidate
// changes; recovered-successor controller hydration remains unit-covered.
async function burnedPredecessorScopeIsolation(binary, cli, root) {
	const cwd = scratchRepo(root, "pi-burned-predecessor");
	write(cwd, "docs/recovery-contract.md", "# Recovery contract\n\nbase\n");
	write(cwd, "src/fresh-scope.js", "export function freshScope(value) {\n  return value;\n}\n");
	commitAll(cwd, "docs: recovery contract base");
	write(cwd, "docs/recovery-contract.md", "# Recovery contract\n\nbase\n\npassive predecessor update\n");

	let raw = rawStatus(binary, cwd);
	let status = await cli.targetStatus({ cwd });
	assertOfferedStepMatchesNative("burned predecessor: pre-start", status, raw);
	const predecessorTarget = status.targetIdentity;
	const start = await cli.start({ cwd, targetIdentity: predecessorTarget, projection: "workspace" });
	if (start.state !== "reviewing" || start.riskLevel !== "low") {
		throw new Error(`burned predecessor did not create a low reviewing lineage: ${JSON.stringify(start)}`);
	}
	raw = rawStatus(binary, cwd, start.lineageId);
	status = await cli.targetStatus({ cwd, lineageId: start.lineageId });
	assertOfferedStepMatchesNative("burned predecessor: pre-finalize", status, raw);
	if (status.nextTransition?.execute?.operation !== "review.finalize") {
		throw new Error(`burned predecessor expected review.finalize, got ${summarizeDecoded(status.nextTransition)}`);
	}
	const approved = await cli.finalizeTransition({ cwd, argumentTokens: executeTokens(status.nextTransition) });
	if (approved.state !== "approved") throw new Error(`burned predecessor finalize state=${approved.state}`);
	const burn = await assertTerminalApprovalBurn(binary, cli, cwd, approved.lineageId, "burned predecessor");

	write(cwd, "src/fresh-scope.js", "export function freshScope(value) {\n  return value;\n}\nexport function freshScopeTwice(value) {\n  return freshScope(value) + freshScope(value);\n}\n");
	const exactRaw = rawStatus(binary, cwd, approved.lineageId);
	const exactStatus = await cli.targetStatus({ cwd, lineageId: approved.lineageId });
	assertOfferedStepMatchesNative("burned predecessor: exact lineage after scope change", exactStatus, exactRaw);
	const freshRaw = rawStatus(binary, cwd);
	const freshStatus = await cli.targetStatus({ cwd });
	assertOfferedStepMatchesNative("burned predecessor: selectorless fresh candidate", freshStatus, freshRaw);
	if (freshStatus.targetIdentity === predecessorTarget || freshStatus.nextTransition?.execute?.operation !== "review.start") {
		throw new Error(`scope change did not expose a distinct fresh review.start candidate: ${summarizeDecoded(freshStatus.nextTransition)}`);
	}
	for (const [label, document] of [["exact", exactRaw], ["decoded exact", exactStatus], ["fresh", freshRaw], ["decoded fresh", freshStatus]]) {
		if (document.authority !== undefined && document.authority !== null) {
			throw new Error(`${label} STATUS derived live authority from burned predecessor ${JSON.stringify(document.authority)}`);
		}
		for (const key of ["recovery", "recovery_disposition", "recoveryDisposition", "successor", "successor_lineage", "successorLineage", "recovered_successor", "recoveredSuccessor"]) {
			if (document[key] !== undefined && document[key] !== null) {
				throw new Error(`${label} STATUS derived ${key} from burned predecessor: ${JSON.stringify(document[key])}`);
			}
		}
	}
	return `native approval -> ${burn}; after scope mutation, exact burned-lineage STATUS and selectorless fresh-candidate STATUS expose no live authority, recovery disposition, or successor. Recovered-successor controller hydration remains unit-covered; live cross-lane no longer assumes durable approved authority`;
}

// correctedLifecycleThroughAdapter drives a medium candidate through the
// controller's corrected-candidate binding, then follows the provider-owned
// validation role vector and finalization transition to a burned approval.
async function correctedLifecycleThroughAdapter(binary, root, fakePi) {
	const { createNativeReviewCli } = await import("../../lib/native-review-cli.ts");
	const cli = piDirectCli(createNativeReviewCli(undefined, binary));
	const cwd = scratchRepo(root, "pi-corrected");
	const base = "export function parsePath(input) {\n  return input.split(\"/\");\n}\n";
	write(cwd, "src/parse.js", base);
	commitAll(cwd, "feat: parse");
	// The intentional reliability defect: the last component is omitted.
	write(cwd, "src/parse.js", `${base}export function lastComponent(input) {\n  const parts = input.split("/");\n  return parts[parts.length - 2];\n}\n`);

	const registry = new CandidateViewRegistry();
	const context = { cwd, hasUI: false, ui: { confirm: async () => true, notify: () => {} } };
	// The real tool is used, not the bare entry point: the pending-consent map
	// lives for the tool's lifetime, so START and ANSWER-CONSENT share it.
	const { createGentleAiExtension } = await import("../../extensions/gentle-ai.ts");
	const tools = new Map();
	createGentleAiExtension({ nativeReviewCli: cli, candidateViews: registry })({
		on() {}, registerTool(definition) { tools.set(definition.name, definition); }, registerCommand() {},
	});
	const tool = tools.get("gentle_review");
	let call = 0;
	const controller = async (parameters) => (await tool.execute(`corrected-${call++}`, parameters, undefined, undefined, context)).details;
	let boundLineageId;
	try {
		// START through the controller so this session holds the START-time
		// immutable reviewer view — the state the defect needs.
		let envelope = await controller({ operation: "start", input: JSON.stringify({ mode: "ordinary" }) });
		if (envelope.consent_binding === undefined) throw new Error(`medium START did not surface consent: ${String(envelope.outcome ?? envelope.status)}`);
		envelope = await controller({ operation: "answer-consent", input: JSON.stringify({ consentBinding: envelope.consent_binding, answer: "granted" }) });
		const lineageId = envelope.result?.lineage_id;
		boundLineageId = lineageId;
		if (envelope.result?.state !== "reviewing" || lineageId === undefined) throw new Error(`granted START state=${String(envelope.result?.state)}`);
		if (!registry.hasCurrentBinding()) throw new Error("START did not bind the immutable reviewer view for this session");
		const startTree = rawStatus(binary, cwd, lineageId).projection.current_candidate_tree;

		// Reviewer slot: one deterministic candidate-caused BLOCKER.
		let raw = rawStatus(binary, cwd, lineageId);
		let slot = raw.next_transition?.collect?.inputs?.[0];
		if (slot?.capture_operation !== "review.capture-result") throw new Error(`expected review.capture-result, got ${summarizeRaw(raw.next_transition)}`);
		let args = rawArgumentValues(slot);
		const reviewerFile = join(root, "pi-corrected-reviewer.json");
		writeFileSync(reviewerFile, JSON.stringify({
			subject_hash: args["subject-hash"],
			inspection: { status: "completed", paths: ["src/parse.js"] },
			evidence: ["lastComponent indexes parts.length - 2 and omits the last component; introduced by the candidate hunk"],
			findings: [{
				claim: "lastComponent returns the second-to-last path component instead of the last",
				severity: "BLOCKER",
				evidence_class: "deterministic",
				causal_disposition: "introduced",
				lens: args.lens,
				location: "src/parse.js:6",
				proof_refs: ["src/parse.js:4-7 indexes parts.length - 2 in the candidate tree"],
			}],
		}));
		rawInvoke(binary, cwd, ["review", "capture-result", "--lineage", args.lineage, "--expected-revision", args["expected-revision"],
			"--target", args.target, "--repository-context", args["repository-context"], "--lens", args.lens,
			"--order", args.order, "--subject-hash", args["subject-hash"], "--input", reviewerFile]);

		envelope = await controller({ operation: "finalize", lineageId, input: JSON.stringify({}) });
		if (envelope.result?.state !== "correction_required") throw new Error(`finalize after capture state=${String(envelope.result?.state ?? envelope.outcome)}`);

		// Bounded correction: forecast BEFORE editing, then the edit.
		raw = rawStatus(binary, cwd, lineageId);
		const planInput = raw.next_transition?.collect?.inputs?.[0];
		if (planInput?.capture_operation !== "external.plan_correction") throw new Error(`expected external.plan_correction, got ${summarizeRaw(raw.next_transition)}`);
		const bounds = planInput.submission?.values?.[0] ?? {};
		envelope = await controller({ operation: "finalize", lineageId, input: JSON.stringify({ correction_line_forecast: bounds.minimum ?? 1 }) });
		if (envelope.result?.state !== "correction_required") throw new Error(`correction forecast rejected: ${JSON.stringify(envelope.diagnostics ?? envelope.outcome)}`);
		write(cwd, "src/parse.js", `${base}export function lastComponent(input) {\n  const parts = input.split("/");\n  return parts[parts.length - 1];\n}\n`);
		const correctedTree = rawStatus(binary, cwd, lineageId).projection.current_candidate_tree;
		if (correctedTree === startTree) throw new Error("the correction did not move the candidate identity");

		// THE REGRESSION PROBE: a FINALIZE that just follows the provider
		// transition carries no documents. Whatever the provider answers is
		// fine; what must never come back is adapter-side reviewer-view drift.
		envelope = await controller({ operation: "finalize", lineageId, input: JSON.stringify({}) });
		if (envelope.diagnostics?.code === "candidate-target-projection-drift") {
			throw new Error("document-free FINALIZE on the corrected candidate still reports candidate-target-projection-drift");
		}

		// Correction evidence enters through the controller. The provider then owns
		// the entire validation path: exact role tokens, Go-owned capture, fresh
		// exact-lineage STATUS, and its captured-evidence finalization vector.
		envelope = await controller({ operation: "finalize", lineageId, input: JSON.stringify({ final_evidence: "node --check src/parse.js passed; lastComponent now returns the final component", final_verification_passed: true }) });
		if (envelope.diagnostics?.code === "candidate-target-projection-drift") throw new Error("evidence FINALIZE reported candidate-target-projection-drift");
		raw = rawStatus(binary, cwd, lineageId);
		let status = await cli.targetStatus({ cwd, lineageId });
		assertOfferedStepMatchesNative("corrected lifecycle: targeted validation", status, raw);
		const validationInput = status.nextTransition?.collect?.inputs?.[0];
		await captureTargetedValidation(
			fakePi,
			cli,
			cwd,
			validationInput,
			status.validationRequest,
			lineageId,
			"corrected targeted validation",
			"frozen correction tree returns parts[parts.length - 1]",
			"parsePath is untouched by the correction diff",
		);
		raw = rawStatus(binary, cwd, lineageId);
		status = await cli.targetStatus({ cwd, lineageId });
		assertOfferedStepMatchesNative("corrected lifecycle: post-validation capture", status, raw);
		if (status.nextTransition?.execute?.operation !== "review.finalize") {
			throw new Error(`corrected validation capture did not offer finalization, got ${summarizeDecoded(status.nextTransition)}`);
		}
		const finalizeTokens = executeTokens(status.nextTransition);
		if (!finalizeTokens.includes("--captured-evidence=true")) {
			throw new Error(`corrected validation capture must finalize with --captured-evidence=true, got ${finalizeTokens.join(" ")}`);
		}
		const approved = await cli.finalizeTransition({ cwd, argumentTokens: finalizeTokens });
		if (approved.state !== "approved") throw new Error(`corrected lineage ended at ${approved.state} instead of approved`);
		const burn = await assertTerminalApprovalBurn(binary, cli, cwd, lineageId, "corrected lifecycle");
		return `medium candidate driven through the adapter: BLOCKER detected -> bounded correction -> document-free provider-transition FINALIZE with no candidate-target-projection-drift -> correction evidence -> Go-owned targeted validation -> ${burn}`;
	} finally {
		// Candidate views are materialized read-only; leaving one behind makes
		// the battery's own root cleanup fail with EACCES.
		const resolvers = [
			() => registry.resolveCurrentForLens("review-reliability"),
			...(boundLineageId === undefined ? [] : [() => registry.resolveForFinalize(boundLineageId)]),
		];
		for (const resolve of resolvers) {
			try { registry.cleanup(resolve().token); } catch { /* nothing bound to clean */ }
		}
	}
}

async function modelReview(binary, cli, cwd, lineageId) {
	const raw = rawStatus(binary, cwd, lineageId);
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

// Candidate views are materialized read-only, so a leaked one makes a plain
// rmSync fail with EACCES — and losing the battery's results table to a scratch
// permission is worse than leaving bytes in /tmp. Make everything writable
// first, then remove, and never let cleanup mask the run's outcome.
function removeScratchRoot(root) {
	const makeWritable = (path) => {
		let entry;
		try { entry = statSync(path); } catch { return; }
		try { chmodSync(path, entry.isDirectory() ? 0o700 : 0o600); } catch { /* best effort */ }
		if (!entry.isDirectory()) return;
		let children = [];
		try { children = readdirSync(path); } catch { return; }
		for (const child of children) makeWritable(join(path, child));
	};
	makeWritable(root);
	try {
		rmSync(root, { recursive: true, force: true });
	} catch (error) {
		return { removed: false, reason: error.code ?? "unknown" };
	}
	return { removed: !existsSync(root) };
}

// --- driver ---

async function main() {
	const originalEnvironment = snapshotProcessEnvironment();
	let binary;
	let root;
	let sandbox;
	let modeRepo;
	let fakePi;
	let cleanup = {
		fakePiInvocations: 0,
		initialRddMode: undefined,
		enabledRddMode: undefined,
		finalRddMode: undefined,
		fakePiRestoreError: undefined,
		rddModeError: undefined,
		environmentRestored: false,
		environmentRestoreError: undefined,
		rootRemoved: false,
		reason: undefined,
	};
	try {
		// Resolution deliberately happens before HOME/XDG are replaced: a registered
		// dev binary may live in the caller's Pi config, but every lifecycle state
		// below belongs only to the battery-owned sandbox.
		binary = resolveBatteryBinary();
		console.log(`cross-lane battery (Pi direct lane)`);
		console.log(`binary: ${binary}`);
		root = mkdtempSync(join(tmpdir(), "gentle-pi-crosslane-"));
		sandbox = configureSandboxEnvironment(root);
		modeRepo = scratchRepo(root, "rdd-mode");
		const initialRdd = sandboxReviewModeStatus(binary, modeRepo, "off", "default", "initial");
		cleanup.initialRddMode = `${initialRdd.effective}/${initialRdd.source}`;
		enableSandboxReviewMode(binary, modeRepo);
		const enabledRdd = sandboxReviewModeStatus(binary, modeRepo, "on", "global", "after sandbox enable");
		cleanup.enabledRddMode = `${enabledRdd.effective}/${enabledRdd.source}`;
		fakePi = installFakePi(root);
		const cli = piDirectCli(createNativeReviewCli(undefined, binary));

		// Capture one live capabilities envelope for the freshness lane.
		rawInvoke(binary, root, ["review", "capabilities", "--contract", CONTRACT]);

		try {
			pass("low lifecycle terminal approval burn and unmanaged gate", await lowLifecycle(binary, cli, root));
		} catch (error) {
			fail("low lifecycle terminal approval burn and unmanaged gate", knownRedParity(describeError(error)));
		}

		let mediumRepo;
		try {
			const outcome = await mediumConsent(binary, cli, root);
			mediumRepo = outcome;
			pass("medium consent/v3 granted round-trip", outcome.note);
		} catch (error) {
			fail("medium consent/v3 granted round-trip", describeError(error));
		}

		try {
			pass("sequencing lifecycle through approval burn", await sequencingLifecycle(binary, cli, root, fakePi));
		} catch (error) {
			fail("sequencing lifecycle through approval burn", knownRedParity(describeError(error)));
		}

		try {
			pass("audited abandon end-to-end (v2 discarded-work binding)", await abandonLifecycle(binary, cli, root));
		} catch (error) {
			fail("audited abandon end-to-end (v2 discarded-work binding)", knownRedParity(describeError(error)));
		}

		try {
			pass("burned predecessor exposes only fresh scope", await burnedPredecessorScopeIsolation(binary, cli, root));
		} catch (error) {
			fail("burned predecessor exposes only fresh scope", knownRedParity(describeError(error)));
		}

		try {
			pass("corrected lifecycle through adapter terminal approval burn", await correctedLifecycleThroughAdapter(binary, root, fakePi));
		} catch (error) {
			fail("corrected lifecycle through adapter terminal approval burn", knownRedParity(describeError(error)));
		}

		if (WITH_MODEL && mediumRepo !== undefined) {
			try {
				pass("medium reviewer model run (pi)", await modelReview(binary, cli, mediumRepo.cwd, mediumRepo.lineageId));
			} catch (error) {
				fail("medium reviewer model run (pi)", describeError(error));
			}
		} else {
			skip("medium reviewer model run (pi)", "pass --with-model to run the Go-owned pi reviewer (model spend)");
		}

		decoderFreshness(binary);
		const fakePiInvocations = fakePi.invocationCount();
		if (fakePiInvocations !== 2) {
			fail("fake Pi targeted-validator isolation", `expected two Go-owned validator invocations, observed ${fakePiInvocations}`);
		} else {
			pass("fake Pi targeted-validator isolation", "two Go-owned review.capture-validation --execute=true invocations consumed only per-call dynamic JSON; no --with-model");
		}
	} finally {
		if (fakePi !== undefined) {
			cleanup.fakePiInvocations = fakePi.invocationCount();
			try {
				fakePi.restore();
			} catch (error) {
				cleanup.fakePiRestoreError = describeError(error);
			}
		}
		if (sandbox !== undefined && modeRepo !== undefined && binary !== undefined) {
			try {
				const finalRdd = sandboxReviewModeStatus(binary, modeRepo, "on", "global", "final sandbox status");
				cleanup.finalRddMode = `${finalRdd.effective}/${finalRdd.source}`;
			} catch (error) {
				cleanup.rddModeError = describeError(error);
			}
		}
		try {
			restoreProcessEnvironment(originalEnvironment);
			cleanup.environmentRestored = processEnvironmentMatches(originalEnvironment);
			if (!cleanup.environmentRestored) cleanup.environmentRestoreError = "restored environment did not exactly match the original snapshot";
		} catch (error) {
			cleanup.environmentRestoreError = describeError(error);
		} finally {
			if (root !== undefined) {
				const removed = removeScratchRoot(root);
				cleanup.rootRemoved = removed.removed;
				cleanup.reason = removed.reason;
			}
		}
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
	console.log(`cleanup: fake Pi invocations=${cleanup.fakePiInvocations}; sandbox RDD initial=${cleanup.initialRddMode ?? "unverified"}; enabled=${cleanup.enabledRddMode ?? "unverified"}; final=${cleanup.finalRddMode ?? "unverified"}; process environment restored=${cleanup.environmentRestored}; scratch root removed=${cleanup.rootRemoved}; auto-spools unread=0 undeleted=0 (none are battery-owned)`);
	if (cleanup.fakePiRestoreError !== undefined) {
		console.log(`cleanup failure: fake Pi environment restore failed (${cleanup.fakePiRestoreError})`);
		failed += 1;
	}
	if (cleanup.rddModeError !== undefined) {
		console.log(`cleanup failure: sandbox RDD verification failed (${cleanup.rddModeError})`);
		failed += 1;
	}
	if (!cleanup.environmentRestored) {
		console.log(`cleanup failure: original process environment was not restored (${cleanup.environmentRestoreError ?? "unknown"})`);
		failed += 1;
	}
	if (!cleanup.rootRemoved) {
		console.log(`cleanup failure: owned scratch root remains (${cleanup.reason ?? "unknown"})`);
		failed += 1;
	}
	if (failed > 0) process.exitCode = 1;
}

await main();
