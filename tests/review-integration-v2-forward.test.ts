import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	decodeReviewCapabilitiesV2,
	decodeReviewConsentV2,
	decodeReviewConsentV3,
	decodeReviewStartV3,
	decodeReviewStatusV3,
} from "../lib/review-integration-v2.ts";

// Forward decoders for the gentle-ai main line (dev-binary field-test lane).
//
// Fixture provenance:
// - capabilities-v2.2.captured.json and status-v5.captured.json were captured
//   2026-08-15 from the real binary at /home/gentleman/.cargo/bin/gentle-ai
//   reporting "gentle-ai 2.4.0-rc.8+fix.verify-attestation-recovery" (built
//   from the gentle-ai main line), in a scratch git repository:
//     gentle-ai review capabilities --contract gentle-ai.review-integration/v2
//     GENTLE_PI_REVIEW_RELAY_CONTRACT=gentle-pi.review-relay/v1 \
//       gentle-ai review status --contract gentle-ai.review-integration/v2 \
//       --cwd <scratch> --projection workspace --next-transition
// - capabilities-v2.1.derived.json is derived from the captured v2.2 payload
//   plus gentle-ai origin/main contracts/review-integration/v2/schemas/
//   capabilities-v2.1.schema.json (schema const v2.1, protocol minor 1,
//   consent/v3 + status/v3 schema advertisements, 17 optional features): no
//   installed binary emits v2.1 to capture from.
// - The v5-only next_transition samples (correction_request, provider_task,
//   submission descriptor forms) are constructed from gentle-ai origin/main
//   contracts/review-integration/v2/schemas/status-v5.schema.json and
//   contracts/review-integration/v1/schemas/correction-plan-request.schema.json.
// - consent-v3.captured.json, start-v3-consent-granted.captured.json, and
//   start-v3-consent-declined.captured.json were captured 2026-08-16 from the
//   real binary at /home/gentleman/.cargo/bin/gentle-ai reporting
//   "gentle-ai 2.4.0-main.b1afef46", in a scratch git repository holding a
//   committed internal/runner/{runner.go,runner_test.go} baseline plus 12
//   uncommitted changed lines that add a process-starting helper (risk signal
//   shell_process, high tier):
//     gentle-ai review status --contract gentle-ai.review-integration/v2 \
//       --cwd <scratch> --projection workspace --next-transition   # target source
//     gentle-ai review start --contract gentle-ai.review-integration/v2 \
//       --cwd <scratch> --target <identity> --projection workspace \
//       --consent relay                                            # consent-v3
//   then the envelope's exact declined invocation (declined capture, which
//   persists nothing) followed by its exact granted invocation (granted
//   start/v3 capture). Note: the live granted/declined invocations carry no
//   --agent token even though the envelope pins agent: claude-code — the
//   published consent-v3.schema.json invocation pattern is narrower than the
//   emitter, so the capture is authoritative (parity playbook, known traps).

const fixtureRoot = join(import.meta.dirname, "fixtures", "devbinary");
const fixture = <T = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(join(fixtureRoot, name), "utf8")) as T;
const v2FixtureRoot = join(process.cwd(), "contracts", "review-integration", "v2", "fixtures");
const v2Fixture = <T = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(join(v2FixtureRoot, name), "utf8")) as T;
const capturedDigest = "ffc91d8fa79c869aba9aa3d1ec80edebb5b1744e5a06fef75d4c8b73c0e46bc1";
const pinnedFixtureDigest = "dcc846103b16d365eaeeb9d7f289c23fc4f2897f23def1cb3fe7f05557b64705";

type JsonObject = Record<string, unknown>;
const clone = <T>(value: T): T => structuredClone(value);
const sha = (fill: string): string => `sha256:${fill.repeat(64)}`;

test("the captured capabilities/v2.2 payload decodes and reports its own package version", () => {
	const capabilities = decodeReviewCapabilitiesV2(fixture("capabilities-v2.2.captured.json"), capturedDigest);
	assert.equal(capabilities.packageVersion, "2.4.0-rc.8+fix.verify-attestation-recovery");
	assert.equal(capabilities.schemas.has("gentle-ai.review-integration.status/v5"), true);
	assert.equal(capabilities.schemas.has("gentle-ai.review-integration.consent/v3"), true);
	assert.equal(capabilities.optionalFeatures.has("provider_bound_native_git_context"), true);
});

