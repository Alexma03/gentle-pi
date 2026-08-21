import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { __testing, createGentleAiExtension } from "../extensions/gentle-ai.ts";
import {
	NATIVE_REVIEW_ERROR_CODE,
	NativeReviewCliError,
	NativeReviewCliV214 as NativeReviewCliV214Production,
	NativeReviewCliV216,
	clearNativeReviewCapabilitiesCacheForTesting,
	nativeReviewAbandonAuthorization,
	nativeReviewLegacyAliasRepairAuthorization,
	type ExecFileAdapter,
	type NativeReviewCli,
} from "../lib/native-review-cli.ts";
import { GENTLE_AI_VERSION } from "../lib/gentle-ai-binary.ts";

const v2FixtureRoot = join(process.cwd(), "contracts", "review-integration", "v2", "fixtures");
const v2Fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(v2FixtureRoot, name), "utf8")) as T;

// Queued-adapter clients never execute a real process; a fixed absolute
// package-local path keeps these tests independent of an installed binary.
class NativeReviewCliV214 extends NativeReviewCliV214Production {
	constructor(...parameters: ConstructorParameters<typeof NativeReviewCliV214Production>) {
		const [adapter, executable, ...rest] = parameters;
		super(adapter, executable ?? "/package/.gentle-ai/gentle-ai", ...rest);
	}
}

interface QueuedResult { stdout: string; stderr?: string; exitCode?: number; }

function queuedAdapter(results: QueuedResult[]): { adapter: ExecFileAdapter; calls: Array<{ file: string; arguments: readonly string[]; cwd: string }> } {
	const calls: Array<{ file: string; arguments: readonly string[]; cwd: string }> = [];
	return {
		calls,
		adapter: async (request) => {
			calls.push({ file: request.file, arguments: request.arguments, cwd: request.cwd });
			const result = results.shift();
			if (!result) throw new Error("unexpected native invocation");
			return { stdout: result.stdout, stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0, signal: null, timedOut: false, outputLimitExceeded: false };
		},
	};
}

const VERSION_219 = { stdout: "gentle-ai 2.1.9\n" };
const VERSION_218 = { stdout: "gentle-ai 2.1.8\n" };
const VERSION_220 = { stdout: "gentle-ai 2.2.0\n" };
const RECLAIM_RECORD = { schema: "gentle-ai.review-reclaim-audit/v1", lineage: "stuck-lineage", actor: "maintainer", reason: "incomplete entry" };
const RECOVER_RECORD = { schema: "gentle-ai.review-recovery/v1", predecessor_lineage: "broken", successor_lineage: "successor" };
const RECONCILE_RECORD = { schema: "gentle-ai.review-reconcile-audit/v1", predecessor_lineage: "predecessor", successor_lineage: "successor", outcome: "quarantined" };
const RECONCILE_RESULT = { operation: "review/reconcile-authority", record: RECONCILE_RECORD };
const ABANDON_RECORD = { schema: "gentle-ai.review-reclaim-audit/v1", lineage_id: "pristine", status: "committed" };
const LEGACY_QUARANTINE_RECORD = { schema: "gentle-ai.review-reclaim-audit/v1", lineage_id: "legacy", status: "committed" };
const LEGACY_FREEZE_DIAGNOSTIC = "historical findings freeze changed unrelated transaction state";
const LEGACY_FREEZE_DISPOSITION = "quarantine-malformed-freeze-event";
const COMBINED_RECONCILE_ANOMALIES = "unchanged_target,malformed_recovery_authorization";
const LEGACY_ALIAS_DIAGNOSTIC = "unsupported historical v1 operation alias";
const LEGACY_ALIAS_DISPOSITION = "quarantine-approved-historical-alias";
const LEGACY_ALIAS_RECORD = { schema: "gentle-ai.review-reclaim-audit/v1", lineage_id: "legacy-alias", status: "committed" };
const LEGACY_ALIAS_AUTHORIZATION = [
	"gentle-ai.review-legacy-alias-repair-authorization/v1",
	"repository=/repo",
	"lineage=legacy-alias",
	`revision=sha256:${"c".repeat(64)}`,
	`diagnostic=${LEGACY_ALIAS_DIAGNOSTIC}`,
	`disposition=${LEGACY_ALIAS_DISPOSITION}`,
	"actor=maintainer",
	"reason=quarantine approved historical alias",
].join("\n");
const ABANDON_DISCARDED_WORK = {
	capturedLensResults: ["00-risk.json", "01-readability.json"],
	findingsPresent: true,
	evidenceRecordsPresent: false,
} as const;
const ABANDON_AUTHORIZATION = [
	"gentle-ai.review-abandon-authorization/v2",
	"lineage=pristine",
	"revision=revision",
	"snapshot_identity=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	"reason=retire pristine lineage",
	"captured_lens_results=00-risk.json,01-readability.json",
	"findings_present=true",
	"evidence_records_present=false",
	"actor=maintainer",
].join("\n");
const LEGACY_V1_ABANDON_AUTHORIZATION = [
	"gentle-ai.review-abandon-authorization/v1",
	"lineage=pristine",
	"revision=revision",
	"snapshot_identity=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	"actor=maintainer",
	"reason=retire pristine lineage",
].join("\n");
const ABANDON_REQUEST = {
	cwd: "/repo",
	lineage: "pristine",
	expectedRevision: "revision",
	snapshotIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	...ABANDON_DISCARDED_WORK,
	actor: "maintainer",
	reason: "retire pristine lineage",
	maintainerAuthorization: ABANDON_AUTHORIZATION,
} as const;
const LEGACY_QUARANTINE_AUTHORIZATION = [
	"gentle-ai.review-legacy-quarantine-authorization/v1",
	"repository=/repo",
	"lineage=legacy",
	"revision=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
	`diagnostic=${LEGACY_FREEZE_DIAGNOSTIC}`,
	`disposition=${LEGACY_FREEZE_DISPOSITION}`,
	"actor=maintainer",
	"reason=quarantine malformed legacy freeze",
].join("\n");
const RECONCILE_AUTHORIZATION = [
	"gentle-ai.review-reconcile-authorization/v1",
	"predecessor_lineage=predecessor",
	"predecessor_revision=predecessor-revision",
	"successor_lineage=successor",
	"successor_revision=successor-revision",
	"actor=maintainer",
	"reason=invalid recovery edge",
].join("\n");
const COMBINED_RECONCILE_AUTHORIZATION = `${RECONCILE_AUTHORIZATION}\nanomalies=${COMBINED_RECONCILE_ANOMALIES}`;
const RECOVER_TARGET_IDENTITY = `sha256:${"e".repeat(64)}`;
// The six canonical native recovery inputs, and nothing else. INSPECT never
// publishes the legacy RESET quartet for a compact-v2 recovery, so this is the
// complete request a maintainer can actually assemble (issue #212).
const RECOVER_INPUT = {
	predecessorLineage: "broken",
	expectedPredecessorRevision: "rev-1",
	successorLineage: "successor",
	disposition: "invalidated",
	actor: "maintainer",
	reason: "invalid authority",
} as const;
const RECOVER_AUTHORIZATION = [
	"gentle-ai.review-recovery-authorization/v1",
	"predecessor_lineage=broken",
	"predecessor_revision=rev-1",
	`target_identity=${RECOVER_TARGET_IDENTITY}`,
	"actor=maintainer",
	"reason=invalid authority",
].join("\n");

function scratchDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	test.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

interface RecordedNativeCall { operation: "reclaim" | "recover" | "reconcileAuthority" | "abandon" | "quarantineLegacy"; request: Record<string, unknown>; }

function fakeRecoveryNative(record: Record<string, unknown>): { native: NativeReviewCli; calls: RecordedNativeCall[]; statusReads: Array<string | undefined> } {
	const calls: RecordedNativeCall[] = [];
	const statusReads: Array<string | undefined> = [];
	const native = {
		async reclaim(request: Record<string, unknown>) {
			calls.push({ operation: "reclaim", request });
			return { record };
		},
		async recover(request: Record<string, unknown>) {
			calls.push({ operation: "recover", request });
			return { record };
		},
		async reconcileAuthority(request: Record<string, unknown>) {
			calls.push({ operation: "reconcileAuthority", request });
			return { record };
		},
		async abandon(request: Record<string, unknown>) {
			calls.push({ operation: "abandon", request });
			return { record };
		},
		async quarantineLegacy(request: Record<string, unknown>) {
			calls.push({ operation: "quarantineLegacy", request });
			return { record };
		},
		async targetStatus(request: { lineageId?: string }) {
			statusReads.push(request.lineageId);
			return recoveryTargetStatus(request.lineageId ?? "broken");
		},
	} as unknown as NativeReviewCli;
	return { native, calls, statusReads };
}

/** One recovery-eligible native target status, shaped as the provider publishes it. */
function recoveryTargetStatus(lineageId: string, overrides: Record<string, unknown> = {}): unknown {
	return {
		action: "recover",
		actionDisposition: "invalidated",
		authority: { lineageId, revision: "rev-1" },
		targetIdentity: RECOVER_TARGET_IDENTITY,
		raw: { action: "recover", target_identity: RECOVER_TARGET_IDENTITY },
		...overrides,
	};
}

async function runControllerOperation(
	parameters: Record<string, unknown>,
	native: NativeReviewCli | null,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const cwd = scratchDir("gentle-pi-native-recovery-");
	return await __testing.executeReviewControllerOperation(
		parameters,
		cwd,
		native,
		signal,
	);
}

/**
 * The registered `gentle_review` tool, driven exactly as Pi drives it. RECOVER
 * regressions hide from `executeReviewControllerOperation` alone, because the
 * defect in issue #212 lived in the authorization preflight the tool runs first.
 */
function recoveryController(native: NativeReviewCli, prefix: string): (id: string, parameters: Record<string, unknown>, context: ExtensionContext) => Promise<Record<string, unknown>> {
	const tools = new Map<string, { execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown> }>();
	const pi = { on() {}, registerTool(definition: { name: string; execute: never }) { tools.set(definition.name, definition as never); }, registerCommand() {} } as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: native })(pi);
	const controller = tools.get("gentle_review");
	assert.ok(controller);
	const cwd = scratchDir(prefix);
	return async (id, parameters, context) => {
		const result = await controller.execute(id, parameters, undefined, undefined, { ...context, cwd } as unknown as ExtensionContext) as { details: Record<string, unknown> };
		return result.details;
	};
}

/** An interactive Pi context that records every prompt it is shown. */
function interactiveContext(prompts: string[], approve = true): ExtensionContext {
	return {
		hasUI: true,
		ui: {
			async confirm(_title: string, message: string) {
				prompts.push(message);
				return approve;
			},
		},
	} as unknown as ExtensionContext;
}

const HEADLESS_CONTEXT = { hasUI: false, ui: { confirm: async () => true } } as unknown as ExtensionContext;

