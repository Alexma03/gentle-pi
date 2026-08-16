#!/usr/bin/env node
// Maintainer provider-relay matrix (gentle-pi#311, first direct work unit).
//
// Read-only maintainer harness driving the REAL Pi host relay
// (lib/review-host-relay.ts#runReviewHostRelaySlot) through explicit
// maintainer runtime descriptors. Validates an EXACT descriptor shape, uses
// ONLY declared executables (never re-resolves the production binary), and
// emits one machine-readable NDJSON verdict per case. Not a production path:
// `pnpm test` never imports it; `pnpm run test:maintainer` runs the tests;
// the CLI is the entry point the separate verifier uses for the real organic
// positive journey after a user-visible forecast.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { REVIEW_HOST_RELAY_FAILURE, ReviewHostRelayError, classifyReviewHostRelayRefusal, resolveReviewHostRelaySubmission, runReviewHostRelaySlot } from "../../lib/review-host-relay.ts";
import { GENTLE_PI_REVIEW_RELAY_CONTRACT, GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV } from "../../lib/review-relay-contract.ts";
export const DESCRIPTOR_SCHEMA = "gentle-pi.maintainer.provider-relay-descriptor/v1";
export const CASE_KINDS = Object.freeze(["relay-unavailable", "positive-lens", "provider-role-refuter", "provider-role-validator"]);
// gentle-pi#311 P7 — the two organic provider-role vectors that remain. Unlike
// the lens capture-result slots, these are SELF-CONTAINED: the provider renders
// binding tokens plus `--agent=pi --execute=true` (no submission descriptor),
// and executing the exact rendered invocation makes Go materialize the role
// prompt, spawn its own locked-down pi subprocess, and admit the raw verdict.
// The host runs one CLI invocation verbatim; it never materializes, launches
// pi, or submits anything for these slots.
export const PROVIDER_ROLE_VECTOR_KINDS = Object.freeze(["provider-role-refuter", "provider-role-validator"]);
export const PROVIDER_ROLE_VECTOR_VERB = Object.freeze({ "provider-role-refuter": "capture-refuter", "provider-role-validator": "capture-validation" });
export const PROVIDER_ROLE_VECTOR_ROLE = Object.freeze({ "provider-role-refuter": "refuter", "provider-role-validator": "targeted-validator" });
export const PROVIDER_ROLE_CAPTURE_ARTIFACT_SCHEMA = "gentle-ai.review-provider-role-capture/v1";
export const ROLE_VECTOR_FAILURE = Object.freeze({
	ROLE_SURFACE_UNAVAILABLE: "role-surface-unavailable",
	ROLE_LAUNCH_FAILED: "role-launch-failed",
	ROLE_FAILED: "role-failed",
	EMPTY_ARTIFACT: "empty-artifact",
	HANDSHAKE_REFUSED: "handshake-refused",
});
const REQUEST_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const RCTX_RE = /^rctx1_[0-9a-f]{64}$/;
// Stale-target fail-closed: the provider-returned binding tokens are the
// sole authority for lineage and target identity. Each must appear exactly
// once; the matrix later compares the returned artifact against these values.
const ROLE_BINDING_RE = Object.freeze({ "--lineage=": /^.+$/, "--expected-revision=": REQUEST_HASH_RE, "--target=": REQUEST_HASH_RE, "--repository-context=": RCTX_RE });
const DEFAULT_ROLE_VECTOR_TIMEOUT_MS = 600_000;
export class ProviderRoleVectorError extends Error {
	kind;
	stage;
	exitCode;
	stderr;
	timedOut;
	mutationOutcome;
	// "none" until the role invocation launches Go's role work; a launched
	// role whose outcome could not be read is "unknown" and the caller
	// re-queries negotiated STATUS, never through a blind retry.
	constructor(kind, stage, message, details) {
		super(message);
		this.name = "ProviderRoleVectorError";
		this.kind = kind;
		this.stage = stage;
		this.exitCode = details?.exitCode ?? null;
		this.stderr = details?.stderr ?? "";
		this.timedOut = details?.timedOut ?? false;
		this.mutationOutcome = kind === ROLE_VECTOR_FAILURE.ROLE_FAILED ? "unknown" : "none";
	}
}
// The positive lens runs only when explicitly armed: the organic journey
// needs a real capable binary, a real pi, and a real review session. Without
// the arm the runner blocks the positive leg before materialize.
export const ARM_POSITIVE_ENV = "GENTLE_PI_MAINTAINER_ARM_POSITIVE";
export const POSITIVE_JOURNEY_COMMAND =
	"GENTLE_PI_MAINTAINER_ARM_POSITIVE=1 node --experimental-strip-types scripts/maintainer/provider-relay-matrix.mjs --descriptor <descriptor.json>  # needs a real capable gentle-ai binary + real pi on PATH + real binding tokens from a live review session (gentle-ai review status --next-transition)";