test("the derived capabilities/v2.1 payload decodes with protocol minor 1", () => {
	const capabilities = decodeReviewCapabilitiesV2(fixture("capabilities-v2.1.derived.json"), capturedDigest);
	assert.equal(capabilities.packageVersion, "2.4.0-rc.8+fix.verify-attestation-recovery");
	assert.equal(capabilities.schemas.has("gentle-ai.review-integration.status/v3"), true);
	assert.equal(capabilities.schemas.has("gentle-ai.review-integration.consent/v3"), true);
});

test("the pinned capabilities/v2 fixture still decodes unchanged", () => {
	const capabilities = decodeReviewCapabilitiesV2(v2Fixture("capabilities.fixture.json"), pinnedFixtureDigest);
	assert.equal(capabilities.schemas.has("gentle-ai.review-integration.status/v3"), true);
	assert.equal(capabilities.schemas.has("gentle-ai.review-integration.consent/v2"), true);
});

test("capabilities schema identity and protocol minor must agree", () => {
	const base = fixture<JsonObject>("capabilities-v2.2.captured.json");
	const wrongMinor = clone(base);
	(wrongMinor.protocol as JsonObject).minor = 1;
	assert.throws(() => decodeReviewCapabilitiesV2(wrongMinor, capturedDigest), /protocol/);
	const wrongSchema = clone(base);
	wrongSchema.schema = "gentle-ai.review-integration.capabilities/v2.3";
	assert.throws(() => decodeReviewCapabilitiesV2(wrongSchema, capturedDigest), /schema/);
	// The old identity never inherits the new advertisements: a v2 envelope
	// advertising the v2.2 schema surface is missing its own required floor.
	const crossed = clone(base);
	crossed.schema = "gentle-ai.review-integration.capabilities/v2";
	(crossed.protocol as JsonObject).minor = 0;
	assert.throws(() => decodeReviewCapabilitiesV2(crossed, capturedDigest), /schemas/);
});

test("the captured status/v5 payload decodes with its forecast and base-ref collect input", () => {
	const status = decodeReviewStatusV3(fixture("status-v5.captured.json"));
	assert.equal(status.applicability, "unrelated");
	assert.equal(status.action, "start");
	assert.equal(status.forecast?.horizon, "partial");
	assert.deepEqual(status.forecast?.steps, [{ step: 1, kind: "collect", reasonCode: "empty_candidate_base_ref_required", description: "empty candidate base ref required" }]);
	assert.equal(status.nextTransition?.kind, "collect");
	assert.equal(status.nextTransition?.collect?.inputs[0]?.captureOperation, "external.select_base_ref");
});

test("the pinned status/v3 fixture still decodes unchanged", () => {
	const status = decodeReviewStatusV3(v2Fixture("status.fixture.json"));
	assert.equal(status.contract, "gentle-ai.review-integration/v2");
});

test("a status/v3 payload never carries v5 fields", () => {
	const v5 = fixture<JsonObject>("status-v5.captured.json");
	const downgraded = clone(v5);
	downgraded.schema = "gentle-ai.review-integration.status/v3";
	// forecast is a v5 field; the v3 identity must keep rejecting it.
	assert.throws(() => decodeReviewStatusV3(downgraded), /forecast/);
	const withoutForecast = clone(downgraded);
	delete withoutForecast.forecast;
	const status = decodeReviewStatusV3(withoutForecast);
	assert.equal(status.forecast, undefined);
});

test("a v5 forecast requires the next transition and a coherent horizon", () => {
	const base = fixture<JsonObject>("status-v5.captured.json");
	const orphanForecast = clone(base);
	delete orphanForecast.next_transition;
	assert.throws(() => decodeReviewStatusV3(orphanForecast), /forecast/);
	const wrongHorizon = clone(base);
	(wrongHorizon.forecast as JsonObject).horizon = "terminal";
	assert.throws(() => decodeReviewStatusV3(wrongHorizon), /horizon/);
	const badStep = clone(base);
	((badStep.forecast as JsonObject).steps as JsonObject[])[0]!.step = 2;
	assert.throws(() => decodeReviewStatusV3(badStep), /step/);
	const extraKey = clone(base);
	(extraKey.forecast as JsonObject).unadvertised = true;
	assert.throws(() => decodeReviewStatusV3(extraKey), /not allowed/);
});

