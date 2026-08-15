// Maintainer provider-relay matrix — behavior-first tests (gentle-pi#311).
//
// `pnpm test` never picks this up: it globs `tests/*.test.ts` only, and this
// file lives one directory deeper and ends in `.maintest.ts`. It runs only
// via `pnpm run test:maintainer`. Strict validation + no-production-resolution
// always run; real-binary tests run only when env-supplied maintainer binaries
// exist (self-skip; fail-loud under GENTLE_PI_REQUIRE_MAINTAINER=1). Never fakes
// green. Tests never hardcode machine-specific paths; the verifier supplies
// them via env. The baseline is described generically; external evidence
// establishes whether it is the immutable RC8 runtime.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { REVIEW_HOST_RELAY_FAILURE, ReviewHostRelayError, runReviewHostRelaySlot } from "../../lib/review-host-relay.ts";
import { ARM_POSITIVE_ENV, CASE_KINDS, DESCRIPTOR_SCHEMA, DescriptorValidationError, POSITIVE_JOURNEY_COMMAND, loadDescriptor, resolveDeclaredExecutable, runMatrix, validateDescriptor } from "../../scripts/maintainer/provider-relay-matrix.mjs";
const BASELINE_ENV = "GENTLE_PI_MAINTAINER_BASELINE_BINARY";
const CAPABLE_ENV = "GENTLE_PI_MAINTAINER_CAPABLE_BINARY";
const REQUIRE_ENV = "GENTLE_PI_REQUIRE_MAINTAINER";
const PLACEHOLDER_BINARY = "/tmp/gentle-pi-maintainer-not-a-real-binary";
const baselineBinary = process.env[BASELINE_ENV];
const capableBinary = process.env[CAPABLE_ENV];
const armed = process.env[REQUIRE_ENV] === "1";

const BINDING_TOKENS = Object.freeze([
	"--lineage=review-1d5aadacc600e167",
	`--expected-revision=sha256:${"c".repeat(64)}`,
	`--target=sha256:${"d".repeat(64)}`,
	`--repository-context=rctx1_${"e".repeat(64)}`,
	"--lens=review-reliability",
	"--order=0",
	`--subject-hash=sha256:${"a".repeat(64)}`,
]);
const CAPTURE_TOKENS = Object.freeze([...BINDING_TOKENS, "--agent=pi", "--materialize=true"]);
const SUBMISSION = Object.freeze({
	operationToken: "capture-result",
	argumentTokens: Object.freeze([...BINDING_TOKENS, "--input={{value}}"]),
	values: Object.freeze([{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitutionLocation: BINDING_TOKENS.length }]),
});