test("native reclaim wrapper issues the exact review reclaim command and returns the audit record", async () => {
	const { adapter, calls } = queuedAdapter([VERSION_219, { stdout: JSON.stringify(RECLAIM_RECORD) }]);
	const cli = new NativeReviewCliV214(adapter);
	const result = await cli.reclaim!({ cwd: "/repo", lineage: "stuck-lineage", actor: "maintainer", reason: "incomplete entry" });
	assert.deepEqual(result.record, RECLAIM_RECORD);
	assert.deepEqual(calls[1]?.arguments, ["review", "reclaim", "--cwd", "/repo", "--lineage", "stuck-lineage", "--actor", "maintainer", "--reason", "incomplete entry"]);
});

test("native recover wrapper issues the exact review recover command including the authorization binding", async () => {
	const { adapter, calls } = queuedAdapter([VERSION_219, { stdout: JSON.stringify(RECOVER_RECORD) }]);
	const cli = new NativeReviewCliV214(adapter);
	const result = await cli.recover!({
		cwd: "/repo",
		predecessorLineage: "broken",
		expectedPredecessorRevision: "rev-1",
		successorLineage: "successor",
		disposition: "invalidated",
		actor: "maintainer",
		reason: "invalid authority",
		maintainerAuthorization: "binding",
	});
	assert.deepEqual(result.record, RECOVER_RECORD);
	assert.deepEqual(calls[1]?.arguments, [
		"review", "recover", "--cwd", "/repo",
		"--predecessor-lineage", "broken",
		"--expected-predecessor-revision", "rev-1",
		"--successor-lineage", "successor",
		"--disposition", "invalidated",
		"--actor", "maintainer",
		"--reason", "invalid authority",
		"--maintainer-authorization", "binding",
	]);
});

test("native reconcile-authority wrapper binds the exact target revisions and authorization without a shell", async () => {
	const { adapter, calls } = queuedAdapter([VERSION_219, { stdout: JSON.stringify(RECONCILE_RESULT) }]);
	const cli = new NativeReviewCliV214(adapter);
	const result = await cli.reconcileAuthority!({
		cwd: "/repo with spaces",
		predecessorLineage: "predecessor",
		expectedPredecessorRevision: "predecessor-revision",
		successorLineage: "successor",
		expectedSuccessorRevision: "successor-revision",
		actor: "maintainer",
		reason: "invalid recovery edge",
		maintainerAuthorization: RECONCILE_AUTHORIZATION,
	});
	assert.deepEqual(result.record, RECONCILE_RECORD);
	assert.deepEqual(calls[1]?.arguments, [
		"review", "reconcile-authority", "--cwd", "/repo with spaces",
		"--predecessor-lineage", "predecessor",
		"--expected-predecessor-revision", "predecessor-revision",
		"--successor-lineage", "successor",
		"--expected-successor-revision", "successor-revision",
		"--actor", "maintainer",
		"--reason", "invalid recovery edge",
		"--maintainer-authorization", RECONCILE_AUTHORIZATION,
	]);
});

