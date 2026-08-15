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
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { REVIEW_HOST_RELAY_FAILURE, ReviewHostRelayError, resolveReviewHostRelaySubmission, runReviewHostRelaySlot } from "../../lib/review-host-relay.ts";
export const DESCRIPTOR_SCHEMA = "gentle-pi.maintainer.provider-relay-descriptor/v1";
export const CASE_KINDS = Object.freeze(["relay-unavailable", "positive-lens"]);
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
			exactKeys(entry, new Set(["name", "kind", "captureArgumentTokens", "submission"]), `descriptor.cases[${index}]`);
			if (!isStr(entry.name)) fail(`descriptor.cases[${index}].name must be a non-empty string`);
			if (seen.has(entry.name)) fail(`descriptor.cases[${index}].name "${entry.name}" is duplicated`);
			seen.add(entry.name);
			if (!CASE_KINDS.includes(entry.kind)) fail(`descriptor.cases[${index}].kind must be one of ${JSON.stringify([...CASE_KINDS])}`);
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
// verbatim, bare name searched on PATH. Never re-resolves production.
export function resolveDeclaredExecutable(executable) {
	if (isAbsolute(executable)) return existsSync(executable) && statSync(executable).isFile() ? executable : null;
	for (const directory of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
		if (!directory) continue;
		const candidate = join(directory, executable);
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
// Runs the matrix against the REAL relay. A case that cannot run honestly is
// `blocked` (never `pass`); `fail` is an armed case whose outcome mismatched.
export async function runMatrix(descriptor, options = {}) {
	const positiveArmed = options.armPositive ?? (process.env[ARM_POSITIVE_ENV] === "1");
	const verdicts = [];
	for (const caseEntry of descriptor.cases) {
		const gentleAiPath = resolveDeclaredExecutable(descriptor.gentleAiExecutable);
		if (gentleAiPath === null) {
			verdicts.push({ name: caseEntry.name, kind: caseEntry.kind, verdict: "blocked", reason: missingReason(descriptor.gentleAiExecutable, "gentleAiExecutable") });
			continue;
		}
		// The positive lens needs a real pi AND an explicit arm; the negative
		// control never launches pi (fails closed at materialize).
		if (caseEntry.kind === "positive-lens") {
			if (resolveDeclaredExecutable(descriptor.piExecutable) === null) {
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
		const request = { captureArgumentTokens: caseEntry.captureArgumentTokens, submission: caseEntry.submission, gentleAiExecutable: gentleAiPath, piExecutable: negativeControl === null ? descriptor.piExecutable : negativeControl.executable, ...(options.signal === undefined ? {} : { signal: options.signal }) };
		try {
			const result = await runReviewHostRelaySlot(request);
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