export class DescriptorValidationError extends Error {
	constructor(message) {
		super(message);
		this.name = "DescriptorValidationError";
	}
}
const isObj = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isStr = (value) => typeof value === "string" && value.length > 0;
const isStrArr = (value) => Array.isArray(value) && value.length > 0 && value.every(isStr);
const fail = (message) => {
	throw new DescriptorValidationError(message);
};
// Reject any key outside an exact allowed set; keeps the descriptor shape
// strict so a maintainer cannot smuggle production overrides through it.
const exactKeys = (obj, allowed, label) => {
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) fail(`${label}.${key} is not allowed; exact shape is {${[...allowed].join(",")}}`);
	}
};
// Strict, exact-shape descriptor validation: no defaults, no production
// resolution. The submission is validated through the REAL relay resolver so
// the completing form is provably bindable before any process launches.
export function validateDescriptor(value) {
	if (!isObj(value)) fail("descriptor must be a JSON object");
	exactKeys(value, new Set(["schema", "gentleAiExecutable", "piExecutable", "cases"]), "descriptor");
	if (value.schema !== DESCRIPTOR_SCHEMA) fail(`descriptor.schema must be exactly "${DESCRIPTOR_SCHEMA}"`);
	if (!isStr(value.gentleAiExecutable) || !isAbsolute(value.gentleAiExecutable)) fail("descriptor.gentleAiExecutable must be a non-empty absolute path; the runner never re-resolves the production binary");
	if (!isStr(value.piExecutable)) fail("descriptor.piExecutable must be a non-empty string");
	if (!Array.isArray(value.cases) || value.cases.length === 0) fail("descriptor.cases must be a non-empty array");
	const seen = new Set();
	return { schema: value.schema, gentleAiExecutable: value.gentleAiExecutable, piExecutable: value.piExecutable, cases: value.cases.map((entry, index) => {
			if (!isObj(entry)) fail(`descriptor.cases[${index}] must be an object`);
			if (!isStr(entry.name)) fail(`descriptor.cases[${index}].name must be a non-empty string`);
			if (seen.has(entry.name)) fail(`descriptor.cases[${index}].name "${entry.name}" is duplicated`);
			seen.add(entry.name);
			if (!CASE_KINDS.includes(entry.kind)) fail(`descriptor.cases[${index}].kind must be one of ${JSON.stringify([...CASE_KINDS])}`);
			if (entry.kind === "provider-role-refuter" || entry.kind === "provider-role-validator") {
				return validateRoleCaseEntry(entry, index);
			}
			exactKeys(entry, new Set(["name", "kind", "captureArgumentTokens", "submission"]), `descriptor.cases[${index}]`);
			if (!isStrArr(entry.captureArgumentTokens)) fail(`descriptor.cases[${index}].captureArgumentTokens must be a non-empty array of non-empty strings`);
			// A real host-relay materialize slot is the provider-issued
			// --agent=pi --materialize=true pair; the descriptor must declare
			// exactly that so the negative control exercises the unknown-flag
			// refusal and the positive leg exercises the real surface.
			for (const required of ["--agent=pi", "--materialize=true"]) {
				if (!entry.captureArgumentTokens.includes(required)) fail(`descriptor.cases[${index}].captureArgumentTokens must include the provider-issued "${required}" token`);
			}
			const submission = entry.submission;
			if (!isObj(submission)) fail(`descriptor.cases[${index}].submission must be an object; a materialize slot without a provider submission is a contract mismatch, never synthesized`);
			exactKeys(submission, new Set(["operationToken", "argumentTokens", "values"]), `descriptor.cases[${index}].submission`);
			if (!isStr(submission.operationToken)) fail(`descriptor.cases[${index}].submission.operationToken must be a non-empty string`);
			if (!isStrArr(submission.argumentTokens)) fail(`descriptor.cases[${index}].submission.argumentTokens must be a non-empty array of non-empty strings`);
			if (!Array.isArray(submission.values) || submission.values.length === 0 || !submission.values.every(isObj)) {
				fail(`descriptor.cases[${index}].submission.values must be a non-empty array of objects`);
			}
			for (const [vi, ve] of submission.values.entries()) {
				exactKeys(ve, new Set(["slot", "domain", "substitutionLocation"]), `descriptor.cases[${index}].submission.values[${vi}]`);
				if (!isStr(ve.slot) || !isStr(ve.domain)) fail(`descriptor.cases[${index}].submission.values[${vi}] must have non-empty string slot and domain`);
			}
			// Delegate binding semantics (count, substitution location, the
			// {{value}} slot) to the REAL relay resolver so they never drift.
			try {
				resolveReviewHostRelaySubmission({
					operationToken: submission.operationToken,
					argumentTokens: submission.argumentTokens,
					values: submission.values.map((ve) => ({ slot: ve.slot, domain: ve.domain, substitutionLocation: ve.substitutionLocation })),
				});
			} catch (error) {
				fail(`descriptor.cases[${index}].submission is not a bindable provider form: ${error instanceof Error ? error.message : String(error)}`);
			}
			return { name: entry.name, kind: entry.kind, captureArgumentTokens: [...entry.captureArgumentTokens], submission: { operationToken: submission.operationToken, argumentTokens: [...submission.argumentTokens], values: submission.values.map((ve) => ({ ...ve })) } };
		}),
	};
}
// Validates one provider-role vector case. The descriptor carries the
// provider-returned argument tokens verbatim plus, for the targeted validator,
// a MINIMAL binding (schema + requestHash) extracted from the embedded
// validation_request — never the full provider descriptor. The matrix asserts
// the `--request-hash=<hash>` token in the argument vector matches that
// requestHash, preserving the provider request hash / validation request
// binding without reconstructing the role payload.
function validateRoleCaseEntry(entry, index) {
	const label = `descriptor.cases[${index}]`;
	const allowedKeys = new Set(["name", "kind", "argumentTokens", ...(entry.kind === "provider-role-validator" ? ["validationRequest"] : [])]);
	exactKeys(entry, allowedKeys, label);
	if (!isStrArr(entry.argumentTokens)) fail(`${label}.argumentTokens must be a non-empty array of non-empty strings`);
	// The provider-issued execute token pair is the self-contained vector
	// signature; --materialize=true would make this a lens slot, a contract
	// mismatch on a role vector.
	for (const required of ["--agent=pi", "--execute=true"]) {
		if (!entry.argumentTokens.includes(required)) fail(`${label}.argumentTokens must include the provider-issued "${required}" token`);
	}
	if (entry.argumentTokens.includes("--materialize=true")) {
		fail(`${label}.argumentTokens must not include --materialize=true; a role vector is self-contained, never a lens materialize slot`);
	}
	const bindings = {};
	for (const [prefix, pattern] of Object.entries(ROLE_BINDING_RE)) {
		const matches = entry.argumentTokens.filter((t) => t.startsWith(prefix));
		if (matches.length !== 1) fail(`${label}.argumentTokens must include exactly one "${prefix}" token, found ${matches.length}`);
		const value = matches[0].slice(prefix.length);
		if (!pattern.test(value)) fail(`${label}.argumentTokens "${prefix}" value is malformed`);
		bindings[prefix] = value;
	}
	const result = { name: entry.name, kind: entry.kind, argumentTokens: [...entry.argumentTokens], lineage: bindings["--lineage="], targetIdentity: bindings["--target="] };
	if (entry.kind === "provider-role-validator") {
		const vr = entry.validationRequest;
		if (!isObj(vr)) fail(`${label}.validationRequest must be an object; the provider-embedded validation_request binding is required on the targeted-validator vector`);
		exactKeys(vr, new Set(["schema", "requestHash"]), `${label}.validationRequest`);
		if (vr.schema !== "gentle-ai.review-targeted-validation-request/v1") fail(`${label}.validationRequest.schema must be exactly "gentle-ai.review-targeted-validation-request/v1"`);
		if (!isStr(vr.requestHash) || !REQUEST_HASH_RE.test(vr.requestHash)) fail(`${label}.validationRequest.requestHash must be a sha256 digest`);
		const expectedToken = `--request-hash=${vr.requestHash}`;
		if (!entry.argumentTokens.includes(expectedToken)) {
			fail(`${label}.argumentTokens must include the provider-issued "${expectedToken}" token that binds the embedded validation_request`);
		}
		result.validationRequest = { schema: vr.schema, requestHash: vr.requestHash };
	}
	return Object.freeze(result);
}
export function loadDescriptor(path) {
	if (!isStr(path)) fail("a descriptor path is required");
	let raw, parsed;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		fail(`could not read descriptor at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		fail(`descriptor at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return validateDescriptor(parsed);
}
// Resolves a declared executable without a shell: absolute path checked
// verbatim, bare name searched on PATH. Never re-resolves production. PATH
// matches are normalized to absolute paths (a relative component like `.`
// must not yield a relative candidate; the relay launches from scratch).
export function resolveDeclaredExecutable(executable) {
	if (isAbsolute(executable)) return existsSync(executable) && statSync(executable).isFile() ? executable : null;
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = resolve(directory, executable);
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return null;
}
const missingReason = (executable, label) => `${label} "${executable}" is not an existing executable; arm the descriptor with a real binary, or set GENTLE_PI_REQUIRE_MAINTAINER=1 to fail instead of block.`;
// A guaranteed-nonexistent pi path inside a fresh private directory. mkdtemp
// picks an unpredictable name and 0700 keeps it ours, so nothing can race a
// file into the slot between the mkdtemp and the spawn.
function unlaunchablePi() {
	const directory = mkdtempSync(join(tmpdir(), "gentle-pi-maintainer-no-pi-"));
	chmodSync(directory, 0o700);
	return { directory, executable: join(directory, "pi-must-never-launch") };
}
// Default role vector runner: spawns `gentle-ai review <verb> <tokens>` once,
// in the foreground, with the relay handshake environment. Go materializes the
// role prompt, spawns its own locked-down pi subprocess, and admits the raw
// verdict; the host runs one CLI invocation verbatim and decodes the typed
// artifact. Model/provider/profile stay user-owned: no --model/--provider is
// added, and the pi subprocess environment is exactly the user's own.
export async function runProviderRoleVector(request) {
	const verb = PROVIDER_ROLE_VECTOR_VERB[request.kind];
	if (verb === undefined) throw new TypeError(`runProviderRoleVector received an unknown role vector kind: ${request.kind}`);
	const argv = ["review", verb, ...request.argumentTokens];
	const env = { ...process.env, [GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV]: GENTLE_PI_REVIEW_RELAY_CONTRACT };
	let capture;
	try {
		capture = await new Promise((resolve, reject) => {
			const child = spawn(request.gentleAiExecutable, argv, {
				cwd: process.cwd(),
				env,
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
				windowsHide: true,
				...(request.signal === undefined ? {} : { signal: request.signal }),
			});
			const stdout = [];
			const stderr = [];
			let timedOut = false;
			let settled = false;
			const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, request.timeoutMs ?? DEFAULT_ROLE_VECTOR_TIMEOUT_MS);
			timer.unref();
			child.stdout.on("data", (chunk) => stdout.push(chunk));
			child.stderr.on("data", (chunk) => stderr.push(chunk));
			child.on("error", (error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); });
			child.on("close", (code) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code, timedOut }); });
		});
	} catch (error) {
		throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_LAUNCH_FAILED, "launch", `gentle-ai role vector could not start: ${error instanceof Error ? error.message : String(error)}`);
	}
	const stderrText = capture.stderr.toString("utf8");
	if (capture.exitCode !== 0 || capture.timedOut) {
		const refusal = classifyReviewHostRelayRefusal(stderrText);
		if (refusal === "handshake") {
			throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.HANDSHAKE_REFUSED, "execute", stderrText, { exitCode: capture.exitCode, stderr: stderrText, timedOut: capture.timedOut });
		}
		if (refusal === "unknown-flag") {
			throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_SURFACE_UNAVAILABLE, "execute", "the declared gentle-ai binary lacks the provider role capture surface", { exitCode: capture.exitCode, stderr: stderrText, timedOut: capture.timedOut });
		}
		throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_FAILED, "execute", "gentle-ai role vector failed", { exitCode: capture.exitCode, stderr: stderrText, timedOut: capture.timedOut });
	}
	if (capture.stdout.length === 0) {
		throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.EMPTY_ARTIFACT, "execute", "gentle-ai role vector produced no artifact bytes", { exitCode: 0, stderr: stderrText });
	}
	let artifact;
	try {
		artifact = JSON.parse(capture.stdout.toString("utf8"));
	} catch (error) {
		throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_FAILED, "execute", `gentle-ai role vector returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { exitCode: 0, stderr: stderrText });
	}
	const expectedRole = PROVIDER_ROLE_VECTOR_ROLE[request.kind];
	if (!isObj(artifact) || artifact.schema !== PROVIDER_ROLE_CAPTURE_ARTIFACT_SCHEMA || artifact.role !== expectedRole || artifact.captured !== true) {
		throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_FAILED, "execute", "gentle-ai role vector returned an artifact that does not match the expected typed shape", { exitCode: 0, stderr: stderrText });
	}
	return { schema: artifact.schema, lineageId: artifact.lineage_id, targetIdentity: artifact.target_identity, role: artifact.role, captured: true };
}
// Runs the matrix against the REAL relay. A case that cannot run honestly is
// `blocked` (never `pass`); `fail` is an armed case whose outcome mismatched.
export async function runMatrix(descriptor, options = {}) {
	const positiveArmed = options.armPositive ?? (process.env[ARM_POSITIVE_ENV] === "1");
	// Smallest test seam: an optional injected relay function. Defaults to
	// the real relay so production CLI behavior is identical when unset; tests
	// inject a fake to assert the exact resolved path reaches the boundary
	// without executing a real subprocess (platform-neutral #324 evidence).
	const relay = options.relay ?? runReviewHostRelaySlot;
	// Same seam for the role vectors: defaults to the real spawn so production
	// CLI behavior is identical when unset; tests inject a fake to assert the
	// exact kind/verb/tokens reach the boundary without launching a model.
	const roleRunner = options.roleRunner ?? runProviderRoleVector;
	const verdicts = [];
	for (const caseEntry of descriptor.cases) {
		const gentleAiPath = resolveDeclaredExecutable(descriptor.gentleAiExecutable);
		if (gentleAiPath === null) {
			verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "blocked", reason: missingReason(descriptor.gentleAiExecutable, "gentleAiExecutable") });
			continue;
		}
		// Provider-role vectors are self-contained --execute invocations: Go
		// materializes the role prompt, spawns its own locked-down pi, and
		// admits the raw verdict. Like the positive lens, they need a real
		// capable binary and an explicit arm; the runner never synthesizes a
		// provider result.
		if (caseEntry.kind === "provider-role-refuter" || caseEntry.kind === "provider-role-validator") {
			if (!positiveArmed) {
				verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "blocked", reason: `${caseEntry.kind} case is not explicitly armed; set ${ARM_POSITIVE_ENV}=1 with a real capable gentle-ai binary, a real pi, and a real review session (real binding tokens from \`gentle-ai review status --next-transition\`) to run the organic role vector. The runner never synthesizes a provider verdict.`, command: POSITIVE_JOURNEY_COMMAND });
				continue;
			}
			try {
				const artifact = await roleRunner({ kind: caseEntry.kind, argumentTokens: caseEntry.argumentTokens, gentleAiExecutable: gentleAiPath, ...(caseEntry.validationRequest === undefined ? {} : { validationRequest: caseEntry.validationRequest }), ...(options.signal === undefined ? {} : { signal: options.signal }) });
				if (artifact.lineageId !== caseEntry.lineage || artifact.targetIdentity !== caseEntry.targetIdentity) {
					throw new ProviderRoleVectorError(ROLE_VECTOR_FAILURE.ROLE_FAILED, "execute", `role vector returned a stale artifact: expected lineage=${caseEntry.lineage} target=${caseEntry.targetIdentity}, got lineage=${artifact.lineageId} target=${artifact.targetIdentity}`);
				}
				verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "pass", role: artifact.role, lineageId: artifact.lineageId, targetIdentity: artifact.targetIdentity, captured: artifact.captured });
			} catch (error) {
				if (error instanceof ProviderRoleVectorError) {
					if (error.kind === ROLE_VECTOR_FAILURE.ROLE_SURFACE_UNAVAILABLE || error.kind === ROLE_VECTOR_FAILURE.HANDSHAKE_REFUSED) {
						verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "blocked", stage: error.stage, mutationOutcome: error.mutationOutcome, reason: `the declared gentle-ai binary lacks the provider role capture surface: ${error.message}`, command: POSITIVE_JOURNEY_COMMAND });
					} else {
						verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "fail", reason: `role vector error kind=${error.kind} stage=${error.stage} mutationOutcome=${error.mutationOutcome}: ${error.message}`, stderr: error.stderr });
					}
				} else {
					verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "fail", reason: `unexpected non-role error: ${error instanceof Error ? error.message : String(error)}` });
				}
			}
			continue;
		}
		// The positive lens needs a real pi AND an explicit arm; the negative
		// control never launches pi (fails closed at materialize). The precheck
		// resolves the declared Pi executable ONCE and reuses that exact
		// concrete path for launch; a bare declaration is never re-resolved
		// between precheck and spawn, so the relay launches exactly the
		// executable the harness checked (issue #324).
		let piPath = null;
		if (caseEntry.kind === "positive-lens") {
			piPath = resolveDeclaredExecutable(descriptor.piExecutable);
			if (piPath === null) {
				verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "blocked", reason: missingReason(descriptor.piExecutable, "piExecutable"), command: POSITIVE_JOURNEY_COMMAND });
				continue;
			}
			if (!positiveArmed) {
				verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "blocked", reason: `positive-lens case is not explicitly armed; set ${ARM_POSITIVE_ENV}=1 with a real capable gentle-ai binary, a real pi, and a real review session (real binding tokens from \`gentle-ai review status --next-transition\`) to run the organic journey. The runner never synthesizes a provider result.`, command: POSITIVE_JOURNEY_COMMAND });
				continue;
			}
		}
		// `relay-unavailable` is a NEGATIVE CONTROL: it must never launch pi and
		// never submit. The maintainer-declared `kind` is not evidence that the
		// declared binary is actually incapable, so the arm gate cannot key off
		// the declaration alone. Pointed at a mis-declared CAPABLE binary, a
		// declaration-only gate materializes, runs a REAL pi model, and executes
		// a REAL `capture-result --input=...` submission, and only then reports
		// `fail` — the mutation already happened. So give the negative control a
		// pi that cannot exist: an incapable binary still classifies
		// relay-unavailable at materialize (the control stays genuine, since it
		// never reached pi anyway), while a capable one fails closed at the pi
		// stage as kind=pi-launch-failed stage=pi mutationOutcome=none, with
		// zero pi launch and zero submission.
		const negativeControl = caseEntry.kind === "relay-unavailable" ? unlaunchablePi() : null;
		const request = { captureArgumentTokens: caseEntry.captureArgumentTokens, submission: caseEntry.submission, gentleAiExecutable: gentleAiPath, piExecutable: negativeControl === null ? piPath : negativeControl.executable, ...(options.signal === undefined ? {} : { signal: options.signal }) };
		try {
			const result = await relay(request);
			if (caseEntry.kind === "relay-unavailable") {
				verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "fail", reason: "expected relay-unavailable (runtime without --materialize) but the relay succeeded; the descriptor's binary is unexpectedly capable" });
			} else {
				verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "pass", promptByteLength: result.promptByteLength, resultByteLength: result.resultByteLength, submissionByteLength: result.submission.length });
			}
		} catch (error) {
			if (error instanceof ReviewHostRelayError) {
				if (caseEntry.kind === "relay-unavailable") {
					if (error.kind === REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE && error.stage === "materialize" && error.mutationOutcome === "none") {
						verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "pass", stage: error.stage, mutationOutcome: error.mutationOutcome, reason: REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE });
					} else {
						verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "fail", reason: `expected relay-unavailable at materialize with zero mutation, got kind=${error.kind} stage=${error.stage} mutationOutcome=${error.mutationOutcome}`, stderr: error.stderr });
					}
				} else if (error.kind === REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE) {
					verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "blocked", stage: error.stage, reason: `the declared gentle-ai binary lacks the pi host relay surface: ${error.message}`, command: POSITIVE_JOURNEY_COMMAND });
				} else {
					verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "fail", reason: `relay error kind=${error.kind} stage=${error.stage} mutationOutcome=${error.mutationOutcome}: ${error.message}`, stderr: error.stderr });
				}
			} else {
				verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "fail", reason: `unexpected non-relay error: ${error instanceof Error ? error.message : String(error)}` });
			}
		} finally {
			if (negativeControl !== null) rmSync(negativeControl.directory, { recursive: true, force: true });
		}
	}
	return verdicts;
}
async function main() {
	const argv = process.argv.slice(2);
	const index = argv.indexOf("--descriptor");
	if (index === -1 || argv[index + 1] === undefined) {
		process.stderr.write("usage: provider-relay-matrix.mjs --descriptor <path.json>\n");
		process.exitCode = 2;
		return;
	}
	let descriptor;
	try {
		descriptor = loadDescriptor(argv[index + 1]);
	} catch (error) {
		process.stderr.write(`descriptor validation failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
		return;
	}
	const verdicts = await runMatrix(descriptor, { armPositive: process.env[ARM_POSITIVE_ENV] === "1" });
	for (const verdict of verdicts) {
		process.stdout.write(`${JSON.stringify(verdict)}\n`);
		if (verdict.verdict !== "pass") process.exitCode = 1;
	}
}
if (process.argv[1]?.endsWith("provider-relay-matrix.mjs")) await main();
