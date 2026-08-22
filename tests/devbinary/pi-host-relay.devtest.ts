import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { __testing, createGentleAiExtension } from "../../extensions/gentle-ai.ts";
import { resolveGentleAiBinary } from "../../lib/gentle-ai-binary.ts";
import { OPAQUE_PI_REVIEWER_ARGV } from "../../lib/opaque-pi-reviewer-adapter.ts";
import { NativeReviewCliV216, type ExecFileAdapter, type NativeReviewCli } from "../../lib/native-review-cli.ts";
import { reviewHostRelaySlots, runReviewHostRelaySlot } from "../../lib/review-host-relay.ts";
import { GENTLE_PI_REVIEW_RELAY_CONTRACT, GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV } from "../../lib/review-relay-contract.ts";
import { decodeReviewStatusV3 } from "../../lib/review-integration-v2.ts";
import { requireDevBinary } from "../support/native-binary-gate.ts";

const DEV_BINARY = process.env.GENTLE_AI_DEV_BINARY;
const RELAY_DEV_BINARY = process.env.GENTLE_PI_GENTLE_AI_DEV_BINARY;
const POSIX = process.platform !== "win32";
const primaryDevBinaryGate = requireDevBinary({
	devBinaryPath: DEV_BINARY,
	exists: typeof DEV_BINARY === "string" && DEV_BINARY.length > 0 && DEV_BINARY.startsWith("/") && existsSync(DEV_BINARY),
	env: process.env,
});
const relayDevBinaryGate = POSIX
	? requireDevBinary({
		devBinaryPath: RELAY_DEV_BINARY,
		exists: typeof RELAY_DEV_BINARY === "string" && RELAY_DEV_BINARY.length > 0 && RELAY_DEV_BINARY.startsWith("/") && existsSync(RELAY_DEV_BINARY),
		env: process.env,
	})
	: { run: false as const, reason: "Windows is explicitly skipped until a native fake-pi.exe exists; this test never enables a shell fallback." };
const RUNNABLE = POSIX && primaryDevBinaryGate.run && relayDevBinaryGate.run;
if (!POSIX) console.log(`tests/devbinary/pi-host-relay.devtest.ts: ${relayDevBinaryGate.reason}`);
if (!primaryDevBinaryGate.run) console.log(`tests/devbinary/pi-host-relay.devtest.ts: ${primaryDevBinaryGate.reason}`);
if (!relayDevBinaryGate.run && POSIX) console.log(`tests/devbinary/pi-host-relay.devtest.ts: ${relayDevBinaryGate.reason}`);

const ZERO_FINDING_PATHS = Object.freeze([".github/workflows/relay.yml"]);

interface RegisteredTool {
	execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, context: ExtensionContext) => Promise<{ details?: unknown }>;
}

function git(cwd: string, ...arguments_: string[]): string {
	return execFileSync("git", arguments_, { cwd, encoding: "utf8" }).trim();
}

function repository(t: test.TestContext, prefix: string): string {
	const cwd = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	git(cwd, "init", "-b", "main");
	git(cwd, "config", "user.email", "relay-devtest@example.invalid");
	git(cwd, "config", "user.name", "Pi Host Relay Devtest");
	writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
	git(cwd, "add", "app.ts");
	git(cwd, "commit", "-qm", "initial");
	return cwd;
}

function record(value: unknown, name: string): Record<string, unknown> {
	assert.equal(typeof value, "object", `${name} must be an object`);
	assert.notEqual(value, null, `${name} must not be null`);
	assert.equal(Array.isArray(value), false, `${name} must not be an array`);
	return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
	assert.equal(typeof value, "string", `${name} must be a string`);
	return value as string;
}

function reviewEnvironment(home: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: join(home, "config"),
		[GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV]: GENTLE_PI_REVIEW_RELAY_CONTRACT,
	};
}

function candidateJson(binary: string, cwd: string, arguments_: readonly string[], environment: NodeJS.ProcessEnv): unknown {
	const stdout = execFileSync(binary, arguments_, { cwd, encoding: "utf8", env: environment });
	return JSON.parse(stdout) as unknown;
}

function candidateStatus(binary: string, sessionCwd: string, requestedCwd: string, environment: NodeJS.ProcessEnv, lineage?: string, selectors: readonly string[] = []) {
	return decodeReviewStatusV3(candidateJson(binary, sessionCwd, [
		"review", "status", "--cwd", requestedCwd,
		"--contract", "gentle-ai.review-integration/v2", "--agent", "pi", "--next-transition",
		...selectors,
		...(lineage === undefined ? [] : ["--lineage", lineage]),
	], environment));
}

function enableGlobalReview(binary: string, sessionCwd: string, cwd: string, environment: NodeJS.ProcessEnv): void {
	const enabled = record(candidateJson(binary, sessionCwd, [
		"review", "mode", "enable", "--scope", "global", "--cwd", cwd, "--json",
	], environment), "global mode enable");
	assert.equal(record(enabled.status, "global mode enable status").effective, "on");
	const status = record(candidateJson(binary, sessionCwd, [
		"review", "mode", "status", "--cwd", cwd, "--json",
	], environment), "global mode status");
	assert.equal(record(status.status, "global mode status result").effective, "on");
}

function runRenderedInvocation(binary: string, sessionCwd: string, command: string, environment: NodeJS.ProcessEnv): unknown {
	const words = command.split(" ");
	assert.ok(words.length >= 3, `rendered invocation is incomplete: ${command}`);
	assert.deepEqual(words.slice(0, 2), ["gentle-ai", "review"], `rendered invocation is not a native review command: ${command}`);
	assert.equal(words.some((word) => word.includes("'") || word.includes('"')), false, `devtest fixture command must remain unquoted: ${command}`);
	return candidateJson(binary, sessionCwd, words.slice(1), environment);
}