// --- v5-only next_transition surfaces, constructed per the vendored schemas ---

function v5StatusWith(nextTransition: JsonObject, forecast?: JsonObject): JsonObject {
	const base = fixture<JsonObject>("status-v5.captured.json");
	base.next_transition = nextTransition;
	if (forecast === undefined) delete base.forecast;
	else base.forecast = forecast;
	return base;
}

const correctionPlanRequest: JsonObject = {
	schema: "gentle-ai.review-correction-plan-request/v1",
	request_hash: sha("a"),
	lineage_id: "review-1d5aadacc600e167",
	expected_revision: sha("b"),
	target_identity: sha("c"),
	correction_budget: 25,
	fix_finding_ids: ["risk-1"],
	findings: [{
		id: "risk-1",
		lens: "risk",
		location: "app.ts:10",
		severity: "BLOCKER",
		claim: "candidate-introduced credential exposure",
		proof_refs: ["app.ts:10-14"],
		evidence: "the candidate logs the raw token",
		evidence_class: "deterministic",
		causal_disposition: "introduced",
	}],
};

test("a v5 correction_plan_required transition carries its correction request and plan submission", () => {
	const transition: JsonObject = {
		kind: "collect",
		reason_code: "correction_plan_required",
		correction_request: correctionPlanRequest,
		collect: {
			inputs: [{
				name: "correction_plan",
				schema: "gentle-ai.review-correction-plan/v1",
				capture_operation: "external.plan_correction",
				arguments: [{ name: "lineage", value: "review-1d5aadacc600e167" }],
				submission: {
					operation_token: "finalize",
					argument_tokens: [
						"--contract=gentle-ai.review-integration/v2",
						"--lineage=review-1d5aadacc600e167",
						`--expected-revision=${sha("b")}`,
						`--target=${sha("c")}`,
						`--request-hash=${sha("a")}`,
						`--repository-context=rctx1_${"0".repeat(64)}`,
						"--correction-lines={{value}}",
					],
					value: { slot: "correction_lines", domain: "positive_correction_lines", minimum: 1, maximum: 25, substitution_location: 6 },
				},
			}],
		},
	};
	const status = decodeReviewStatusV3(v5StatusWith(transition));
	assert.equal(status.nextTransition?.reasonCode, "correction_plan_required");
	assert.equal(status.nextTransition?.correctionRequest?.correctionBudget, 25);
	assert.equal(status.nextTransition?.collect?.inputs[0]?.submissionDescriptor?.operationToken, "finalize");
	// The same reason code without its correction request is incomplete.
	const missing = clone(transition);
	delete missing.correction_request;
	assert.throws(() => decodeReviewStatusV3(v5StatusWith(missing)), /correction_request/);
	// And correction_request never rides an unrelated reason code.
	const unrelated = clone(transition);
	unrelated.reason_code = "verification_evidence_required";
	assert.throws(() => decodeReviewStatusV3(v5StatusWith(unrelated)), /correction_request/);
});

test("a v5 capture-evidence transition decodes its evidence submission descriptor", () => {
	const transition: JsonObject = {
		kind: "collect",
		reason_code: "verification_evidence_required",
		collect: {
			inputs: [{
				name: "verification_evidence",
				schema: "https://gentle-ai.dev/schema/review/verification-evidence/v1",
				capture_operation: "review.capture-evidence",
				arguments: [{ name: "lineage", value: "review-1d5aadacc600e167" }],
				submission: {
					operation_token: "capture-evidence",
					argument_tokens: [
						"--lineage=review-1d5aadacc600e167",
						`--expected-revision=${sha("b")}`,
						`--target=${sha("c")}`,
						`--repository-context=rctx1_${"0".repeat(64)}`,
						"--outcome={{outcome}}",
						"--input={{input}}",
					],
					values: [
						{ slot: "outcome", domain: "verification_outcome", allowed_values: ["passed", "verification_failed", "procedural_tooling_failed"], substitution_location: 4 },
						{ slot: "input", domain: "artifact_path_or_stdin", schema: "https://gentle-ai.dev/schema/review/verification-evidence/v1", substitution_location: 5 },
					],
				},
			}],
		},
	};
	const status = decodeReviewStatusV3(v5StatusWith(transition));
	const input = status.nextTransition?.collect?.inputs[0];
	assert.equal(input?.submissionDescriptor?.operationToken, "capture-evidence");
	assert.equal(input?.submission, undefined);
	// Missing its required submission descriptor is incomplete.
	const missing = clone(transition);
	delete ((missing.collect as JsonObject).inputs as JsonObject[])[0]!.submission;
	assert.throws(() => decodeReviewStatusV3(v5StatusWith(missing)), /submission/);
});