function descriptor(overrides = {}) {
	return {
		schema: DESCRIPTOR_SCHEMA,
		gentleAiExecutable: PLACEHOLDER_BINARY,
		piExecutable: "pi",
		cases: [{ name: "baseline-negative-control", kind: "relay-unavailable", captureArgumentTokens: [...CAPTURE_TOKENS], submission: structuredClone(SUBMISSION) }],
		...overrides,
	};
}
function rejects(obj, fragment) {
	assert.throws(() => validateDescriptor(obj), (error) => error instanceof DescriptorValidationError && error.message.includes(fragment));
}
function tempDescriptor(t, obj) {
	const directory = mkdtempSync(join(tmpdir(), "gentle-pi-maintainer-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "d.json");
	writeFileSync(path, JSON.stringify(obj));
	return path;
}

// ---------------------------------------------------------------------------
// Strict descriptor validation — exact shape, no defaults, no production
// resolution. Pure/deterministic; always runs.
// ---------------------------------------------------------------------------
test("valid descriptor validates and returns a normalized copy", () => {
	const d = validateDescriptor(descriptor());
	assert.equal(d.schema, DESCRIPTOR_SCHEMA);
	assert.deepEqual(d.cases[0]!.captureArgumentTokens, [...CAPTURE_TOKENS]);
	assert.deepEqual(d.cases[0]!.submission.values, SUBMISSION.values);
});
test("rejects malformed descriptor fields with exact-shape errors (no defaults, no production resolution)", () => {
	rejects({ ...descriptor(), schema: "gentle-pi.maintainer.provider-relay-descriptor/v2" }, "descriptor.schema must be exactly");
	rejects({ ...descriptor(), gentleAiExecutable: "gentle-ai" }, "absolute path");
	rejects({ ...descriptor(), gentleAiExecutable: undefined }, "absolute path");
	rejects({ ...descriptor(), extra: 1 }, "descriptor.extra");
	rejects({ ...descriptor(), cases: [{ ...descriptor().cases[0]!, extra: 1 }] }, "extra");
	assert.deepEqual([...CASE_KINDS], ["relay-unavailable", "positive-lens"]);
	rejects({ ...descriptor(), cases: [{ ...descriptor().cases[0]!, kind: "bogus" }] }, "kind must be one of");
	const dup = { ...descriptor().cases[0]!, name: "dup" };
	rejects({ ...descriptor(), cases: [structuredClone(dup), structuredClone(dup)] }, "duplicated");
	// Every case must declare the real provider-issued materialize slot.
	rejects({ ...descriptor(), cases: [{ ...descriptor().cases[0]!, captureArgumentTokens: [...CAPTURE_TOKENS].filter((t) => t !== "--agent=pi") }] }, "--agent=pi");
	rejects({ ...descriptor(), cases: [{ ...descriptor().cases[0]!, captureArgumentTokens: [...CAPTURE_TOKENS].filter((t) => t !== "--materialize=true") }] }, "--materialize=true");
});
test("submission is validated through the real relay resolver before any process launches (exact shape)", () => {
	const twoValues = structuredClone(SUBMISSION);
	twoValues.values = [...SUBMISSION.values, { slot: "extra", domain: "artifact_path_or_stdin", substitutionLocation: 0 }];
	rejects({ ...descriptor(), cases: [{ ...descriptor().cases[0]!, submission: twoValues }] }, "not a bindable provider form");
	const noSlot = structuredClone(SUBMISSION);
	noSlot.argumentTokens = [...BINDING_TOKENS, "--input=/no/value/slot"];
	rejects({ ...descriptor(), cases: [{ ...descriptor().cases[0]!, submission: noSlot }] }, "not a bindable provider form");
	rejects({ ...descriptor(), cases: [{ ...descriptor().cases[0]!, submission: { ...structuredClone(SUBMISSION), extra: 1 } }] }, "extra");
});
test("loadDescriptor reads and validates a descriptor file", (t) => {
	const path = tempDescriptor(t, descriptor());
	assert.equal(loadDescriptor(path).schema, DESCRIPTOR_SCHEMA);
	assert.throws(() => loadDescriptor(join(dirname(path), "missing.json")), /could not read descriptor/);
	writeFileSync(join(dirname(path), "bad.json"), "{not json");
	assert.throws(() => loadDescriptor(join(dirname(path), "bad.json")), /not valid JSON/);
});

// ---------------------------------------------------------------------------
// No-production-resolution — the runner uses only declared executables and
// never falls through to the package-local production binary.
// ---------------------------------------------------------------------------
test("runMatrix uses only the declared executable, never the production resolver", async () => {
	const [verdict] = await runMatrix(validateDescriptor({ ...descriptor(), gentleAiExecutable: "/tmp/opencode/not-a-gentle-ai-binary" }));
	assert.equal(verdict!.verdict, "blocked");
	assert.match(verdict!.reason, /gentleAiExecutable/);
	assert.notEqual(verdict!.verdict, "pass");
});
test("resolveDeclaredExecutable checks absolute paths verbatim and bare names on PATH only", () => {
	assert.equal(resolveDeclaredExecutable("/tmp/opencode/nonexistent-absolute-123"), null);
	assert.equal(resolveDeclaredExecutable(""), null);
});
// ---------------------------------------------------------------------------
// Negative control — a baseline runtime without --materialize fails closed as
// relay-unavailable with zero Pi launch and zero submission. The baseline is
// env-supplied (GENTLE_PI_MAINTAINER_BASELINE_BINARY); external evidence
// establishes whether it is the immutable RC8 runtime. Self-skip / fail-loud.
// ---------------------------------------------------------------------------
const baselineArmed = typeof baselineBinary === "string" && baselineBinary.length > 0 && baselineBinary.startsWith("/") && existsSync(baselineBinary);
const baselineReason = () => `${BASELINE_ENV} is unset or not an existing absolute path; supply the baseline gentle-ai binary (external evidence establishes whether it is RC8), or set ${REQUIRE_ENV}=1 to fail instead of skip.`;
if (!baselineArmed && armed) throw new Error(baselineReason());
if (!baselineArmed) console.log(`tests/maintainer/provider-relay.maintest.ts: ${baselineReason()}`);
function baselineDescriptor(kind = "relay-unavailable" as const) {
	return validateDescriptor({ ...descriptor(), gentleAiExecutable: baselineBinary, cases: [{ name: "baseline-negative-control", kind, captureArgumentTokens: [...CAPTURE_TOKENS], submission: structuredClone(SUBMISSION) }] });
}
test("negative control: runMatrix proves the baseline fails closed as relay-unavailable with zero mutation", { skip: !baselineArmed }, async () => {
	const [verdict] = await runMatrix(baselineDescriptor());
	assert.equal(verdict!.kind, "relay-unavailable");
	assert.equal(verdict!.verdict, "pass");
	assert.equal(verdict!.stage, "materialize");
	assert.equal(verdict!.mutationOutcome, "none");
	assert.equal(verdict!.reason, REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE);
});
test("negative control: the real relay returns a typed relay-unavailable error before Pi launches", { skip: !baselineArmed }, async () => {
	// The baseline lacks --materialize, so it fails at materialize before any
	// pi launch; RELAY_UNAVAILABLE at materialize proves Pi never launched.
	let caught: unknown;
	try {
		await runReviewHostRelaySlot({ captureArgumentTokens: [...CAPTURE_TOKENS], submission: structuredClone(SUBMISSION), gentleAiExecutable: baselineBinary!, piExecutable: "pi" });
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof ReviewHostRelayError);
	const e = caught as ReviewHostRelayError;
	assert.equal(e.kind, REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE);
	assert.equal(e.stage, "materialize");
	assert.equal(e.mutationOutcome, "none");
	assert.match(e.stderr, /flag provided but not defined: -(?:materialize|agent)/);
});
test("negative control: an armed positive-lens against the baseline blocks because it lacks the surface", { skip: !baselineArmed }, async () => {
	const [verdict] = await runMatrix(baselineDescriptor("positive-lens"), { armPositive: true });
	assert.equal(verdict!.verdict, "blocked");
	assert.match(verdict!.reason, /lacks the pi host relay surface/);
	assert.equal(verdict!.command, POSITIVE_JOURNEY_COMMAND);
});
// ---------------------------------------------------------------------------
// Honest positive arming/skip — the organic journey needs a real capable
// binary, a real pi, and a real review session (lifecycle machinery beyond
// this work unit). The runner blocks the positive leg before materialize
// unless armed. These tests run WITHOUT the arm (the verifier arms it).
// ---------------------------------------------------------------------------
const capableArmed = typeof capableBinary === "string" && capableBinary.length > 0 && capableBinary.startsWith("/") && existsSync(capableBinary);
const capableReason = () => `${CAPABLE_ENV} is unset or not an existing absolute path; supply a capable gentle-ai binary (local build of origin/main with the pi host-relay surface), or set ${REQUIRE_ENV}=1 to fail instead of skip.`;
if (!capableArmed && armed) throw new Error(capableReason());
if (!capableArmed) console.log(`tests/maintainer/provider-relay.maintest.ts: ${capableReason()}`);
function positiveDescriptor(gentleAi = capableBinary, pi = "pi") {
	return validateDescriptor({ ...descriptor(), gentleAiExecutable: gentleAi!, piExecutable: pi, cases: [{ name: "positive-lens-relay", kind: "positive-lens", captureArgumentTokens: [...CAPTURE_TOKENS], submission: structuredClone(SUBMISSION) }] });
}
test("positive arming/skip: an unarmed positive leg blocks loudly and never fakes green", { skip: !capableArmed }, async () => {
	const [verdict] = await runMatrix(positiveDescriptor());
	assert.equal(verdict!.kind, "positive-lens");
	assert.equal(verdict!.verdict, "blocked");
	assert.match(verdict!.reason, new RegExp(ARM_POSITIVE_ENV));
	assert.equal(verdict!.command, POSITIVE_JOURNEY_COMMAND);
	assert.notEqual(verdict!.verdict, "pass");
	assert.notEqual(verdict!.verdict, "fail");
});
test("positive arming/skip: a missing pi blocks at the pi pre-arm before materialize", { skip: !capableArmed }, async () => {
	const [verdict] = await runMatrix(positiveDescriptor(capableBinary, "/tmp/opencode/not-a-real-pi"));
	assert.equal(verdict!.verdict, "blocked");
	assert.match(verdict!.reason, /piExecutable/);
	assert.equal(verdict!.command, POSITIVE_JOURNEY_COMMAND);
});
test("positive arming/skip: the exact next evidence command is surfaced for the separate verifier", { skip: !capableArmed }, async () => {
	const [verdict] = await runMatrix(positiveDescriptor());
	assert.match(verdict!.command!, /node --experimental-strip-types scripts\/maintainer\/provider-relay-matrix.mjs --descriptor/);
	assert.match(verdict!.command!, /GENTLE_PI_MAINTAINER_ARM_POSITIVE=1/);
});