test("native v2.1.8 reconcile-authority accepts its raw audit response but modern envelopes remain strict", async () => {
	const request = {
		cwd: "/repo",
		predecessorLineage: "predecessor",
		expectedPredecessorRevision: "predecessor-revision",
		successorLineage: "successor",
		expectedSuccessorRevision: "successor-revision",
		actor: "maintainer",
		reason: "invalid recovery edge",
		maintainerAuthorization: RECONCILE_AUTHORIZATION,
	};
	const legacy = queuedAdapter([VERSION_218, { stdout: JSON.stringify(RECONCILE_RECORD) }]);
	assert.deepEqual((await new NativeReviewCliV214(legacy.adapter).reconcileAuthority!(request)).record, RECONCILE_RECORD);

	for (const [version, response] of [
		[VERSION_218, { schema: "gentle-ai.review-reconcile-audit/v1", predecessor_lineage: "predecessor" }],
		[VERSION_219, RECONCILE_RECORD],
	] as const) {
		const queue = queuedAdapter([version, { stdout: JSON.stringify(response) }]);
		await assert.rejects(
			() => new NativeReviewCliV214(queue.adapter).reconcileAuthority!(request),
			(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE,
		);
	}
});

test("native v2.1.9 maintenance wrappers use exact argv and published authorization bindings", async () => {
	const { adapter, calls } = queuedAdapter([
		VERSION_219, { stdout: JSON.stringify({ operation: "review/abandon", record: ABANDON_RECORD }) },
		VERSION_219, { stdout: JSON.stringify({ operation: "review/quarantine-legacy", record: LEGACY_QUARANTINE_RECORD }) },
		VERSION_219, { stdout: JSON.stringify({ operation: "review/reconcile-authority", record: RECONCILE_RECORD }) },
	]);
	const cli = new NativeReviewCliV214(adapter);
	assert.deepEqual((await cli.abandon!({ ...ABANDON_REQUEST })).record, ABANDON_RECORD);
	assert.deepEqual((await cli.quarantineLegacy!({ cwd: "/repo", repository: "/repo", lineage: "legacy", expectedRevision: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", diagnostic: LEGACY_FREEZE_DIAGNOSTIC, disposition: LEGACY_FREEZE_DISPOSITION, actor: "maintainer", reason: "quarantine malformed legacy freeze", maintainerAuthorization: LEGACY_QUARANTINE_AUTHORIZATION })).record, LEGACY_QUARANTINE_RECORD);
	assert.deepEqual((await cli.reconcileAuthority!({ cwd: "/repo", predecessorLineage: "predecessor", expectedPredecessorRevision: "predecessor-revision", successorLineage: "successor", expectedSuccessorRevision: "successor-revision", actor: "maintainer", reason: "invalid recovery edge", anomalies: COMBINED_RECONCILE_ANOMALIES, maintainerAuthorization: COMBINED_RECONCILE_AUTHORIZATION })).record, RECONCILE_RECORD);
	assert.deepEqual(calls.filter((call) => call.arguments[0] === "review").map((call) => call.arguments), [
		["review", "abandon", "--cwd", "/repo", "--lineage", "pristine", "--expected-revision", "revision", "--actor", "maintainer", "--reason", "retire pristine lineage", "--maintainer-authorization", ABANDON_AUTHORIZATION],
		["review", "quarantine-legacy", "--cwd", "/repo", "--lineage", "legacy", "--expected-revision", "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "--diagnostic", LEGACY_FREEZE_DIAGNOSTIC, "--disposition", LEGACY_FREEZE_DISPOSITION, "--actor", "maintainer", "--reason", "quarantine malformed legacy freeze", "--maintainer-authorization", LEGACY_QUARANTINE_AUTHORIZATION],
		["review", "reconcile-authority", "--cwd", "/repo", "--predecessor-lineage", "predecessor", "--expected-predecessor-revision", "predecessor-revision", "--successor-lineage", "successor", "--expected-successor-revision", "successor-revision", "--actor", "maintainer", "--reason", "invalid recovery edge", "--maintainer-authorization", COMBINED_RECONCILE_AUTHORIZATION],
	]);
});

test("native v2.2.0 repair-legacy-alias uses the exact fixed binding and preserves idempotent audit records", async () => {
	const { adapter, calls } = queuedAdapter([
		VERSION_220,
		{ stdout: JSON.stringify({ operation: "review/repair-legacy-alias", record: LEGACY_ALIAS_RECORD }) },
	]);
	const cli = new NativeReviewCliV214(adapter);
	const request = {
		cwd: "/repo",
		repository: "/repo",
		lineage: "legacy-alias",
		expectedRevision: `sha256:${"c".repeat(64)}`,
		diagnostic: LEGACY_ALIAS_DIAGNOSTIC,
		disposition: LEGACY_ALIAS_DISPOSITION,
		actor: "maintainer",
		reason: "quarantine approved historical alias",
		maintainerAuthorization: LEGACY_ALIAS_AUTHORIZATION,
	};
	assert.equal(nativeReviewLegacyAliasRepairAuthorization(request), LEGACY_ALIAS_AUTHORIZATION);
	assert.deepEqual((await cli.repairLegacyAlias!(request)).record, LEGACY_ALIAS_RECORD);
	assert.deepEqual(calls[1]?.arguments, [
		"review", "repair-legacy-alias", "--cwd", "/repo", "--lineage", "legacy-alias",
		"--expected-revision", `sha256:${"c".repeat(64)}`,
		"--diagnostic", LEGACY_ALIAS_DIAGNOSTIC,
		"--disposition", LEGACY_ALIAS_DISPOSITION,
		"--actor", "maintainer", "--reason", "quarantine approved historical alias",
		"--maintainer-authorization", LEGACY_ALIAS_AUTHORIZATION,
	]);
});

// Task 11.1 (migrate-review-integration-v2): `repairLegacyAlias` above stays
// unnegotiated and carries no --contract (asserted at :281-288). The net-new
// negotiated `repair()` is a DIFFERENT operation and must carry --contract on
// every invocation, including the capabilities preflight `negotiated()` runs
// first. A non-eligible preflight assessment lets this test stop after one
// repair call, without needing a second queued execute-mode response.
test("negotiated repair carries --contract on every invocation, unlike repair-legacy-alias", async (t) => {
	t.after(() => clearNativeReviewCapabilitiesCacheForTesting());
	const capabilities = v2Fixture<Record<string, unknown>>("capabilities.fixture.json");
	const executableDigest = "dcc846103b16d365eaeeb9d7f289c23fc4f2897f23def1cb3fe7f05557b64705";
	const capabilitiesBody = { ...capabilities, package: { ...(capabilities.package as Record<string, unknown>), version: GENTLE_AI_VERSION } };
	const preflightResult = {
		schema: "gentle-ai.review-integration.repair/v2",
		contract: "gentle-ai.review-integration/v2",
		operation: "review.repair",
		mode: "preflight",
		assessment: {
			schema: "gentle-ai.review-authority-repair-assessment/v1",
			status: "unsupported",
			counts: { lineages: 0, compact_lineages: 0, legacy_lineages: 0, events: 0, bytes: 0, eligible_candidates: 0, unsupported_lineages: 0, conflicts: 0 },
			supported_operations: ["review/complete-fix", "review/validate-fix"],
			authorization_schema: "gentle-ai.review-repair-authorization/v1",
		},
		required_inputs: [],
	};
	const { adapter, calls } = queuedAdapter([
		{ stdout: JSON.stringify(capabilitiesBody) },
		{ stdout: JSON.stringify(preflightResult) },
	]);
	const cli = new NativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024, async () => undefined, () => executableDigest);
	const result = await cli.repair!({ cwd: "/repo", actor: "maintainer", reason: "quarantine approved historical alias", maintainerAuthorization: "irrelevant-for-non-eligible-preflight" });
	assert.equal(result.mode, "preflight");
	assert.equal(result.assessment.status, "unsupported");
	assert.equal(calls.length, 2, "a non-eligible preflight must never issue an execute-mode call");
	assert.deepEqual(calls[0]?.arguments, ["review", "capabilities", "--contract", "gentle-ai.review-integration/v2"]);
	assert.deepEqual(calls[1]?.arguments, ["review", "repair", "--contract", "gentle-ai.review-integration/v2", "--cwd", "/repo", "--mode", "preflight"]);
	for (const call of calls) assert.ok(call.arguments.includes("--contract"), "every negotiated repair() invocation must carry --contract");
});

test("native repair-legacy-alias fails closed for stale bindings, malformed output, cancellation, and partial failure", async () => {
	const request = {
		cwd: "/repo", repository: "/repo", lineage: "legacy-alias", expectedRevision: `sha256:${"c".repeat(64)}`,
		diagnostic: LEGACY_ALIAS_DIAGNOSTIC, disposition: LEGACY_ALIAS_DISPOSITION, actor: "maintainer", reason: "quarantine approved historical alias", maintainerAuthorization: LEGACY_ALIAS_AUTHORIZATION,
	};
	const stale = queuedAdapter([]);
	await assert.rejects(() => new NativeReviewCliV214(stale.adapter).repairLegacyAlias!({ ...request, expectedRevision: `sha256:${"d".repeat(64)}` }), /exact repository, lineage, revision/);
	assert.equal(stale.calls.length, 0);
	for (const result of [
		{ stdout: JSON.stringify({ operation: "review/repair-legacy-alias" }) },
		{ stdout: JSON.stringify({ operation: "review/repair-legacy-alias", record: LEGACY_ALIAS_RECORD }), stderr: "interrupted", exitCode: 1 },
	]) {
		const queue = queuedAdapter([VERSION_220, result]);
		await assert.rejects(
			() => new NativeReviewCliV214(queue.adapter).repairLegacyAlias!(request),
			(error: unknown) => error instanceof NativeReviewCliError
				&& (result.exitCode === 1 ? error.auditRecord?.schema === LEGACY_ALIAS_RECORD.schema : error.code === NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE),
		);
	}
});

test("native v2.1.9 maintenance wrappers fail closed before launch for unsupported versions and invalid bindings", async () => {
	const unsupported = queuedAdapter([{ stdout: "gentle-ai 2.1.8\n" }]);
	await assert.rejects(() => new NativeReviewCliV214(unsupported.adapter).abandon!({ ...ABANDON_REQUEST }), NativeReviewCliError);
	const invalid = queuedAdapter([]);
	await assert.rejects(() => new NativeReviewCliV214(invalid.adapter).reconcileAuthority!({ cwd: "/repo", predecessorLineage: "predecessor", expectedPredecessorRevision: "predecessor-revision", successorLineage: "successor", expectedSuccessorRevision: "successor-revision", actor: "maintainer", reason: "invalid recovery edge", anomalies: "malformed_recovery_authorization,unchanged_target", maintainerAuthorization: COMBINED_RECONCILE_AUTHORIZATION }), TypeError);
	assert.equal(invalid.calls.length, 0);
});

test("native v2.1.9 maintenance wrappers preserve only valid prepared audit records on partial failures", async () => {
	for (const [operation, invoke, result] of [
		["review/abandon", (cli: NativeReviewCliV214) => cli.abandon!({ ...ABANDON_REQUEST }), ABANDON_RECORD],
		["review/quarantine-legacy", (cli: NativeReviewCliV214) => cli.quarantineLegacy!({ cwd: "/repo", repository: "/repo", lineage: "legacy", expectedRevision: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", diagnostic: LEGACY_FREEZE_DIAGNOSTIC, disposition: LEGACY_FREEZE_DISPOSITION, actor: "maintainer", reason: "quarantine malformed legacy freeze", maintainerAuthorization: LEGACY_QUARANTINE_AUTHORIZATION }), LEGACY_QUARANTINE_RECORD],
	] as const) {
		const queue = queuedAdapter([VERSION_219, { stdout: JSON.stringify({ operation, record: result }), stderr: "quarantine interrupted", exitCode: 1 }]);
		await assert.rejects(() => invoke(new NativeReviewCliV214(queue.adapter)), (error: unknown) => error instanceof NativeReviewCliError && error.mutationOutcome === "unknown" && error.nextAction === "review.status" && error.auditRecord?.schema === result.schema);
	}
	const malformed = queuedAdapter([VERSION_219, { stdout: JSON.stringify({ operation: "review/abandon" }), exitCode: 1 }]);
	await assert.rejects(() => new NativeReviewCliV214(malformed.adapter).abandon!({ ...ABANDON_REQUEST }), (error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE && error.auditRecord === undefined);
});

test("native abandon forwards cancellation and preserves the unknown mutation outcome", async () => {
	const controller = new AbortController();
	let calls = 0;
	const adapter: ExecFileAdapter = async (request) => {
		calls += 1;
		if (calls === 1) return { ...VERSION_219, stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
		assert.equal(request.signal, controller.signal);
		const error = new Error("cancelled");
		error.name = "AbortError";
		throw error;
	};
	await assert.rejects(() => new NativeReviewCliV214(adapter).abandon!({ ...ABANDON_REQUEST, signal: controller.signal }), (error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.CANCELLED && error.mutationOutcome === "unknown" && error.nextAction === "review.status");
});

test("native abandon authorization emits the exact nine-line v2 discarded-work binding", () => {
	assert.equal(
		nativeReviewAbandonAuthorization({
			lineage: "pristine",
			expectedRevision: "revision",
			snapshotIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			actor: "  maintainer  ",
			reason: "operator_disposition",
			capturedLensResults: ["00-risk.json", "01-readability.json"],
			findingsPresent: true,
			evidenceRecordsPresent: false,
		}),
		[
			"gentle-ai.review-abandon-authorization/v2",
			"lineage=pristine",
			"revision=revision",
			"snapshot_identity=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"reason=operator_disposition",
			"captured_lens_results=00-risk.json,01-readability.json",
			"findings_present=true",
			"evidence_records_present=false",
			"actor=maintainer",
		].join("\n"),
	);
	assert.equal(
		nativeReviewAbandonAuthorization({
			lineage: "pristine",
			expectedRevision: "revision",
			snapshotIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			actor: "maintainer",
			reason: "retired_schema",
			capturedLensResults: [],
			findingsPresent: false,
			evidenceRecordsPresent: true,
		}),
		[
			"gentle-ai.review-abandon-authorization/v2",
			"lineage=pristine",
			"revision=revision",
			"snapshot_identity=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"reason=retired_schema",
			"captured_lens_results=",
			"findings_present=false",
			"evidence_records_present=true",
			"actor=maintainer",
		].join("\n"),
	);
});

test("native abandon refuses the legacy v1 authorization binding before process launch", async () => {
	const { adapter, calls } = queuedAdapter([]);
	await assert.rejects(
		() => new NativeReviewCliV214(adapter).abandon!({ ...ABANDON_REQUEST, maintainerAuthorization: LEGACY_V1_ABANDON_AUTHORIZATION }),
		TypeError,
	);
	assert.equal(calls.length, 0);
});

test("native abandon validates discarded-work inputs before process launch", async () => {
	const { adapter, calls } = queuedAdapter([]);
	const cli = new NativeReviewCliV214(adapter);
	await assert.rejects(() => cli.abandon!({ ...ABANDON_REQUEST, capturedLensResults: "00-risk.json" as unknown as string[] }), /capturedLensResults/);
	await assert.rejects(() => cli.abandon!({ ...ABANDON_REQUEST, capturedLensResults: ["00-risk.json", " padded "] }), /capturedLensResults/);
	await assert.rejects(() => cli.abandon!({ ...ABANDON_REQUEST, findingsPresent: "true" as unknown as boolean }), /findingsPresent/);
	await assert.rejects(() => cli.abandon!({ ...ABANDON_REQUEST, evidenceRecordsPresent: undefined as unknown as boolean }), /evidenceRecordsPresent/);
	assert.equal(calls.length, 0);
});

test("native reconcile-authority refuses a mismatched authorization before process launch", async () => {
	const { adapter, calls } = queuedAdapter([]);
	const cli = new NativeReviewCliV214(adapter);
	await assert.rejects(
		cli.reconcileAuthority!({
			cwd: "/repo",
			predecessorLineage: "predecessor",
			expectedPredecessorRevision: "predecessor-revision",
			successorLineage: "successor",
			expectedSuccessorRevision: "changed-revision",
			actor: "maintainer",
			reason: "invalid recovery edge",
			maintainerAuthorization: RECONCILE_AUTHORIZATION,
		}),
		/exact target and revision binding/,
	);
	assert.equal(calls.length, 0);
});

test("native reconcile-authority forwards cancellation and preserves unknown mutation outcome", async () => {
	const controller = new AbortController();
	let calls = 0;
	const adapter: ExecFileAdapter = async (request) => {
		calls += 1;
		if (calls === 1) return { ...VERSION_219, stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
		assert.equal(request.signal, controller.signal);
		const error = new Error("cancelled");
		error.name = "AbortError";
		throw error;
	};
	const cli = new NativeReviewCliV214(adapter);
	await assert.rejects(
		cli.reconcileAuthority!({
			cwd: "/repo",
			predecessorLineage: "predecessor",
			expectedPredecessorRevision: "predecessor-revision",
			successorLineage: "successor",
			expectedSuccessorRevision: "successor-revision",
			actor: "maintainer",
			reason: "invalid recovery edge",
			maintainerAuthorization: RECONCILE_AUTHORIZATION,
			signal: controller.signal,
		}),
		(error: unknown) => error instanceof NativeReviewCliError
			&& error.code === NATIVE_REVIEW_ERROR_CODE.CANCELLED
			&& error.operation === "review/reconcile-authority"
			&& error.mutationOutcome === "unknown",
	);
});

test("native reconcile-authority preserves the prepared audit record on partial failure", async () => {
	const { adapter } = queuedAdapter([VERSION_219, { stdout: JSON.stringify(RECONCILE_RESULT), stderr: "quarantine interrupted", exitCode: 1 }]);
	const cli = new NativeReviewCliV214(adapter);
	await assert.rejects(
		cli.reconcileAuthority!({
			cwd: "/repo",
			predecessorLineage: "predecessor",
			expectedPredecessorRevision: "predecessor-revision",
			successorLineage: "successor",
			expectedSuccessorRevision: "successor-revision",
			actor: "maintainer",
			reason: "invalid recovery edge",
			maintainerAuthorization: RECONCILE_AUTHORIZATION,
		}),
		(error: unknown) => error instanceof NativeReviewCliError
			&& error.mutationOutcome === "unknown"
			&& error.nextAction === "review.status"
			&& error.auditRecord?.schema === RECONCILE_RECORD.schema,
	);
});

test("native recovery wrappers accept the published 2.1.9 contract and refuse older recovery binaries", async () => {
	const { adapter } = queuedAdapter([{ stdout: "gentle-ai 2.1.7\n" }]);
	const cli = new NativeReviewCliV214(adapter);
	await assert.rejects(
		cli.reclaim!({ cwd: "/repo", lineage: "stuck", actor: "maintainer", reason: "incomplete" }),
		(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.VERSION_INCOMPATIBLE,
	);
});

test("RESET maps to native review reclaim with the exact audited inputs", async () => {
	const { native, calls } = fakeRecoveryNative(RECLAIM_RECORD);
	const details = await runControllerOperation({
		operation: "reset",
		input: JSON.stringify({
			repositoryId: "repo-id",
			commonDirHash: "c".repeat(64),
			inventoryHash: "d".repeat(64),
			confirmation: "DESTROY REVIEW AUTHORITY repo-id",
			lineage: "stuck-lineage",
			actor: "maintainer",
			reason: "incomplete entry",
		}),
	}, native);
	assert.equal(details.operation, "reset");
	assert.equal(details.native_operation, "review reclaim");
	assert.equal(details.mutation_performed, true);
	assert.equal(details.mutation_outcome, "committed");
	assert.deepEqual(details.result, RECLAIM_RECORD);
	assert.equal(details.next_action, "inspect");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.operation, "reclaim");
	assert.equal(calls[0]?.request.lineage, "stuck-lineage");
	assert.equal(calls[0]?.request.actor, "maintainer");
	assert.equal(calls[0]?.request.reason, "incomplete entry");
});

test("RESET without the native reclaim inputs returns a structured request instead of inventing values", async () => {
	const { native, calls } = fakeRecoveryNative(RECLAIM_RECORD);
	const details = await runControllerOperation({
		operation: "reset",
		input: JSON.stringify({
			repositoryId: "repo-id",
			commonDirHash: "c".repeat(64),
			inventoryHash: "d".repeat(64),
			confirmation: "DESTROY REVIEW AUTHORITY repo-id",
		}),
	}, native);
	assert.equal(details.status, "blocked");
	assert.equal(details.outcome, "native-input-required");
	assert.equal(details.native_operation, "review reclaim");
	assert.deepEqual(details.missing_input, ["lineage", "actor", "reason"]);
	assert.equal(details.mutation_performed, false);
	assert.equal(details.mutation_outcome, "none");
	assert.equal(calls.length, 0);
});

test("RESET without a native client fails closed as unavailable", async () => {
	const details = await runControllerOperation({
		operation: "reset",
		input: JSON.stringify({ lineage: "stuck", actor: "maintainer", reason: "incomplete" }),
	}, null);
	assert.equal(details.status, "blocked");
	assert.equal(details.outcome, "native-recovery-unavailable");
	assert.equal(details.native_operation, "review reclaim");
	assert.equal(details.mutation_performed, false);
});

// Issue #212: `authorizeDestructiveReviewOperation` classified native RECOVER as
// a legacy repository-wide RESET, so a correct six-field native recovery was
// refused with "Review controller recover requires an exact string repositoryId"
// before it ever reached the native router. INSPECT does not publish that
// quartet for compact-v2 recovery, which left the only supported flow
// unreachable. Reported by @PwnLabsmx, independently reproduced on macOS by
// @e-Evolution and again by the maintainer.
//
// Every RECOVER test below drives the registered tool rather than
// `executeReviewControllerOperation`, because the defect lived in the
// authorization preflight the tool runs before that function.
test("RECOVER accepts the six canonical native inputs without the legacy RESET challenge", async () => {
	const { native, calls, statusReads } = fakeRecoveryNative(RECOVER_RECORD);
	const run = recoveryController(native, "gentle-pi-recover-six-field-");
	const prompts: string[] = [];
	const details = await run("recover", { operation: "recover", input: JSON.stringify(RECOVER_INPUT) }, interactiveContext(prompts));
	assert.equal(details.status, undefined, "the native six-field recovery contract is complete on its own");
	assert.equal(details.native_operation, "review recover");
	assert.equal(details.mutation_performed, true);
	assert.deepEqual(details.result, RECOVER_RECORD);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.operation, "recover");
	assert.equal(calls[0]?.request.predecessorLineage, "broken");
	assert.equal(calls[0]?.request.expectedPredecessorRevision, "rev-1");
	assert.equal(calls[0]?.request.successorLineage, "successor");
	assert.equal(calls[0]?.request.disposition, "invalidated");
	// Pi derives the binding; it is never the caller's to supply.
	assert.equal(calls[0]?.request.maintainerAuthorization, RECOVER_AUTHORIZATION);
	assert.equal(prompts.length, 1);
	assert.match(prompts[0]!, /gentle-ai\.review-recovery-authorization\/v1/);
	assert.match(prompts[0]!, new RegExp(`target_identity=${RECOVER_TARGET_IDENTITY}`));
	assert.match(prompts[0]!, /Provider-selected disposition: invalidated/);
	assert.equal(prompts[0]!.includes("repositoryId"), false, "the legacy reset challenge has no place in native recovery");
	// Status is read before approval and read again before mutation.
	assert.deepEqual(statusReads, ["broken", "broken"]);
});

test("RECOVER rejects a caller-supplied maintainerAuthorization before reading or prompting", async () => {
	const { native, calls, statusReads } = fakeRecoveryNative(RECOVER_RECORD);
	const run = recoveryController(native, "gentle-pi-recover-caller-authorization-");
	const prompts: string[] = [];
	const details = await run(
		"recover",
		{ operation: "recover", input: JSON.stringify({ ...RECOVER_INPUT, maintainerAuthorization: RECOVER_AUTHORIZATION }) },
		interactiveContext(prompts),
	);
	assert.equal(details.status, "blocked");
	assert.equal(details.outcome, "native-recovery-caller-authorization-rejected");
	assert.equal(details.mutation_performed, false);
	assert.equal(details.mutation_outcome, "none");
	assert.equal(details.next_action, "resubmit-without-maintainer-authorization");
	assert.equal(calls.length, 0);
	assert.deepEqual(statusReads, []);
	assert.deepEqual(prompts, []);
});

test("RECOVER fails closed without an interactive Pi UI", async () => {
	const { native, calls, statusReads } = fakeRecoveryNative(RECOVER_RECORD);
	const run = recoveryController(native, "gentle-pi-recover-headless-");
	await assert.rejects(
		run("recover", { operation: "recover", input: JSON.stringify(RECOVER_INPUT) }, HEADLESS_CONTEXT),
		/Review controller RECOVER requires fresh explicit authorization through the interactive Pi UI; headless execution fails closed/,
	);
	assert.equal(calls.length, 0);
	// Fresh native evidence is read, but nothing mutates without a human.
	assert.deepEqual(statusReads, ["broken"]);
});

test("RECOVER refuses to mutate when the human declines the derived binding", async () => {
	const { native, calls } = fakeRecoveryNative(RECOVER_RECORD);
	const run = recoveryController(native, "gentle-pi-recover-declined-");
	const prompts: string[] = [];
	await assert.rejects(
		run("recover", { operation: "recover", input: JSON.stringify(RECOVER_INPUT) }, interactiveContext(prompts, false)),
		/Review controller RECOVER was not explicitly authorized/,
	);
	assert.equal(prompts.length, 1);
	assert.equal(calls.length, 0);
});

test("RECOVER refuses a foreign, stale, or no-longer-recoverable authority before prompting", async () => {
	for (const [label, status] of [
		["foreign", recoveryTargetStatus("someone-elses-lineage")],
		["stale", recoveryTargetStatus("broken", { authority: { lineageId: "broken", revision: "rev-2" } })],
		["not recovery-eligible", recoveryTargetStatus("broken", { action: "start", actionDisposition: undefined })],
	] as const) {
		const calls: Record<string, unknown>[] = [];
		const native = {
			async recover(request: Record<string, unknown>) { calls.push(request); return { record: RECOVER_RECORD }; },
			async targetStatus() { return status; },
		} as unknown as NativeReviewCli;
		const run = recoveryController(native, `gentle-pi-recover-${label.replace(/[^a-z]+/g, "-")}-`);
		const prompts: string[] = [];
		const details = await run("recover", { operation: "recover", input: JSON.stringify(RECOVER_INPUT) }, interactiveContext(prompts));
		assert.equal(details.status, "blocked", label);
		assert.equal(details.outcome, "native-recovery-status-mismatch", label);
		assert.equal(details.mutation_performed, false, label);
		assert.equal(calls.length, 0, label);
		assert.deepEqual(prompts, [], label);
	}
});

test("RECOVER refuses a disposition the provider did not select", async () => {
	const { native, calls } = fakeRecoveryNative(RECOVER_RECORD);
	const run = recoveryController(native, "gentle-pi-recover-disposition-");
	const prompts: string[] = [];
	const details = await run("recover", { operation: "recover", input: JSON.stringify({ ...RECOVER_INPUT, disposition: "escalated" }) }, interactiveContext(prompts));
	assert.equal(details.status, "blocked");
	assert.equal(details.outcome, "native-recovery-disposition-mismatch");
	assert.equal(details.provider_disposition, "invalidated");
	assert.equal(details.mutation_performed, false);
	assert.equal(calls.length, 0);
	assert.deepEqual(prompts, []);
});

// The human deliberates for an unbounded interval. An authority that advanced
// while they were deciding was never the one they approved, so the approval and
// its derived binding are pinned and re-checked against a fresh read.
test("RECOVER refuses to mutate when the authority changes between approval and mutation", async () => {
	for (const [label, drifted] of [
		["revision advanced", recoveryTargetStatus("broken", { authority: { lineageId: "broken", revision: "rev-2" } })],
		["target identity moved", recoveryTargetStatus("broken", { targetIdentity: `sha256:${"f".repeat(64)}` })],
		["disposition changed", recoveryTargetStatus("broken", { actionDisposition: "escalated" })],
		["no longer recoverable", recoveryTargetStatus("broken", { action: "start", actionDisposition: undefined })],
	] as const) {
		const calls: Record<string, unknown>[] = [];
		let reads = 0;
		const native = {
			async recover(request: Record<string, unknown>) { calls.push(request); return { record: RECOVER_RECORD }; },
			async targetStatus() {
				reads += 1;
				return reads === 1 ? recoveryTargetStatus("broken") : drifted;
			},
		} as unknown as NativeReviewCli;
		const run = recoveryController(native, `gentle-pi-recover-toctou-${label.replace(/[^a-z]+/g, "-")}-`);
		const prompts: string[] = [];
		const details = await run("recover", { operation: "recover", input: JSON.stringify(RECOVER_INPUT) }, interactiveContext(prompts));
		assert.equal(prompts.length, 1, label);
		assert.equal(reads, 2, label);
		assert.equal(details.status, "blocked", label);
		assert.equal(details.outcome, "native-recovery-authority-changed", label);
		assert.equal(details.mutation_performed, false, label);
		assert.equal(details.mutation_outcome, "none", label);
		assert.equal(details.next_action, "reinspect-and-reauthorize-recovery", label);
		assert.equal(calls.length, 0, label);
	}
});

test("RECOVER surfaces every missing successor input including an unsupported disposition", async () => {
	const { native, calls, statusReads } = fakeRecoveryNative(RECOVER_RECORD);
	const run = recoveryController(native, "gentle-pi-recover-missing-input-");
	const prompts: string[] = [];
	const details = await run(
		"recover",
		{ operation: "recover", input: JSON.stringify({ predecessorLineage: "broken", disposition: "not-a-disposition" }) },
		interactiveContext(prompts),
	);
	assert.equal(details.outcome, "native-input-required");
	assert.equal(details.native_operation, "review recover");
	// The missing inputs are the native six, never the legacy reset quartet.
	assert.deepEqual(details.missing_input, ["expectedPredecessorRevision", "successorLineage", "disposition", "actor", "reason"]);
	assert.equal(calls.length, 0);
	assert.deepEqual(statusReads, []);
	assert.deepEqual(prompts, []);
});

test("RECONCILE_AUTHORITY routes one exact native mutation and returns its audit record", async () => {
	const { native, calls } = fakeRecoveryNative(RECONCILE_RECORD);
	const details = await runControllerOperation({
		operation: "reconcile-authority",
		input: JSON.stringify({
			predecessorLineage: "predecessor",
			expectedPredecessorRevision: "predecessor-revision",
			successorLineage: "successor",
			expectedSuccessorRevision: "successor-revision",
			actor: "maintainer",
			reason: "invalid recovery edge",
		}),
	}, native);
	assert.equal(details.operation, "reconcile-authority");
	assert.equal(details.native_operation, "review reconcile-authority");
	assert.equal(details.mutation_performed, true);
	assert.equal(details.mutation_outcome, "committed");
	assert.deepEqual(details.result, RECONCILE_RECORD);
	assert.equal(details.next_action, "inspect");
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.operation, "reconcileAuthority");
	assert.equal(calls[0]?.request.expectedPredecessorRevision, "predecessor-revision");
	assert.equal(calls[0]?.request.expectedSuccessorRevision, "successor-revision");
	assert.equal(calls[0]?.request.maintainerAuthorization, RECONCILE_AUTHORIZATION);
});

test("RECONCILE_AUTHORITY requests every exact native binding before authorization or mutation", async () => {
	const { native, calls } = fakeRecoveryNative(RECONCILE_RECORD);
	const details = await runControllerOperation({ operation: "reconcile-authority", input: "{}" }, native);
	assert.equal(details.status, "blocked");
	assert.equal(details.outcome, "native-input-required");
	assert.deepEqual(details.missing_input, ["predecessorLineage", "expectedPredecessorRevision", "successorLineage", "expectedSuccessorRevision", "actor", "reason"]);
	assert.equal(details.mutation_performed, false);
	assert.equal(details.mutation_outcome, "none");
	assert.equal(calls.length, 0);
});

test("RECONCILE_AUTHORITY returns a typed fail-closed envelope for native cancellation", async () => {
	const native = {
		async reconcileAuthority() {
			throw new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.CANCELLED, "review/reconcile-authority", true, true, "native process was cancelled");
		},
	} as unknown as NativeReviewCli;
	const details = await runControllerOperation({
		operation: "reconcile-authority",
		input: JSON.stringify({
			predecessorLineage: "predecessor",
			expectedPredecessorRevision: "predecessor-revision",
			successorLineage: "successor",
			expectedSuccessorRevision: "successor-revision",
			actor: "maintainer",
			reason: "invalid recovery edge",
		}),
	}, native);
	assert.equal(details.status, "blocked");
	assert.equal(details.outcome, "native-operation-failed");
	assert.equal(details.mutation_outcome, "unknown");
	assert.equal(details.replayability, "status_required");
	assert.equal(details.next_action, "review.status");
	assert.deepEqual(details.diagnostics, {
		operation: "review/reconcile-authority",
		error_code: "cancelled",
		timed_out: false,
		output_limit_exceeded: false,
	});
});

test("RECONCILE_AUTHORITY relays a partial-failure audit record without weakening status reconciliation", async () => {
	const native = {
		async reconcileAuthority() {
			throw new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, "review/reconcile-authority", true, true, "partial failure", undefined, RECONCILE_RECORD);
		},
	} as unknown as NativeReviewCli;
	const details = await runControllerOperation({
		operation: "reconcile-authority",
		input: JSON.stringify({ predecessorLineage: "predecessor", expectedPredecessorRevision: "predecessor-revision", successorLineage: "successor", expectedSuccessorRevision: "successor-revision", actor: "maintainer", reason: "invalid recovery edge" }),
	}, native);
	assert.equal(details.mutation_outcome, "unknown");
	assert.equal(details.next_action, "review.status");
	assert.deepEqual(details.native_audit_record, RECONCILE_RECORD);
});

test("RECOVER_LOCK still requires the exact ownerHash before routing to native reclaim", async () => {
	const { native, calls } = fakeRecoveryNative(RECLAIM_RECORD);
	await assert.rejects(
		runControllerOperation({ operation: "recover-lock", input: JSON.stringify({ lineage: "stuck", actor: "maintainer", reason: "stale lock" }) }, native),
		/ownerHash/,
	);
	assert.equal(calls.length, 0);
	const details = await runControllerOperation({
		operation: "recover-lock",
		input: JSON.stringify({ ownerHash: "a".repeat(64), lineage: "stuck", actor: "maintainer", reason: "stale lock" }),
	}, native);
	assert.equal(details.native_operation, "review reclaim");
	assert.equal(details.mutation_performed, true);
	assert.deepEqual(details.result, RECLAIM_RECORD);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.operation, "reclaim");
	assert.equal(calls[0]?.request.lineage, "stuck");
});

test("RECOVER_LOCK without the native reclaim inputs requests them explicitly", async () => {
	const { native, calls } = fakeRecoveryNative(RECLAIM_RECORD);
	const details = await runControllerOperation({
		operation: "recover-lock",
		input: JSON.stringify({ ownerHash: "a".repeat(64) }),
	}, native);
	assert.equal(details.outcome, "native-input-required");
	assert.deepEqual(details.missing_input, ["lineage", "actor", "reason"]);
	assert.equal(calls.length, 0);
});

test("destructive RESET still fails closed without fresh interactive authorization", async () => {
	const tools = new Map<string, { execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown> }>();
	const pi = {
		on() {},
		registerTool(definition: { name: string; execute: never }) {
			tools.set(definition.name, definition as unknown as { execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown> });
		},
		registerCommand() {},
	} as unknown as ExtensionAPI;
	const { native, calls } = fakeRecoveryNative(RECLAIM_RECORD);
	createGentleAiExtension({ nativeReviewCli: native })(pi);
	const controller = tools.get("gentle_review");
	assert.ok(controller);
	const cwd = scratchDir("gentle-pi-native-recovery-headless-");
	const ctx = { cwd, hasUI: false, ui: { confirm: async () => true } } as unknown as ExtensionContext;
	await assert.rejects(
		controller.execute("headless-reset", {
			operation: "reset",
			input: JSON.stringify({
				repositoryId: "repo-id",
				commonDirHash: "c".repeat(64),
				inventoryHash: "d".repeat(64),
				confirmation: "DESTROY REVIEW AUTHORITY repo-id",
				lineage: "stuck",
				actor: "maintainer",
				reason: "incomplete",
			}),
		}, undefined, undefined, ctx),
		/interactive Pi UI.*fails closed/i,
	);
	assert.equal(calls.length, 0);
});

// Regression guard for issue #212: separating RECOVER out must leave the legacy
// repository-wide RESET challenge exactly as it was.
test("RESET still demands the complete legacy repository challenge and its own fresh approval", async () => {
	const tools = new Map<string, { execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown> }>();
	const pi = { on() {}, registerTool(definition: { name: string; execute: never }) { tools.set(definition.name, definition as never); }, registerCommand() {} } as unknown as ExtensionAPI;
	const { native, calls } = fakeRecoveryNative(RECLAIM_RECORD);
	createGentleAiExtension({ nativeReviewCli: native })(pi);
	const controller = tools.get("gentle_review");
	assert.ok(controller);
	const cwd = scratchDir("gentle-pi-native-reset-challenge-");
	const challenge = {
		repositoryId: "repo-id",
		commonDirHash: "c".repeat(64),
		inventoryHash: "d".repeat(64),
		confirmation: "DESTROY REVIEW AUTHORITY repo-id",
	};
	const reclaim = { lineage: "stuck", actor: "maintainer", reason: "incomplete" };
	for (const key of ["repositoryId", "commonDirHash", "inventoryHash", "confirmation"] as const) {
		const incomplete: Record<string, unknown> = { ...challenge, ...reclaim };
		delete incomplete[key];
		await assert.rejects(
			controller.execute(`reset-missing-${key}`, { operation: "reset", input: JSON.stringify(incomplete) }, undefined, undefined, {
				cwd, hasUI: true, ui: { confirm: async () => true },
			} as unknown as ExtensionContext),
			new RegExp(`Review controller reset requires an exact string ${key}`),
		);
	}
	assert.equal(calls.length, 0);
	let prompt = "";
	const approved = await controller.execute("approved-reset", { operation: "reset", input: JSON.stringify({ ...challenge, ...reclaim }) }, undefined, undefined, {
		cwd,
		hasUI: true,
		ui: { confirm: async (_title: string, message: string) => { prompt = message; return true; } },
	} as unknown as ExtensionContext) as { details: Record<string, unknown> };
	assert.match(prompt, /Repository: repo-id/);
	assert.match(prompt, /Exact challenge: DESTROY REVIEW AUTHORITY repo-id/);
	assert.match(prompt, /This invalidates all prior review authority for this repository\./);
	assert.equal(approved.details.mutation_performed, true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.operation, "reclaim");
});

test("RECONCILE_AUTHORITY requires fresh Pi approval for the exact seven-line binding", async () => {
	const tools = new Map<string, { execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown> }>();
	const pi = {
		on() {},
		registerTool(definition: { name: string; execute: never }) { tools.set(definition.name, definition as never); },
		registerCommand() {},
	} as unknown as ExtensionAPI;
	const { native, calls } = fakeRecoveryNative(RECONCILE_RECORD);
	createGentleAiExtension({ nativeReviewCli: native })(pi);
	const controller = tools.get("gentle_review");
	assert.ok(controller);
	const cwd = scratchDir("gentle-pi-native-reconcile-authorization-");
	const parameters = {
		operation: "reconcile-authority",
		input: JSON.stringify({
			predecessorLineage: "predecessor",
			expectedPredecessorRevision: "predecessor-revision",
			successorLineage: "successor",
			expectedSuccessorRevision: "successor-revision",
			actor: "maintainer",
			reason: "invalid recovery edge",
		}),
	};
	await assert.rejects(
		controller.execute("headless-reconcile", parameters, undefined, undefined, { cwd, hasUI: false, ui: { confirm: async () => true } } as unknown as ExtensionContext),
		/interactive Pi UI.*fails closed/i,
	);
	let prompt = "";
	const approved = await controller.execute("approved-reconcile", parameters, undefined, undefined, {
		cwd,
		hasUI: true,
		ui: { confirm: async (_title: string, message: string) => { prompt = message; return true; } },
	} as unknown as ExtensionContext) as { details: Record<string, unknown> };
	assert.match(prompt, /predecessor_revision=predecessor-revision/);
	assert.match(prompt, /successor_revision=successor-revision/);
	assert.equal(approved.details.mutation_outcome, "committed");
	assert.equal(calls.length, 1);
});

test("published maintenance controller actions require exact inputs and fresh UI approval", async () => {
	const tools = new Map<string, { execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown> }>();
	const pi = { on() {}, registerTool(definition: { name: string; execute: never }) { tools.set(definition.name, definition as never); }, registerCommand() {} } as unknown as ExtensionAPI;
	const { native, calls } = fakeRecoveryNative(ABANDON_RECORD);
	createGentleAiExtension({ nativeReviewCli: native })(pi);
	const controller = tools.get("gentle_review");
	assert.ok(controller);
	const cwd = scratchDir("gentle-pi-v219-maintenance-");
	const abandon = { operation: "abandon", input: JSON.stringify({ lineage: "pristine", expectedRevision: "revision", snapshotIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ...ABANDON_DISCARDED_WORK, actor: "maintainer", reason: "retire pristine lineage" }) };
	await assert.rejects(controller.execute("headless-abandon", abandon, undefined, undefined, { cwd, hasUI: false, ui: { confirm: async () => true } } as unknown as ExtensionContext), /interactive Pi UI.*fails closed/i);
	await assert.rejects(controller.execute("denied-abandon", abandon, undefined, undefined, { cwd, hasUI: true, ui: { confirm: async () => false } } as unknown as ExtensionContext), /not explicitly authorized/);
	let abandonPrompt = "";
	const approved = await controller.execute("approved-abandon", abandon, undefined, undefined, { cwd, hasUI: true, ui: { confirm: async (_title: string, message: string) => { abandonPrompt = message; return true; } } } as unknown as ExtensionContext) as { details: Record<string, unknown> };
	assert.equal(approved.details.mutation_outcome, "committed");
	assert.match(abandonPrompt, /gentle-ai\.review-abandon-authorization\/v2/);
	assert.match(abandonPrompt, /captured_lens_results=00-risk\.json,01-readability\.json/);
	assert.match(abandonPrompt, /findings_present=true\nevidence_records_present=false\nactor=maintainer/);
	assert.equal(calls[0]?.operation, "abandon");
	assert.equal((calls[0]?.request as { maintainerAuthorization?: string }).maintainerAuthorization, ABANDON_AUTHORIZATION);
	assert.deepEqual(calls[0]?.request.capturedLensResults, ["00-risk.json", "01-readability.json"]);
	assert.equal(calls[0]?.request.findingsPresent, true);
	assert.equal(calls[0]?.request.evidenceRecordsPresent, false);
	const missingDiscarded = await runControllerOperation({ operation: "abandon", input: JSON.stringify({ lineage: "pristine", expectedRevision: "revision", snapshotIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", actor: "maintainer", reason: "retire pristine lineage" }) }, native);
	assert.equal(missingDiscarded.outcome, "native-input-required");
	assert.deepEqual(missingDiscarded.missing_input, ["capturedLensResults", "findingsPresent", "evidenceRecordsPresent"]);
	const invalidDiscarded = await runControllerOperation({ operation: "abandon", input: JSON.stringify({ lineage: "pristine", expectedRevision: "revision", snapshotIdentity: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", capturedLensResults: ["00-risk.json", " padded "], findingsPresent: true, evidenceRecordsPresent: false, actor: "maintainer", reason: "retire pristine lineage" }) }, native);
	assert.equal(invalidDiscarded.outcome, "native-input-required");
	assert.deepEqual(invalidDiscarded.missing_input, ["capturedLensResults"]);
	const legacy = await controller.execute("approved-legacy-quarantine", { operation: "quarantine-legacy", input: JSON.stringify({ repository: "/repo", lineage: "legacy", expectedRevision: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", diagnostic: LEGACY_FREEZE_DIAGNOSTIC, disposition: LEGACY_FREEZE_DISPOSITION, actor: "maintainer", reason: "quarantine malformed legacy freeze" }) }, undefined, undefined, { cwd, hasUI: true, ui: { confirm: async () => true } } as unknown as ExtensionContext) as { details: Record<string, unknown> };
	assert.equal(legacy.details.mutation_outcome, "committed");
	assert.equal(calls[1]?.operation, "quarantineLegacy");
	for (const input of [
		{ operation: "quarantine-legacy", input: JSON.stringify({ repository: "/repo", lineage: "legacy", expectedRevision: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", diagnostic: "unsupported historical v1 operation alias", disposition: LEGACY_FREEZE_DISPOSITION, actor: "maintainer", reason: "no-op" }) },
		{ operation: "reconcile-authority", input: JSON.stringify({ predecessorLineage: "predecessor", expectedPredecessorRevision: "predecessor-revision", successorLineage: "successor", expectedSuccessorRevision: "successor-revision", actor: "maintainer", reason: "no-op", anomalies: "malformed_recovery_authorization,unchanged_target" }) },
	]) {
		const details = await runControllerOperation(input, native);
		assert.equal(details.outcome, "native-input-invalid");
	}
	assert.equal(calls.length, 2);
});

test("REPAIR_LEGACY_ALIAS derives fixed inputs from fresh inventory and requires fresh UI approval", async () => {
	const tools = new Map<string, { execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown> }>();
	const pi = { on() {}, registerTool(definition: { name: string; execute: never }) { tools.set(definition.name, definition as never); }, registerCommand() {} } as unknown as ExtensionAPI;
	const calls: Record<string, unknown>[] = [];
	const native = {
		async reviewStatus() {
			return {
				repository: "/canonical/repository",
				complete: true,
				entries: [{ version: "legacy-v1", status: "invalid", lineageId: "legacy-alias", revision: `sha256:${"c".repeat(64)}`, problems: [LEGACY_ALIAS_DIAGNOSTIC] }],
			};
		},
		async repairLegacyAlias(request: Record<string, unknown>) {
			calls.push(request);
			return { record: LEGACY_ALIAS_RECORD };
		},
	} as unknown as NativeReviewCli;
	createGentleAiExtension({ nativeReviewCli: native })(pi);
	const controller = tools.get("gentle_review");
	assert.ok(controller);
	const cwd = scratchDir("gentle-pi-v2110-alias-repair-");
	const parameters = { operation: "repair-legacy-alias", input: JSON.stringify({ lineage: "legacy-alias", actor: "maintainer", reason: "quarantine approved historical alias" }) };
	await assert.rejects(
		controller.execute("headless-alias-repair", parameters, undefined, undefined, { cwd, hasUI: false, ui: { confirm: async () => true } } as unknown as ExtensionContext),
		/interactive Pi UI.*fails closed/i,
	);
	assert.equal(calls.length, 0);
	let prompt = "";
	const approved = await controller.execute("approved-alias-repair", parameters, undefined, undefined, {
		cwd,
		hasUI: true,
		ui: { confirm: async (_title: string, message: string) => { prompt = message; return true; } },
	} as unknown as ExtensionContext) as { details: Record<string, unknown> };
	assert.match(prompt, /repository=\/canonical\/repository/);
	assert.match(prompt, /revision=sha256:c{64}/);
	assert.equal(approved.details.mutation_outcome, "committed");
	assert.equal(calls[0]?.repository, "/canonical/repository");
	assert.equal(calls[0]?.diagnostic, LEGACY_ALIAS_DIAGNOSTIC);
	assert.equal(calls[0]?.disposition, LEGACY_ALIAS_DISPOSITION);
	const injected = await runControllerOperation({ operation: "repair-legacy-alias", input: JSON.stringify({ lineage: "legacy-alias", actor: "maintainer", reason: "no-op", repository: "/attacker" }) }, native);
	assert.equal(injected.outcome, "native-input-invalid");
	await assert.rejects(runControllerOperation({ operation: "dispose-result", input: "{}" }, native), /operation/);
});

// The capture-result gap, found by benchmarking Pi's client against the real
// binary: `finalize()` emitted `--result <file>` per lens, a flag gentle-ai
// retired because "a reviewer result supplied this way carries no
// provider-owned admission, so it cannot prove the lens inspected the frozen
// candidate". There was no capture-result surface at all, so Pi could only
// finalize a zero-lens low-risk candidate. The suite never caught it because
// it mocks the finalize response.
//
// Two inverse contracts meet here. `repair()` above MUST carry --contract.
// `capture-result` MUST NOT: it is an additive headless command, not a
// negotiated repository operation, and the provider's own tokens already
// carry the repository context -- it accepts that or --cwd, never both. So
// Pi passes the transition's tokens through verbatim and adds only --input.
test("captureResult passes the provider tokens through verbatim and carries no --contract", async (t) => {
	t.after(() => clearNativeReviewCapabilitiesCacheForTesting());
	// The full live envelope shape, confirmed against real capture-result runs
	// on both the pinned line and gentle-ai main (tests/fixtures/devbinary/
	// result-artifact-v2.captured.json): the opaque locator prefix is rart1_.
	const manifest = {
		schema: "gentle-ai.review-result-artifact/v2",
		capability: "review.native_result_artifact",
		reference: "rart1_" + "b".repeat(64),
		sha256: "sha256:" + "f".repeat(64),
		lineage_id: "review-1d5aadacc600e167",
		target_identity: "sha256:" + "d".repeat(64),
		lens: "review-reliability",
		selected_order: 0,
		subject_hash: "sha256:" + "a".repeat(64),
		admission_decision: "completed",
	};
	const { adapter, calls } = queuedAdapter([{ stdout: JSON.stringify(manifest) }]);
	const cli = new NativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024, async () => undefined, () => "dcc846103b16d365eaeeb9d7f289c23fc4f2897f23def1cb3fe7f05557b64705");

	const tokens = [
		"--lineage=review-1d5aadacc600e167",
		"--expected-revision=sha256:" + "c".repeat(64),
		"--target=sha256:" + "d".repeat(64),
		"--repository-context=rctx1_" + "e".repeat(64),
		"--lens=review-reliability",
		"--order=0",
		"--subject-hash=" + manifest.subject_hash,
	];
	const captured = await cli.captureResult({ argumentTokens: tokens, resultDocument: JSON.stringify({ subject_hash: manifest.subject_hash, inspection: { status: "completed", paths: ["a.ts"] }, findings: [], evidence: ["reviewed the complete frozen candidate scope"] }) });

	assert.equal(captured.subjectHash, manifest.subject_hash);
	assert.equal(captured.admissionDecision, "completed");

	// Exactly one invocation: capture-result is headless and never negotiates,
	// so it must not drag a capabilities preflight along with it.
	assert.equal(calls.length, 1);
	const argv = calls[0]!.arguments;
	assert.deepEqual(argv.slice(0, 2), ["review", "capture-result"]);
	assert.equal(argv.includes("--contract"), false, "capture-result accepts no --contract");
	assert.equal(argv.includes("--cwd"), false, "the provider tokens already carry the repository context");
	// Tokens pass through in order, untouched, and --input is the only addition.
	assert.deepEqual(argv.slice(2, 2 + tokens.length), tokens);
	assert.equal(argv.at(-2), "--input");
	assert.match(argv.at(-1) as string, /\S/);
	assert.equal(argv.length, 2 + tokens.length + 2);
});

// The admission answer routes through the exact-identity forward decoder:
// a manifest missing its binding fields (the shape no real binary ever
// emitted) or carrying a foreign locator prefix is refused, never partially
// consumed. This is the decoder-freshness discipline reaching the consumer.
test("captureResult refuses an under-specified or foreign-locator manifest", async (t) => {
	t.after(() => clearNativeReviewCapabilitiesCacheForTesting());
	const full = {
		schema: "gentle-ai.review-result-artifact/v2",
		capability: "review.native_result_artifact",
		reference: "rart1_" + "b".repeat(64),
		sha256: "sha256:" + "f".repeat(64),
		lineage_id: "review-1d5aadacc600e167",
		target_identity: "sha256:" + "d".repeat(64),
		lens: "review-reliability",
		selected_order: 0,
		subject_hash: "sha256:" + "a".repeat(64),
		admission_decision: "completed",
	};
	const legacyPartial = {
		schema: full.schema,
		capability: full.capability,
		subject_hash: full.subject_hash,
		admission_decision: full.admission_decision,
		lens: full.lens,
		reference: full.reference,
	};
	for (const body of [
		legacyPartial,
		{ ...full, reference: "rref1_" + "b".repeat(64) },
		{ ...full, unadvertised: true },
	]) {
		const cli = new NativeReviewCliV216(async () => ({ stdout: JSON.stringify(body), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false }), "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024, async () => undefined, () => "dcc846103b16d365eaeeb9d7f289c23fc4f2897f23def1cb3fe7f05557b64705");
		await assert.rejects(cli.captureResult({
			argumentTokens: ["--lineage=review-1d5aadacc600e167", "--repository-context=rctx1_" + "e".repeat(64)],
			resultDocument: JSON.stringify({ subject_hash: full.subject_hash, inspection: { status: "completed", paths: ["a.ts"] }, findings: [], evidence: ["reviewed the complete frozen candidate scope"] }),
		}));
	}
});

test("captureEvidence stages exact bytes, uses the closed outcome argv, and decodes the native record", async (t) => {
	t.after(() => clearNativeReviewCapabilitiesCacheForTesting());
	const capabilities = v2Fixture<Record<string, unknown>>("capabilities.fixture.json");
	const capabilitiesBody = { ...capabilities, package: { ...(capabilities.package as Record<string, unknown>), version: GENTLE_AI_VERSION } };
	const record = {
		schema: "gentle-ai.review-verification-evidence/v2",
		version: 2,
		lineage_id: "review-evidence-lineage",
		authority_revision: `sha256:${"a".repeat(64)}`,
		target_identity: `sha256:${"b".repeat(64)}`,
		candidate_tree: "c".repeat(40),
		paths_digest: `sha256:${"d".repeat(64)}`,
		paths: ["app.ts"],
		ledger_ids: [],
		raw_payload_sha256: `sha256:${"e".repeat(64)}`,
		raw_payload_bytes: 24,
		outcome: "verification_failed",
		record_digest: `sha256:${"f".repeat(64)}`,
	};
	let staged = "";
	const calls: Array<{ arguments: readonly string[] }> = [];
	const cli = new NativeReviewCliV216(async (request) => {
		calls.push({ arguments: request.arguments });
		if (request.arguments[1] === "capabilities") return { stdout: JSON.stringify(capabilitiesBody), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
		const inputIndex = request.arguments.indexOf("--input");
		assert.ok(inputIndex >= 0);
		staged = readFileSync(request.arguments[inputIndex + 1]!, "utf8");
		return { stdout: JSON.stringify(record), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
	}, "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024, async () => undefined, () => "dcc846103b16d365eaeeb9d7f289c23fc4f2897f23def1cb3fe7f05557b64705");
	const evidence = "focused verification failed\n";
	const captured = await cli.captureEvidence({
		cwd: "/repo",
		lineageId: record.lineage_id,
		targetIdentity: record.target_identity,
		expectedRevision: record.authority_revision,
		outcome: "verification_failed",
		evidenceDocument: evidence,
	});
	assert.equal(staged, evidence);
	assert.equal(captured.recordDigest, record.record_digest);
	assert.equal(captured.outcome, "verification_failed");
	const argv = calls[1]!.arguments;
	assert.deepEqual(argv.slice(0, 2), ["review", "capture-evidence"]);
	assert.equal(argv.includes("--contract"), false);
	assert.equal(argv[argv.indexOf("--outcome") + 1], "verification_failed");
	await assert.rejects(
		cli.captureEvidence({ cwd: "/repo", lineageId: record.lineage_id, targetIdentity: record.target_identity, expectedRevision: record.authority_revision, outcome: "failed" as never, evidenceDocument: evidence }),
		/outcome must be passed, verification_failed, or procedural_tooling_failed/,
	);
	assert.equal(calls.length, 2, "outside-domain outcomes must fail before another native launch");
});

test("negotiated finalize never emits the retired --result flag", async (t) => {
	t.after(() => clearNativeReviewCapabilitiesCacheForTesting());
	const capabilities = v2Fixture<Record<string, unknown>>("capabilities.fixture.json");
	const capabilitiesBody = { ...capabilities, package: { ...(capabilities.package as Record<string, unknown>), version: GENTLE_AI_VERSION } };
	const finalizeBody = {
		schema: "gentle-ai.review-integration.operation/v2",
		contract: "gentle-ai.review-integration/v2",
		operation: "review.finalize",
		result: { operation: "review/finalize", lineage_id: "review-1d5aadacc600e167", state: "approved", action: "validate delivery", store_revision: "sha256:" + "f".repeat(64) },
	};
	const { adapter, calls } = queuedAdapter([
		{ stdout: JSON.stringify(capabilitiesBody) },
		{ stdout: JSON.stringify(finalizeBody) },
	]);
	const cli = new NativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024, async () => undefined, () => "dcc846103b16d365eaeeb9d7f289c23fc4f2897f23def1cb3fe7f05557b64705");

	await cli.finalize({ cwd: "/repo", lineageId: "review-1d5aadacc600e167", capturedResults: true });

	const argv = calls[1]!.arguments;
	assert.equal(argv.includes("--result"), false, "--result is retired; results reach authority through capture-result");
	assert.ok(argv.some((token) => token === "--captured-results" || token.startsWith("--captured-results=")), "finalize must tell the provider to discover the captured results");
	assert.ok(argv.includes("--contract"), "finalize IS negotiated, unlike capture-result");
});

// gentle-pi#311 P4-roles: the provider-rendered self-contained role vectors
// execute EXACTLY as rendered — one CLI invocation, verbatim tokens in
// provider order, no --cwd, no --contract, no --input. Go materializes the
// role prompt, runs its own locked-down pi process, and admits the verdict.
test("captureProviderRole executes the exact rendered vector and decodes only the strict artifact", async () => {
	const artifact = {
		schema: "gentle-ai.review-provider-role-capture/v1",
		lineage_id: "review-1d5aadacc600e167",
		target_identity: `sha256:${"9".repeat(64)}`,
		role: "refuter",
		captured: true,
	};
	const calls: Array<{ arguments: readonly string[] }> = [];
	const cli = new NativeReviewCliV216(async (request) => {
		calls.push({ arguments: request.arguments });
		return { stdout: JSON.stringify(artifact), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
	}, "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024, async () => undefined, () => "dcc846103b16d365eaeeb9d7f289c23fc4f2897f23def1cb3fe7f05557b64705");
	const tokens = [
		"--lineage=review-1d5aadacc600e167",
		`--expected-revision=sha256:${"a".repeat(64)}`,
		`--target=sha256:${"9".repeat(64)}`,
		`--repository-context=rctx1_${"c".repeat(64)}`,
		"--agent=pi",
		"--execute=true",
	];
	const captured = await cli.captureProviderRole({ captureOperation: "review.capture-refuter", argumentTokens: tokens, cwd: "/repo" });
	assert.equal(captured.role, "refuter");
	assert.equal(captured.lineageId, "review-1d5aadacc600e167");
	assert.deepEqual(calls[0]!.arguments, ["review", "capture-refuter", ...tokens], "the vector runs verbatim: nothing added, removed, or reordered");

	await assert.rejects(
		cli.captureProviderRole({ captureOperation: "review.capture-result", argumentTokens: tokens, cwd: "/repo" }),
		/supports only review\.capture-refuter and review\.capture-validation/,
	);
	assert.equal(calls.length, 1, "an unknown role operation must fail before any native launch");
});

test("captureProviderRole refuses an uncaptured or malformed role artifact", async () => {
	const base = {
		schema: "gentle-ai.review-provider-role-capture/v1",
		lineage_id: "review-1d5aadacc600e167",
		target_identity: `sha256:${"9".repeat(64)}`,
		role: "targeted-validator",
		captured: true,
	};
	for (const body of [
		{ ...base, captured: false },
		{ ...base, role: "reviewer" },
		{ ...base, schema: "gentle-ai.review-result-artifact/v2" },
		{ ...base, extra: true },
	]) {
		const cli = new NativeReviewCliV216(async () => ({ stdout: JSON.stringify(body), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false }), "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024, async () => undefined, () => "dcc846103b16d365eaeeb9d7f289c23fc4f2897f23def1cb3fe7f05557b64705");
		await assert.rejects(cli.captureProviderRole({ captureOperation: "review.capture-validation", argumentTokens: ["--agent=pi", "--execute=true"], cwd: "/repo" }));
	}
});

// gentle-pi#311 P5: the provider-driven FINALIZE executes the rendered
// transition tokens verbatim and decodes both answer shapes (the negotiated
// operation envelope and the plain review/finalize shape a contract-less
// transition produces).
test("finalizeTransition runs the provider-rendered tokens verbatim and decodes both answer shapes", async (t) => {
	t.after(() => clearNativeReviewCapabilitiesCacheForTesting());
	const capabilities = v2Fixture<Record<string, unknown>>("capabilities.fixture.json");
	const capabilitiesBody = { ...capabilities, package: { ...(capabilities.package as Record<string, unknown>), version: GENTLE_AI_VERSION } };
	const plainBody = { operation: "review/finalize", lineage_id: "review-1d5aadacc600e167", state: "approved", action: "validate delivery", store_revision: `sha256:${"f".repeat(64)}` };
	const envelopeBody = {
		schema: "gentle-ai.review-integration.operation/v2",
		contract: "gentle-ai.review-integration/v2",
		operation: "review.finalize",
		result: { operation: "review/finalize", lineage_id: "review-1d5aadacc600e167", state: "approved", action: "validate delivery", store_revision: `sha256:${"f".repeat(64)}` },
	};
	const { adapter, calls } = queuedAdapter([
		{ stdout: JSON.stringify(capabilitiesBody) },
		{ stdout: JSON.stringify(plainBody) },
		{ stdout: JSON.stringify(envelopeBody) },
	]);
	const cli = new NativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024, async () => undefined, () => "dcc846103b16d365eaeeb9d7f289c23fc4f2897f23def1cb3fe7f05557b64705");
	const tokens = ["--lineage=review-1d5aadacc600e167", "--captured-results=true"];
	const plain = await cli.finalizeTransition({ cwd: "/repo", argumentTokens: tokens });
	assert.equal(plain.state, "approved");
	assert.deepEqual(calls[1]!.arguments, ["review", "finalize", ...tokens], "no --contract, --cwd, or document flag is invented for a rendered transition");
	const negotiated = await cli.finalizeTransition({ cwd: "/repo", argumentTokens: tokens });
	assert.equal(negotiated.storeRevision, `sha256:${"f".repeat(64)}`);
	await assert.rejects(cli.finalizeTransition({ cwd: "/repo", argumentTokens: [] }), /requires the provider-rendered argument tokens/);
});

// Field defect (fambig, 2026-08-16): the evidence collect slot renders the
// exact `review capture-evidence` submission tokens — fix-diff `--target`,
// `--expected-revision`, and an opaque cwd-independent `--repository-context` —
// with `{{outcome}}`/`{{input}}` slots. Satisfying the slot means executing
// those tokens verbatim with only the two slot substitutions, exactly like
// captureResult; identities are never reconstructed on the client.
test("captureEvidenceSubmission executes the provider-rendered submission tokens verbatim with slot substitution", async (t) => {
	t.after(() => clearNativeReviewCapabilitiesCacheForTesting());
	const capabilities = v2Fixture<Record<string, unknown>>("capabilities.fixture.json");
	const capabilitiesBody = { ...capabilities, package: { ...(capabilities.package as Record<string, unknown>), version: GENTLE_AI_VERSION } };
	const record = {
		schema: "gentle-ai.review-verification-evidence/v2",
		version: 2,
		lineage_id: "review-evidence-lineage",
		authority_revision: `sha256:${"a".repeat(64)}`,
		target_identity: `sha256:${"b".repeat(64)}`,
		candidate_tree: "c".repeat(40),
		paths_digest: `sha256:${"d".repeat(64)}`,
		paths: ["calc.go"],
		ledger_ids: ["R3-1"],
		raw_payload_sha256: `sha256:${"e".repeat(64)}`,
		raw_payload_bytes: 24,
		outcome: "passed",
		record_digest: `sha256:${"f".repeat(64)}`,
	};
	const argumentTokens = [
		`--lineage=${record.lineage_id}`,
		`--expected-revision=${record.authority_revision}`,
		`--target=${record.target_identity}`,
		`--repository-context=rctx1_${"e".repeat(64)}`,
		"--outcome={{outcome}}",
		"--input={{input}}",
	];
	let staged = "";
	const calls: Array<{ arguments: readonly string[]; cwd: string }> = [];
	const cli = new NativeReviewCliV216(async (request) => {
		calls.push({ arguments: request.arguments, cwd: request.cwd });
		if (request.arguments[1] === "capabilities") return { stdout: JSON.stringify(capabilitiesBody), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
		const inputToken = request.arguments.find((token) => token.startsWith("--input="));
		assert.ok(inputToken !== undefined);
		staged = readFileSync(inputToken.slice("--input=".length), "utf8");
		return { stdout: JSON.stringify(record), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
	}, "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024, async () => undefined, () => "dcc846103b16d365eaeeb9d7f289c23fc4f2897f23def1cb3fe7f05557b64705");
	const evidence = "verification: go test ./... passed\n";
	const captured = await cli.captureEvidenceSubmission({
		argumentTokens,
		outcomeSubstitutionLocation: 4,
		inputSubstitutionLocation: 5,
		outcome: "passed",
		evidenceDocument: evidence,
		executionCwd: "/execution",
	});
	assert.equal(staged, evidence, "the evidence bytes must be staged exactly");
	assert.equal(calls[1]!.cwd, "/execution", "repository-context submissions may override only the adapter process cwd");
	assert.equal(captured.recordDigest, record.record_digest);
	assert.equal(captured.targetIdentity, record.target_identity);
	const argv = calls[1]!.arguments;
	assert.deepEqual(argv.slice(0, 2), ["review", "capture-evidence"]);
	assert.deepEqual(argv.slice(2, 6), argumentTokens.slice(0, 4), "the identity-bearing tokens must pass through verbatim, in provider order");
	assert.equal(argv[6], "--outcome=passed");
	assert.match(String(argv[7]), /^--input=./);
	assert.equal(argv.length, 8);
	assert.equal(argv.includes("--cwd"), false, "the repository context is authoritative and cwd-independent");
	assert.equal(argv.includes("--contract"), false);
	await assert.rejects(
		cli.captureEvidenceSubmission({ cwd: "/repo", argumentTokens, outcomeSubstitutionLocation: 4, inputSubstitutionLocation: 5, outcome: "passed", evidenceDocument: evidence }),
		/repository context or --cwd, never both/,
	);
	await assert.rejects(
		cli.captureEvidenceSubmission({ argumentTokens, outcomeSubstitutionLocation: 4, inputSubstitutionLocation: 5, outcome: "failed" as never, evidenceDocument: evidence }),
		/outcome must be passed, verification_failed, or procedural_tooling_failed/,
	);
	await assert.rejects(
		cli.captureEvidenceSubmission({ argumentTokens: argumentTokens.slice(0, 4), outcomeSubstitutionLocation: 0, inputSubstitutionLocation: 1, outcome: "passed", evidenceDocument: evidence }),
		/\{\{outcome\}\}/,
	);
	assert.equal(calls.length, 2, "every rejected submission must fail before another native launch");
});

test("finalizeSubmission executes the rendered finalize submission tokens verbatim with the {{value}} substitution", async (t) => {
	t.after(() => clearNativeReviewCapabilitiesCacheForTesting());
	const capabilities = v2Fixture<Record<string, unknown>>("capabilities.fixture.json");
	const capabilitiesBody = { ...capabilities, package: { ...(capabilities.package as Record<string, unknown>), version: GENTLE_AI_VERSION } };
	const finalizeBody = {
		schema: "gentle-ai.review-integration.operation/v2",
		contract: "gentle-ai.review-integration/v2",
		operation: "review.finalize",
		result: { operation: "review/finalize", lineage_id: "review-1d5aadacc600e167", state: "correction_required", action: "continue the current review state", store_revision: `sha256:${"f".repeat(64)}` },
	};
	const planTokens = [
		"--contract=gentle-ai.review-integration/v2",
		"--lineage=review-1d5aadacc600e167",
		`--expected-revision=sha256:${"a".repeat(64)}`,
		`--target=sha256:${"b".repeat(64)}`,
		`--request-hash=sha256:${"c".repeat(64)}`,
		`--repository-context=rctx1_${"e".repeat(64)}`,
		"--correction-lines={{value}}",
	];
	const calls: Array<{ arguments: readonly string[] }> = [];
	let staged: string | undefined;
	const cli = new NativeReviewCliV216(async (request) => {
		calls.push({ arguments: request.arguments });
		if (request.arguments[1] === "capabilities") return { stdout: JSON.stringify(capabilitiesBody), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
		const validationToken = request.arguments.find((token) => token.startsWith("--validation="));
		if (validationToken !== undefined) staged = readFileSync(validationToken.slice("--validation=".length), "utf8");
		return { stdout: JSON.stringify(finalizeBody), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
	}, "/package/.gentle-ai/gentle-ai", 30_000, 1024 * 1024, async () => undefined, () => "dcc846103b16d365eaeeb9d7f289c23fc4f2897f23def1cb3fe7f05557b64705");

	// Plan form: literal substitution, every other token verbatim.
	const planned = await cli.finalizeSubmission({ cwd: "/repo", argumentTokens: planTokens, valueSubstitutionLocation: 6, valueLiteral: "2" });
	assert.equal(planned.state, "correction_required");
	const planArgv = calls[1]!.arguments;
	assert.deepEqual(planArgv.slice(0, 2), ["review", "finalize"]);
	assert.deepEqual(planArgv.slice(2, 8), planTokens.slice(0, 6), "identity-bearing tokens must pass through verbatim, in provider order");
	assert.equal(planArgv[8], "--correction-lines=2");
	assert.equal(planArgv.length, 9);

	// Validation form: the document is staged to a 0o600 artifact whose path substitutes {{value}}.
	const validationTokens = [...planTokens.slice(0, 6), "--validation={{value}}"];
	const document = JSON.stringify({ targeted_validation_request_hash: `sha256:${"9".repeat(64)}`, original_criteria: { passed: true, evidence: ["ok"] } });
	await cli.finalizeSubmission({ cwd: "/repo", argumentTokens: validationTokens, valueSubstitutionLocation: 6, valueDocument: document });
	assert.equal(staged, document, "the validation document must be staged byte-exact");

	// Guards: exactly one substitution form, and a real {{value}} slot.
	await assert.rejects(
		cli.finalizeSubmission({ cwd: "/repo", argumentTokens: planTokens, valueSubstitutionLocation: 6, valueLiteral: "2", valueDocument: document }),
		/exactly one of valueLiteral or valueDocument/,
	);
	await assert.rejects(
		cli.finalizeSubmission({ cwd: "/repo", argumentTokens: planTokens.slice(0, 6), valueSubstitutionLocation: 0, valueLiteral: "2" }),
		/\{\{value\}\}/,
	);
	assert.equal(calls.length, 3, "rejected submissions must fail before another native launch");
});