function controllerForNative(nativeReviewCli: NativeReviewCli): RegisteredTool {
	const tools = new Map<string, RegisteredTool>();
	createGentleAiExtension({ nativeReviewCli } as unknown as Parameters<typeof createGentleAiExtension>[0])({
		on() {},
		registerTool(definition: RegisteredTool & { name: string }) { tools.set(definition.name, definition); },
		registerCommand() {},
	} as unknown as ExtensionAPI);
	const controller = tools.get("gentle_review");
	assert.ok(controller, "gentle_review controller must be registered");
	return controller!;
}

function crossRepositoryController(binary: string, sessionCwd: string, environment: NodeJS.ProcessEnv): RegisteredTool {
	const native = {
		targetStatus: async (request: { cwd: string; lineageId?: string }) => candidateStatus(binary, sessionCwd, request.cwd, environment, request.lineageId),
	} as unknown as NativeReviewCli;
	return controllerForNative(native);
}

interface NativeProcessCall {
	arguments: readonly string[];
	cwd: string;
}

function processText(value: unknown): string {
	if (typeof value === "string") return value;
	return Buffer.isBuffer(value) ? value.toString("utf8") : "";
}

function devNativeCli(binary: string, environment: NodeJS.ProcessEnv, calls: NativeProcessCall[]): NativeReviewCliV216 {
	const adapter: ExecFileAdapter = async (request) => {
		calls.push({ arguments: [...request.arguments], cwd: request.cwd });
		try {
			return {
				stdout: execFileSync(request.file, request.arguments, {
					cwd: request.cwd,
					encoding: "utf8",
					env: environment,
					timeout: request.timeoutMs,
					maxBuffer: request.maxBufferBytes,
				}),
				stderr: "",
				exitCode: 0,
				signal: null,
				timedOut: false,
				outputLimitExceeded: false,
			};
		} catch (error) {
			const failure = error as NodeJS.ErrnoException & {
				stdout?: string | Buffer;
				stderr?: string | Buffer;
				status?: number;
				signal?: NodeJS.Signals | null;
				killed?: boolean;
			};
			return {
				stdout: processText(failure.stdout),
				stderr: processText(failure.stderr),
				exitCode: typeof failure.status === "number" ? failure.status : 1,
				signal: failure.signal ?? null,
				timedOut: failure.killed === true,
				outputLimitExceeded: failure.code === "ENOBUFS" || failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
			};
		}
	};
	return new NativeReviewCliV216(adapter, binary);
}

function sessionContext(cwd: string): ExtensionContext {
	return { cwd, hasUI: false, ui: { notify() {} } } as unknown as ExtensionContext;
}

function grantedConsentInvocation(value: unknown): string {
	const consent = record(value, "consent response");
	const choices = consent.choices;
	assert.ok(Array.isArray(choices), "consent response must carry choices");
	const granted = choices.map((choice) => record(choice, "consent choice")).find((choice) => choice.answer === "granted");
	assert.ok(granted, "consent response must carry the granted choice");
	return stringValue(granted!.invocation, "granted consent invocation");
}