test("a v5 provider role task input decodes and is confined to external.run_provider_role", () => {
	const providerTask = { agent: "review-refuter", role: "refuter", prompt: "GENTLE_AI_REVIEW_BINDING {}" };
	const transition: JsonObject = {
		kind: "collect",
		reason_code: "refuter_batch_required",
		collect: {
			inputs: [{
				name: "refuter_batch",
				schema: "https://gentle-ai.dev/schema/review/refuter/v1",
				capture_operation: "external.run_provider_role",
				arguments: [{ name: "lineage", value: "review-1d5aadacc600e167" }],
				provider_task: providerTask,
			}],
		},
	};
	const status = decodeReviewStatusV3(v5StatusWith(transition));
	assert.deepEqual(status.nextTransition?.collect?.inputs[0]?.providerTask, { agent: "review-refuter", role: "refuter", prompt: "GENTLE_AI_REVIEW_BINDING {}" });
	// The task is required on its own vector and forbidden anywhere else.
	const missing = clone(transition);
	delete ((missing.collect as JsonObject).inputs as JsonObject[])[0]!.provider_task;
	assert.throws(() => decodeReviewStatusV3(v5StatusWith(missing)), /provider_task/);
	const misplaced = fixture<JsonObject>("status-v5.captured.json");
	(((misplaced.next_transition as JsonObject).collect as JsonObject).inputs as JsonObject[])[0]!.provider_task = providerTask;
	assert.throws(() => decodeReviewStatusV3(misplaced), /provider_task/);
});

test("the v3 next transition keeps rejecting every v5-only surface", () => {
	const v5 = fixture<JsonObject>("status-v5.captured.json");
	// Re-identify the captured envelope as v3 (drop the v5-only forecast) and
	// then try to smuggle each v5 surface through the old identity.
	const asV3 = (mutate: (transition: JsonObject) => void): JsonObject => {
		const body = clone(v5);
		body.schema = "gentle-ai.review-integration.status/v3";
		delete body.forecast;
		mutate(body.next_transition as JsonObject);
		return body;
	};
	assert.throws(() => decodeReviewStatusV3(asV3((transition) => { transition.correction_request = correctionPlanRequest; })), /not allowed|correction_request/);
	assert.throws(() => decodeReviewStatusV3(asV3((transition) => {
		(((transition.collect as JsonObject).inputs as JsonObject[])[0]!).provider_task = { agent: "review-refuter", role: "refuter", prompt: "x" };
	})), /not allowed|provider_task/);
	assert.throws(() => decodeReviewStatusV3(asV3((transition) => {
		(((transition.collect as JsonObject).inputs as JsonObject[])[0]!).submission = { operation_token: "finalize", argument_tokens: ["--correction-lines={{value}}"], value: { slot: "correction_lines", domain: "positive_correction_lines", minimum: 1, maximum: 25, substitution_location: 6 } };
	})), /submission|values/);
});

// --- consent/v3 — the negotiated v2.1+ consent question (adds `agent`) ---

test("the captured consent/v3 envelope decodes with its fixed agent binding", () => {
	const consent = decodeReviewConsentV3(fixture("consent-v3.captured.json"));
	assert.equal(consent.schema, "gentle-ai.review-integration.consent/v3");
	assert.equal(consent.agent, "claude-code");
	assert.equal(consent.action, "consent_required");
	assert.equal(consent.blocking, true);
	assert.equal(consent.riskLevel, "high");
	assert.equal(consent.changedFiles, 2);
	assert.equal(consent.changedLines, 12);
	assert.equal(consent.choices[0].answer, "granted");
	assert.equal(consent.choices[1].answer, "declined");
	for (const choice of consent.choices) {
		assert.ok(choice.invocation.includes(` --target ${consent.targetIdentity} `));
	}
	assert.equal(consent.offPath.command, "gentle-ai review mode disable");
});