const FAKE_POSIX_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const expectedArgv = JSON.parse(process.env.OPAQUE_PI_REVIEWER_ARGV);
const expectedPaths = JSON.parse(process.env.OPAQUE_PI_REVIEWER_PATHS);
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks);
  const promptText = prompt.toString("utf8");
  const targetedValidatorResult = process.env.OPAQUE_PI_TARGETED_VALIDATOR_RESULT;
  let subjectHash;
  if (targetedValidatorResult === undefined) {
    const newline = prompt.indexOf(0x0a);
    if (newline < 0) throw new Error("missing binding line");
    const firstLine = prompt.subarray(0, newline).toString("utf8");
    const prefix = "GENTLE_AI_REVIEW_BINDING ";
    if (!firstLine.startsWith(prefix)) throw new Error("missing binding prefix");
    const binding = JSON.parse(firstLine.slice(prefix.length));
    if (typeof binding.subject_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(binding.subject_hash)) throw new Error("invalid binding subject_hash");
    if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expectedArgv)) throw new Error("unexpected opaque Pi argv");
    subjectHash = binding.subject_hash;
  } else if (promptText.length === 0) {
    throw new Error("missing targeted-validator prompt");
  }
  const prior = fs.existsSync(process.env.OPAQUE_PI_REVIEWER_LOG) ? JSON.parse(fs.readFileSync(process.env.OPAQUE_PI_REVIEWER_LOG, "utf8")) : { calls: [] };
  const calls = Array.isArray(prior.calls) ? prior.calls : [];
  calls.push({
    argv: process.argv.slice(2), cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), ...(subjectHash === undefined ? {} : { subject_hash: subjectHash }), prompt: promptText,
    role: targetedValidatorResult === undefined ? "reviewer" : "targeted-validator",
  });
  fs.writeFileSync(process.env.OPAQUE_PI_REVIEWER_LOG, JSON.stringify({ calls }));
  if (targetedValidatorResult !== undefined) {
    process.stdout.write(targetedValidatorResult);
    return;
  }
  process.stdout.write(JSON.stringify({
    subject_hash: subjectHash,
    inspection: { status: "completed", paths: expectedPaths },
    findings: process.env.OPAQUE_PI_REVIEWER_FINDINGS === undefined ? [] : JSON.parse(process.env.OPAQUE_PI_REVIEWER_FINDINGS),
    evidence: ["inspected every frozen candidate path"],
  }));
});
`;

// This A -> B journey deliberately stops immediately after one Go-admitted
// reviewer capture. It proves real Pi relay transport and root continuity, but
// does not manufacture the remaining reviewer, refuter, validator, or approval
// transitions required to burn an actual receipt.
test("dev-binary: POSIX Pi host relay captures one real B-target slot from an A-session without reoffering it", { skip: !RUNNABLE }, async (t) => {
	const sessionA = repository(t, "gentle-pi-relay-session-a-");
	const targetB = repository(t, "gentle-pi-relay-target-b-");
	const nestedTarget = join(targetB, "nested");
	mkdirSync(nestedTarget);
	const workflowDirectory = join(targetB, ".github", "workflows");
	mkdirSync(workflowDirectory, { recursive: true });
	const workflow = join(workflowDirectory, "relay.yml");
	writeFileSync(workflow, "name: relay\non: push\n");
	git(targetB, "add", ".github/workflows/relay.yml");
	git(targetB, "commit", "-qm", "workflow baseline");
	writeFileSync(workflow, "name: relay\non: push\njobs:\n  relay:\n    runs-on: ubuntu-latest\n");
	writeFileSync(join(targetB, "selected.txt"), "selected relay input\n");
	writeFileSync(join(targetB, "excluded.txt"), "excluded relay input\n");

	const canonicalB = realpathSync(targetB);
	assert.equal(realpathSync(git(nestedTarget, "rev-parse", "--show-toplevel")), canonicalB, "B/nested must canonicalize to B before native lifecycle routing");
	const isolatedHome = join(sessionA, "home");
	mkdirSync(isolatedHome);
	const environment = reviewEnvironment(isolatedHome);
	assert.ok(DEV_BINARY, "GENTLE_AI_DEV_BINARY is required for this devtest");
	assert.ok(RELAY_DEV_BINARY, "GENTLE_PI_GENTLE_AI_DEV_BINARY is required for this devtest");
	assert.equal(realpathSync(RELAY_DEV_BINARY!), realpathSync(DEV_BINARY!), "the devtest and production override must name the same candidate");
	assert.equal(realpathSync(resolveGentleAiBinary()), realpathSync(RELAY_DEV_BINARY!), "production binary resolution must select the candidate realpath");
	enableGlobalReview(RELAY_DEV_BINARY!, sessionA, canonicalB, environment);
	const inspected = await crossRepositoryController(RELAY_DEV_BINARY!, sessionA, environment).execute(
		"inspect-target-b-from-session-a",
		{ operation: "inspect", workspaceRoot: nestedTarget },
		undefined,
		undefined,
		sessionContext(sessionA),
	);
	assert.equal(record(inspected.details, "cross-repository controller result").workspace_root, canonicalB, "the controller must canonicalize B/nested to B while A remains the session cwd");

	const initial = candidateStatus(RELAY_DEV_BINARY!, sessionA, canonicalB, environment);
	assert.equal(initial.nextTransition?.kind, "collect", "selectorless Pi STATUS must require an intended-untracked declaration for B");
	assert.equal(initial.nextTransition?.reasonCode, "intended_untracked_selection_required");
	const selection = initial.nextTransition?.collect?.inputs.find((input) => input.name === "intended_untracked_selection");
	assert.ok(selection, "selectorless Pi STATUS must publish the untracked selection input");
	const inventory = selection!.arguments.find((argument) => argument.name === "expected_untracked_inventory")?.value;
	const eligible = selection!.arguments.find((argument) => argument.name === "eligible_paths_json")?.value;
	assert.equal(typeof inventory, "string");
	assert.ok(typeof eligible === "string" && JSON.parse(eligible).includes("selected.txt") && JSON.parse(eligible).includes("excluded.txt"), "native inventory must name both B untracked controls");
	const selectedStatus = candidateStatus(RELAY_DEV_BINARY!, sessionA, canonicalB, environment, undefined, ["--untracked-scope=select", `--expected-untracked-inventory=${inventory}`, "--intended-untracked=selected.txt"]);
	assert.equal(selectedStatus.nextTransition?.kind, "execute", "selected Pi STATUS must offer native START for B");
	const execute = selectedStatus.nextTransition?.execute;
	assert.ok(execute, "selected Pi STATUS must render a START execution");
	assert.equal(execute!.operation, "review.start");
	assert.equal(execute!.command.startsWith("gentle-ai review start "), true);
	assert.deepEqual(execute!.command.split(" ").slice(3), execute!.arguments.map((argument) => argument.token));
	assert.ok(execute!.arguments.some((argument) => argument.token === `--cwd=${canonicalB}`), "rendered START must canonically target B, not A or B/nested");
	assert.ok(execute!.arguments.some((argument) => argument.token === "--intended-untracked=selected.txt"), "rendered START must retain B's selected untracked path");
	assert.equal(execute!.arguments.some((argument) => argument.token === "--intended-untracked=excluded.txt"), false, "rendered START must exclude B's unselected control");

	const consent = runRenderedInvocation(RELAY_DEV_BINARY!, sessionA, execute!.command, environment);
	const started = runRenderedInvocation(RELAY_DEV_BINARY!, sessionA, grantedConsentInvocation(consent), environment);
	const startedRecord = record(started, "granted START response");
	assert.equal(startedRecord.action, "created");
	const lineage = stringValue(startedRecord.lineage_id, "granted START lineage_id");

	const collecting = candidateStatus(RELAY_DEV_BINARY!, sessionA, canonicalB, environment, lineage);
	const slots = reviewHostRelaySlots(collecting.nextTransition?.collect?.inputs ?? []);
	assert.ok(slots.length > 0, `real Pi-bound STATUS must offer at least one materialize relay slot: ${JSON.stringify(collecting.raw)}`);
	const slot = slots[0]!;
	const slotInput = collecting.nextTransition?.collect?.inputs.find((input) => input.artifactSubject?.subjectHash === slot.subjectHash);
	const expectedPaths = slotInput?.changedPathManifest?.map((entry) => entry.path) ?? ZERO_FINDING_PATHS;
	assert.ok(expectedPaths.includes("selected.txt"), "the selected untracked file must reach the immutable reviewer manifest");
	assert.equal(expectedPaths.includes("excluded.txt"), false, "the unselected B control must stay out of the reviewer manifest");
	assert.ok(slot.submission, "the real Pi slot must include Go's provider-owned submission form");
	assert.ok(slot.subjectHash, "the real Pi slot must include its artifact subject hash");

	const fakePi = join(sessionA, "fake-pi");
	const fakePiLog = join(sessionA, "fake-pi-log.json");
	writeFileSync(fakePi, FAKE_POSIX_PI);
	chmodSync(fakePi, 0o755);
	const relay = await runReviewHostRelaySlot({
		captureArgumentTokens: slot.captureArgumentTokens,
		submission: slot.submission,
		targetCwd: canonicalB,
		piExecutable: fakePi,
		environment: {
			...environment,
			OPAQUE_PI_REVIEWER_ARGV: JSON.stringify(OPAQUE_PI_REVIEWER_ARGV),
			OPAQUE_PI_REVIEWER_LOG: fakePiLog,
			OPAQUE_PI_REVIEWER_PATHS: JSON.stringify(expectedPaths),
		},
		gentleAiTimeoutMs: 30_000,
		piTimeoutMs: 30_000,
	});
	assert.ok(relay.promptByteLength > 0);
	assert.ok(relay.resultByteLength > 0);
	assert.equal(record(JSON.parse(relay.submission) as unknown, "capture submission").admission_decision, "completed");

	const fakePiLogRecord = record(JSON.parse(readFileSync(fakePiLog, "utf8")) as unknown, "fake Pi log");
	assert.ok(Array.isArray(fakePiLogRecord.calls), "fake Pi log must record its subprocess calls");
	assert.equal(fakePiLogRecord.calls.length, 1);
	const fakePiResult = record(fakePiLogRecord.calls[0], "fake Pi result");
	assert.deepEqual(fakePiResult.argv, OPAQUE_PI_REVIEWER_ARGV);
	assert.deepEqual(fakePiResult.entries, []);
	assert.equal(fakePiResult.subject_hash, slot.subjectHash);
	const scratchCwd = stringValue(fakePiResult.cwd, "fake Pi scratch cwd");
	assert.notEqual(scratchCwd, canonicalB);
	assert.notEqual(scratchCwd, sessionA);
	assert.equal(existsSync(scratchCwd), false, "opaque Pi scratch cwd must be removed after the subprocess exits");

	const advanced = candidateStatus(RELAY_DEV_BINARY!, sessionA, canonicalB, environment, lineage);
	const reoffered = reviewHostRelaySlots(advanced.nextTransition?.collect?.inputs ?? []).some((candidate) =>
		candidate.subjectHash === slot.subjectHash
			&& JSON.stringify(candidate.captureArgumentTokens) === JSON.stringify(slot.captureArgumentTokens),
	);
	assert.equal(reoffered, false, "the captured Pi slot must advance and never be reoffered");
	assert.equal(advanced.authority?.state, "reviewing", "this devtest must not finalize, approve, or burn the review");
	assert.notEqual(advanced.receipt.status, "available", "this devtest stops before any approval receipt exists");
	t.diagnostic(`captured Pi slot: lineage=${lineage}; subject_hash=${slot.subjectHash}; admission=completed; reoffered=false; authority=${advanced.authority?.state}`);

	const sessionStatus = candidateStatus(RELAY_DEV_BINARY!, sessionA, sessionA, environment);
	assert.equal(sessionStatus.authority, undefined, "A must remain without B's review authority");
	assert.notEqual(sessionStatus.targetIdentity, advanced.targetIdentity, "A must remain unrelated to B's candidate binding");
});

// This completes the same organic A -> B path through correction evidence,
// Go-owned targeted validation, and terminal approval. The only reviewer is the
// fixed fake Pi executable below; no model, provider, or profile is selected.
test("dev-binary: Pi controller keeps an explicit B root and selected-untracked binding through Go-owned validation approval", { skip: !RUNNABLE }, async (t) => {
	const sessionA = repository(t, "gentle-pi-combined-session-a-");
	const targetB = repository(t, "gentle-pi-combined-target-b-");
	const nestedTarget = join(targetB, "nested", "target");
	mkdirSync(nestedTarget, { recursive: true });
	const workflowDirectory = join(targetB, ".github", "workflows");
	mkdirSync(workflowDirectory, { recursive: true });
	const workflow = join(workflowDirectory, "relay.yml");
	writeFileSync(workflow, "name: relay\non: push\n");
	git(targetB, "add", ".github/workflows/relay.yml");
	git(targetB, "commit", "-qm", "workflow baseline");
	writeFileSync(workflow, "name: relay\non: push\njobs:\n  relay:\n    runs-on: ubuntu-latest\n");
	writeFileSync(join(targetB, "selected.txt"), "selected relay input\n");
	writeFileSync(join(targetB, "excluded.txt"), "excluded relay input\n");

	const canonicalB = realpathSync(targetB);
	assert.equal(realpathSync(git(nestedTarget, "rev-parse", "--show-toplevel")), canonicalB, "B/nested must canonicalize to B before controller routing");
	const activeProjectCommonDir = realpathSync(git(process.cwd(), "rev-parse", "--git-common-dir"));
	const sandboxCommonDir = realpathSync(git(canonicalB, "rev-parse", "--git-common-dir"));
	assert.notEqual(sandboxCommonDir, activeProjectCommonDir, "the B sandbox must not share the active project's Git common directory");
	const isolatedHome = join(sessionA, "home");
	mkdirSync(isolatedHome);
	const environment = reviewEnvironment(isolatedHome);
	assert.ok(RELAY_DEV_BINARY, "GENTLE_PI_GENTLE_AI_DEV_BINARY is required for this devtest");
	const isolatedModeBefore = record(candidateJson(RELAY_DEV_BINARY!, sessionA, ["review", "mode", "status", "--cwd", canonicalB, "--json"], environment), "isolated mode before setup");
	assert.equal(record(isolatedModeBefore.status, "isolated mode before setup status").effective, "off", "the sandbox must start with its own RDD mode disabled");
	enableGlobalReview(RELAY_DEV_BINARY!, sessionA, canonicalB, environment);
	const isolatedModeAfterSetup = candidateJson(RELAY_DEV_BINARY!, sessionA, ["review", "mode", "status", "--cwd", canonicalB, "--json"], environment);

	const initial = candidateStatus(RELAY_DEV_BINARY!, sessionA, canonicalB, environment);
	const selectionInput = initial.nextTransition?.collect?.inputs.find((input) => input.name === "intended_untracked_selection");
	assert.ok(selectionInput, "B STATUS must publish its explicit intended-untracked selection input");
	const inventory = selectionInput!.arguments.find((argument) => argument.name === "expected_untracked_inventory")?.value;
	assert.equal(typeof inventory, "string");
	const selection = {
		untrackedScope: "select" as const,
		expectedUntrackedInventory: inventory!,
		intendedUntracked: ["selected.txt"],
	};
	const selectionTokens = [
		"--untracked-scope=select",
		`--expected-untracked-inventory=${selection.expectedUntrackedInventory}`,
		"--intended-untracked=selected.txt",
	];

	const nativeCalls: NativeProcessCall[] = [];
	const native = devNativeCli(RELAY_DEV_BINARY!, environment, nativeCalls);
	const controller = controllerForNative(native);
	const inspected = await controller.execute(
		"combined-inspect-target-b",
		{ operation: "inspect", workspaceRoot: nestedTarget },
		undefined,
		undefined,
		sessionContext(sessionA),
	);
	assert.equal(record(inspected.details, "combined inspect").workspace_root, canonicalB, "the A-session controller must expose B's canonical root");

	const selectionBoundCallOffset = nativeCalls.length;
	const startedPrompt = await controller.execute(
		"combined-start-target-b",
		{ operation: "start", workspaceRoot: nestedTarget, input: JSON.stringify({ mode: "ordinary", ...selection }) },
		undefined,
		undefined,
		sessionContext(sessionA),
	);
	const prompted = record(startedPrompt.details, "combined start consent");
	assert.equal(prompted.outcome, "native-review-consent-required");
	const consentBinding = stringValue(prompted.consent_binding, "combined consent binding");
	const started = await controller.execute(
		"combined-answer-consent",
		{ operation: "answer-consent", workspaceRoot: nestedTarget, input: JSON.stringify({ consentBinding, answer: "granted" }) },
		undefined,
		undefined,
		sessionContext(sessionA),
	);
	const startedDetails = record(started.details, "combined granted start");
	assert.equal(startedDetails.workspace_root, canonicalB);
	const lineage = stringValue(record(startedDetails.result, "combined start result").lineage_id, "combined lineage");

	const fakePiDirectory = join(sessionA, "fake-pi-bin");
	mkdirSync(fakePiDirectory);
	const fakePi = join(fakePiDirectory, "pi");
	const fakePiLog = join(sessionA, "fake-pi-log.json");
	writeFileSync(fakePi, FAKE_POSIX_PI);
	chmodSync(fakePi, 0o755);
	environment.PATH = [fakePiDirectory, process.env.PATH].filter((entry): entry is string => entry !== undefined && entry.length > 0).join(delimiter);
	environment.OPAQUE_PI_REVIEWER_ARGV = JSON.stringify(OPAQUE_PI_REVIEWER_ARGV);
	environment.OPAQUE_PI_REVIEWER_LOG = fakePiLog;
	environment.OPAQUE_PI_REVIEWER_PATHS = JSON.stringify([".github/workflows/relay.yml", "selected.txt"]);
	const reviewerFindings = [{
		location: "selected.txt:1",
		severity: "BLOCKER",
		claim: "the selected relay input must be corrected before delivery",
		proof_refs: ["selected.txt:1"],
		evidence_class: "deterministic",
		causal_disposition: "introduced",
	}];
	const relayTargetRoots: string[] = [];
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	__testing.setReviewHostRelayRunnerForTesting(async (request) => {
		assert.equal(request.targetCwd, canonicalB, "the host relay must materialize and submit against B");
		relayTargetRoots.push(request.targetCwd!);
		return await runReviewHostRelaySlot({
			...request,
			gentleAiExecutable: RELAY_DEV_BINARY!,
			piExecutable: fakePi,
			environment: {
				...environment,
				OPAQUE_PI_REVIEWER_ARGV: JSON.stringify(OPAQUE_PI_REVIEWER_ARGV),
				OPAQUE_PI_REVIEWER_LOG: fakePiLog,
				OPAQUE_PI_REVIEWER_PATHS: JSON.stringify([".github/workflows/relay.yml", "selected.txt"]),
				OPAQUE_PI_REVIEWER_FINDINGS: JSON.stringify(reviewerFindings),
			},
			gentleAiTimeoutMs: 30_000,
			piTimeoutMs: 30_000,
		});
	});

	const captured = await controller.execute(
		"combined-capture-reviewer",
		{ operation: "finalize", lineageId: lineage, workspaceRoot: nestedTarget, input: JSON.stringify({ reviewer_run_acknowledged: true }) },
		undefined,
		undefined,
		sessionContext(sessionA),
	);
	assert.equal(record(captured.details, "combined reviewer capture").host_relay !== undefined, true);
	assert.ok(relayTargetRoots.length > 0);
	assert.ok(relayTargetRoots.every((root) => root === canonicalB), "every relay leg must stay bound to B");
	const combinedFakePiLog = record(JSON.parse(readFileSync(fakePiLog, "utf8")) as unknown, "combined fake Pi log");
	assert.ok(Array.isArray(combinedFakePiLog.calls), "combined fake Pi log must record its subprocess calls");
	assert.ok(combinedFakePiLog.calls.length > 0, "the fake reviewer must receive every provider-bound reviewer call");
	for (const call of combinedFakePiLog.calls) {
		const fakePiResult = record(call, "combined fake Pi result");
		assert.equal(fakePiResult.subject_hash === undefined, false, "the fake reviewer must receive one provider-bound subject");
		assert.deepEqual(fakePiResult.argv, OPAQUE_PI_REVIEWER_ARGV);
	}

	const findingsFinalized = await controller.execute(
		"combined-finalize-findings",
		{ operation: "finalize", lineageId: lineage, workspaceRoot: nestedTarget, input: JSON.stringify({}) },
		undefined,
		undefined,
		sessionContext(sessionA),
	);
	assert.equal(record(record(findingsFinalized.details, "combined findings finalize").result, "combined findings result").state, "correction_required");

	const planned = await controller.execute(
		"combined-correction-plan",
		{ operation: "finalize", lineageId: lineage, workspaceRoot: nestedTarget, input: JSON.stringify({ correction_line_forecast: 1 }) },
		undefined,
		undefined,
		sessionContext(sessionA),
	);
	assert.equal(record(planned.details, "combined correction plan").workspace_root, canonicalB);
	writeFileSync(join(targetB, "selected.txt"), "selected relay input corrected\n");

	const evidenceCaptured = await controller.execute(
		"combined-correction-evidence",
		{ operation: "finalize", lineageId: lineage, workspaceRoot: nestedTarget, input: JSON.stringify({ final_evidence: "selected relay input corrected and focused proof passed", final_verification_outcome: "passed" }) },
		undefined,
		undefined,
		sessionContext(sessionA),
	);
	assert.equal(record(evidenceCaptured.details, "combined correction evidence").correction_step !== undefined, true, "correction evidence and validation must be separate FINALIZE calls");

	const validationStatus = await native.targetStatus!({ cwd: canonicalB, lineageId: lineage, agent: "pi", ...selection });
	const validationRequest = validationStatus.validationRequest;
	assert.ok(validationRequest, "passed correction evidence must yield a targeted validation request");
	assert.ok(validationRequest!.correctionPaths.length > 0, "correction paths must be non-empty");
	assert.ok(validationRequest!.correctionPaths.every((path) => validationStatus.projection.paths.includes(path)), "correction paths must stay inside B's frozen projection");
	assert.equal(validationRequest!.correctionPaths.includes("excluded.txt"), false, "an untracked path outside B's projection must not become a correction path");
	assert.ok(validationRequest!.policyContent.length > 0, "the native validator request must retain policy_content");
	assert.ok(validationRequest!.fixFindings.length > 0, "the native validator request must retain fix_findings");
	assert.ok(validationRequest!.fixClassifications.length > 0, "the native validator request must retain fix_classifications");

	const nativeValidatorInput = validationStatus.nextTransition?.collect?.inputs.find((input) => input.name === "provider_targeted_validator");
	assert.ok(nativeValidatorInput, "actual Pi STATUS must publish the targeted-validator input");
	assert.equal(nativeValidatorInput!.captureOperation, "review.capture-validation");
	assert.equal(nativeValidatorInput!.submissionDescriptor, undefined, "the self-contained Pi validator vector must not accept an external submission descriptor");
	assert.equal(nativeValidatorInput!.submission, undefined, "the self-contained Pi validator vector must not expose a relayed result submission");
	assert.deepEqual(nativeValidatorInput!.validationRequest, validationRequest, "STATUS must bind the provider validator slot to the exact native request");
	const validatorArgumentTokens = nativeValidatorInput!.arguments.map((argument) => argument.token ?? `--${argument.name}=${argument.value}`);
	assert.ok(validatorArgumentTokens.includes(`--request-hash=${validationRequest!.requestHash}`), "the self-contained validator vector must retain the native request hash");
	assert.ok(validatorArgumentTokens.includes("--agent=pi"), "the self-contained validator vector must retain the Pi binding");
	assert.ok(validatorArgumentTokens.includes("--execute=true"), "the self-contained validator vector must retain the Go-owned execution flag");

	const validationInput = {
		request_hash: validationRequest!.requestHash.replace(/^sha256:/, ""),
		correction_ids: validationRequest!.fixFindingIds,
		original_criteria: { passed: true, evidence: ["focused acceptance proof passed"] },
		correction_regression: { passed: true, evidence: ["focused regression proof passed"] },
		fix_caused_findings: [],
		follow_ups: [],
	};
	const finalizeCallsBeforeOutOfProjectionCheck = nativeCalls.filter((call) => call.arguments[0] === "review" && call.arguments[1] === "finalize").length;
	await assert.rejects(
		controller.execute(
			"combined-out-of-projection-validation",
			{ operation: "finalize", lineageId: lineage, workspaceRoot: nestedTarget, input: JSON.stringify({ validation: { ...validationInput, correction_paths: ["excluded.txt"] } }) },
			undefined,
			undefined,
			sessionContext(sessionA),
		),
	);
	assert.equal(nativeCalls.filter((call) => call.arguments[0] === "review" && call.arguments[1] === "finalize").length, finalizeCallsBeforeOutOfProjectionCheck, "a caller-authored out-of-projection correction path must be rejected before native FINALIZE");

	environment.OPAQUE_PI_TARGETED_VALIDATOR_RESULT = JSON.stringify({
		targeted_validation_request_hash: validationRequest!.requestHash,
		correction_target_identity: validationRequest!.correctionTargetIdentity,
		original_criteria: { passed: true, evidence: ["focused acceptance proof passed"] },
		correction_regression: { passed: true, evidence: ["focused regression proof passed"] },
		follow_ups: [],
	});
	const statusCallsBeforeValidator = nativeCalls.filter((call) => call.arguments[0] === "review" && call.arguments[1] === "status").length;
	const providerValidation = await controller.execute(
		"combined-provider-targeted-validation",
		{ operation: "finalize", lineageId: lineage, workspaceRoot: nestedTarget, input: JSON.stringify({}) },
		undefined,
		undefined,
		sessionContext(sessionA),
	);
	const providerValidationDetails = record(providerValidation.details, "combined provider targeted validation");
	const providerRoles = record(providerValidationDetails.provider_roles, "provider role capture");
	assert.equal(providerRoles.transport, "go_owned_pi_process");
	assert.equal(nativeCalls.filter((call) => call.arguments[0] === "review" && call.arguments[1] === "status").length, statusCallsBeforeValidator + 2, "the document-free controller FINALIZE must query STATUS before and after the Go-owned validator capture");
	const validationCaptureCalls = nativeCalls.filter((call) => call.arguments[0] === "review" && call.arguments[1] === "capture-validation");
	assert.equal(validationCaptureCalls.length, 1, "the real native validator must be captured exactly once");
	assert.equal(validationCaptureCalls[0]!.cwd, canonicalB);
	assert.deepEqual(validationCaptureCalls[0]!.arguments.slice(2), validatorArgumentTokens, "the real native validator must receive the provider-rendered self-contained vector verbatim");
	assert.equal(nativeCalls.filter((call) => call.arguments[0] === "review" && call.arguments[1] === "finalize").length, finalizeCallsBeforeOutOfProjectionCheck, "validator capture and receipt finalization must stay separate native calls");

	const validatorPiLog = record(JSON.parse(readFileSync(fakePiLog, "utf8")) as unknown, "validator fake Pi log");
	assert.ok(Array.isArray(validatorPiLog.calls), "validator fake Pi log must record the Go-owned subprocess");
	const validatorCall = validatorPiLog.calls.map((call) => record(call, "validator fake Pi call")).find((call) => call.role === "targeted-validator");
	assert.ok(validatorCall, "the fake Pi log must contain the Go-owned targeted-validator subprocess");
	assert.ok(Array.isArray(validatorCall!.argv), "the captured targeted-validator argv must be an array");
	assert.deepEqual(validatorCall!.entries, [], "the Go-owned validator must run from an empty isolated sandbox");
	assert.notEqual(validatorCall!.cwd, canonicalB, "the Go-owned validator subprocess must not run in B");
	assert.notEqual(validatorCall!.cwd, sessionA, "the Go-owned validator subprocess must not run in A");
	assert.equal(existsSync(stringValue(validatorCall!.cwd, "validator fake Pi scratch cwd")), false, "the Go-owned validator sandbox must be removed after the subprocess exits");
	const validatorPrompt = stringValue(validatorCall!.prompt, "validator fake Pi prompt");
	assert.ok(validatorPrompt.includes(validationRequest!.policyContent), "the Go-owned validator prompt must preserve the exact immutable policy_content");
	assert.ok(validatorPrompt.includes(validationRequest!.requestHash), "the Go-owned validator prompt must preserve the exact request hash");
	for (const finding of validationRequest!.fixFindings) {
		for (const value of [finding.id, finding.lens, finding.location, finding.severity, finding.claim, ...(finding.proofRefs ?? []), finding.evidenceClass, finding.causalDisposition]) {
			if (value !== undefined) assert.ok(validatorPrompt.includes(value), `the Go-owned validator prompt must preserve exact fix finding content: ${value}`);
		}
	}
	for (const classification of validationRequest!.fixClassifications) {
		for (const value of [classification.findingId, classification.severity, classification.class, classification.causalDisposition, classification.proof]) {
			if (value !== undefined) assert.ok(validatorPrompt.includes(value), `the Go-owned validator prompt must preserve exact fix classification content: ${value}`);
		}
	}

	const capturedValidatorStatus = decodeReviewStatusV3(providerValidationDetails.result);
	const finalizeTransition = capturedValidatorStatus.nextTransition?.kind === "execute" && capturedValidatorStatus.nextTransition.execute?.operation === "review.finalize"
		? capturedValidatorStatus.nextTransition.execute
		: undefined;
	assert.ok(finalizeTransition, "admitted targeted validation must reoffer the provider-rendered FINALIZE transition");
	const finalizeArgumentTokens = finalizeTransition!.arguments.map((argument) => {
		if (typeof argument.token !== "string" || argument.token.trim().length === 0) throw new Error(`status/v5 FINALIZE argument ${argument.name} must carry its exact provider-rendered token`);
		return argument.token;
	});
	assert.ok(finalizeArgumentTokens.includes("--captured-evidence=true"), "the provider-rendered FINALIZE transition must carry captured evidence");
	assert.ok(finalizeArgumentTokens.includes(`--lineage=${lineage}`), "the provider-rendered FINALIZE transition must retain the lineage binding");
	assert.ok(finalizeArgumentTokens.includes(`--expected-revision=${capturedValidatorStatus.authority!.revision}`), "the provider-rendered FINALIZE transition must retain the revision binding");
	assert.ok(finalizeArgumentTokens.includes(`--target=${finalizeTransition!.binding.targetIdentity}`), "the provider-rendered FINALIZE transition must retain the target binding");
	assert.ok(finalizeArgumentTokens.includes(`--repository-context=${capturedValidatorStatus.repositoryContext!.handle}`), "the provider-rendered FINALIZE transition must retain the repository-context binding");
	assert.ok(finalizeArgumentTokens.includes(`--request-hash=${validationRequest!.requestHash}`), "the provider-rendered FINALIZE transition must retain the validator request hash");

	assert.ok(native instanceof NativeReviewCliV216, "the terminal leg must use the real native client without a lifecycle method override");
	const finalized = await controller.execute(
		"combined-finalize-admitted-validation",
		{ operation: "finalize", lineageId: lineage, workspaceRoot: nestedTarget, input: JSON.stringify({}) },
		undefined,
		undefined,
		sessionContext(sessionA),
	);
	const finalizedDetails = record(finalized.details, "combined finalized validation");
	assert.ok(finalizedDetails.result, `the fresh provider FINALIZE transition must produce a native result: ${JSON.stringify(finalizedDetails)}`);
	assert.equal(record(finalizedDetails.result, "combined finalized validation result").state, "approved");
	const nativeFinalizeCalls = nativeCalls.filter((call) => call.arguments[0] === "review" && call.arguments[1] === "finalize");
	assert.equal(nativeFinalizeCalls.length, finalizeCallsBeforeOutOfProjectionCheck + 1, "only the terminal controller FINALIZE may add a native review.finalize call after validator admission");
	const terminalFinalizeCall = nativeFinalizeCalls[nativeFinalizeCalls.length - 1]!;
	const validationCaptureIndex = nativeCalls.indexOf(validationCaptureCalls[0]!);
	const terminalFinalizeIndex = nativeCalls.lastIndexOf(terminalFinalizeCall);
	assert.ok(validationCaptureIndex >= 0 && terminalFinalizeIndex > validationCaptureIndex, "the real capture-validation must precede terminal FINALIZE");
	const statusesAfterValidationBeforeFinalize = nativeCalls.slice(validationCaptureIndex + 1, terminalFinalizeIndex).filter((call) => call.arguments[0] === "review" && call.arguments[1] === "status");
	assert.ok(statusesAfterValidationBeforeFinalize.length >= 2, "capture-validation and the following document-free FINALIZE must each obtain real native STATUS before installed-binary FINALIZE");
	assert.ok(statusesAfterValidationBeforeFinalize.every((call) => call.cwd === canonicalB), "the post-validation STATUS queries must remain bound to B");
	assert.equal(terminalFinalizeCall.cwd, canonicalB);
	assert.deepEqual(terminalFinalizeCall.arguments.slice(2), finalizeArgumentTokens, "the installed binary must execute the fresh provider-rendered captured-evidence FINALIZE vector verbatim");
	assert.ok(terminalFinalizeCall.arguments.includes("--captured-evidence=true"), "the installed binary must execute --captured-evidence=true, not merely observe it");

	const terminal = await native.targetStatus!({ cwd: canonicalB, lineageId: lineage, agent: "pi", ...selection });
	assert.equal(terminal.authority, undefined, "terminal approval must burn the sandbox review authority");
	assert.equal(terminal.validationRequest, undefined, "terminal approval must burn the sandbox validation evidence request");
	assert.equal("evidence" in terminal.raw, false, "terminal STATUS must not retain sandbox validation evidence");
	assert.equal("staging" in terminal.raw, false, "terminal STATUS must not retain sandbox staging state");
	assert.equal(git(canonicalB, "diff", "--cached", "--name-only"), "", "terminal approval must leave no sandbox staging entries");
	assert.deepEqual(candidateJson(RELAY_DEV_BINARY!, sessionA, ["review", "mode", "status", "--cwd", canonicalB, "--json"], environment), isolatedModeAfterSetup, "approval must not change the isolated global or clone-local RDD mode");

	const lifecycleCalls = nativeCalls.filter((call) => call.arguments[0] === "review");
	assert.ok(lifecycleCalls.length > 0);
	assert.ok(lifecycleCalls.every((call) => call.cwd === canonicalB), "every controller-native lifecycle operation must run from B's canonical worktree root");
	const selectionBoundLifecycleCalls = nativeCalls.slice(selectionBoundCallOffset).filter((call) => call.arguments[0] === "review");
	for (const call of selectionBoundLifecycleCalls.filter((call) => call.arguments[1] === "status")) {
		assert.ok(selectionTokens.every((token) => call.arguments.includes(token)), `STATUS must preserve B's exact selected-untracked tokens: ${call.arguments.join(" ")}`);
	}
	const startCall = selectionBoundLifecycleCalls.find((call) => call.arguments[1] === "start");
	assert.ok(startCall, "controller START must reach native");
	assert.ok(selectionTokens.every((token) => startCall!.arguments.includes(token)), "START must preserve B's exact selected-untracked tokens");
	assert.equal(lifecycleCalls.some((call) => call.arguments[1] === "mode" && call.arguments[2] === "enable"), false, "Pi must never enable RDD automatically");
});