test("consent identities never cross-decode", () => {
	const v3 = fixture<JsonObject>("consent-v3.captured.json");
	const v2 = v2Fixture<JsonObject>("consent.fixture.json");
	// The old identity never accepts the new surface, and vice versa.
	assert.throws(() => decodeReviewConsentV2(clone(v3)), /agent|schema/);
	assert.throws(() => decodeReviewConsentV3(clone(v2)), /agent|schema/);
	// A schema-swapped v3 body keeps its agent key, which the v2 identity
	// still rejects as an unadvertised surface.
	const downgraded = clone(v3);
	downgraded.schema = "gentle-ai.review-integration.consent/v2";
	assert.throws(() => decodeReviewConsentV2(downgraded), /agent/);
	// A schema-swapped v2 body is missing the agent key v3 requires.
	const upgraded = clone(v2);
	upgraded.schema = "gentle-ai.review-integration.consent/v3";
	assert.throws(() => decodeReviewConsentV3(upgraded), /agent/);
});

test("consent/v3 keeps every v2 semantic guard and pins its agent constant", () => {
	const base = fixture<JsonObject>("consent-v3.captured.json");
	const wrongAgent = clone(base);
	wrongAgent.agent = "opencode";
	assert.throws(() => decodeReviewConsentV3(wrongAgent), /agent/);
	const swapped = clone(base);
	swapped.choices = [...(swapped.choices as JsonObject[])].reverse();
	assert.throws(() => decodeReviewConsentV3(swapped), /answer/);
	const badInvocation = clone(base);
	((badInvocation.choices as JsonObject[])[0]!).invocation = "gentle-ai review finalize --consent granted";
	assert.throws(() => decodeReviewConsentV3(badInvocation), /invocation/);
	const differentTarget = clone(base);
	differentTarget.target_identity = sha("d");
	assert.throws(() => decodeReviewConsentV3(differentTarget), /target|invocation/);
	const notBlocking = clone(base);
	notBlocking.blocking = false;
	assert.throws(() => decodeReviewConsentV3(notBlocking), /blocking/);
	const extraKey = clone(base);
	extraKey.unadvertised = true;
	assert.throws(() => decodeReviewConsentV3(extraKey), /not allowed/);
});

test("the pinned consent/v2 fixture still decodes unchanged", () => {
	const consent = decodeReviewConsentV2(v2Fixture("consent.fixture.json"));
	assert.equal(consent.schema, "gentle-ai.review-integration.consent/v2");
	assert.equal(consent.action, "consent_required");
});

// --- start/v3 — main extends repository_context with event_id/outcome ---

test("the captured granted start/v3 decodes with its repository context event binding", () => {
	const start = decodeReviewStartV3(fixture("start-v3-consent-granted.captured.json"));
	assert.equal(start.lineageId, "review-377c60e10b852cfc");
	assert.equal(start.state, "reviewing");
	assert.equal(start.riskLevel, "high");
	assert.equal(start.selectedLenses.length, 4);
	assert.equal(start.correctionBudget, 6);
	assert.equal(start.repositoryContext?.outcome, "applied");
	assert.match(start.repositoryContext?.eventId ?? "", /^sha256:[0-9a-f]{64}$/);
});

test("start/v3 repository context event fields stay optional and exact", () => {
	// The pinned fixture carries neither field and still decodes unchanged.
	const pinned = decodeReviewStartV3(v2Fixture("start.fixture.json"));
	assert.equal(pinned.repositoryContext?.eventId, undefined);
	assert.equal(pinned.repositoryContext?.outcome, undefined);
	const base = fixture<JsonObject>("start-v3-consent-granted.captured.json");
	const badEvent = clone(base);
	(badEvent.repository_context as JsonObject).event_id = "not-a-digest";
	assert.throws(() => decodeReviewStartV3(badEvent), /event_id/);
	const badOutcome = clone(base);
	(badOutcome.repository_context as JsonObject).outcome = "unheard-of";
	assert.throws(() => decodeReviewStartV3(badOutcome), /outcome/);
	const extraKey = clone(base);
	(extraKey.repository_context as JsonObject).unadvertised = true;
	assert.throws(() => decodeReviewStartV3(extraKey), /not allowed/);
});
