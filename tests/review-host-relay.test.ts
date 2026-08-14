import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeExecFileAdapter } from "../lib/native-review-cli.ts";
import {
	REVIEW_HOST_RELAY_FAILURE,
	REVIEW_HOST_RELAY_PI_ARGV,
	REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE,
	ReviewHostRelayError,
	classifyReviewHostRelayRefusal,
	reviewHostRelaySlots,
	runReviewHostRelaySlot,
} from "../lib/review-host-relay.ts";
import { GENTLE_PI_REVIEW_RELAY_CONTRACT, GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV } from "../lib/review-relay-contract.ts";
import type { ReviewCollectInputV3 } from "../lib/review-integration-v2.ts";

// ---------------------------------------------------------------------------
// Fake binaries. Following the repo's fake-executable idiom (shell/git
// wrappers in review-gate/git-commit-transaction tests), these are
// shebang scripts written into a scratch directory; node scripts are used so
// binary-unsafe bytes survive verbatim.
// ---------------------------------------------------------------------------

const FAKE_GENTLE_AI = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (process.env.RELAY_FAKE_LOG) fs.appendFileSync(process.env.RELAY_FAKE_LOG, JSON.stringify({ argv, contract: process.env.${GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV} ?? null }) + "\\n");
if (argv.some((token) => token === "--materialize" || token.startsWith("--materialize="))) {
	const mode = process.env.RELAY_FAKE_MATERIALIZE_MODE || "ok";
	if (mode === "ok") { process.stdout.write(Buffer.from(process.env.RELAY_FAKE_PROMPT_B64 || "", "base64")); process.exit(0); }
	if (mode === "empty") process.exit(0);
	if (mode === "unknown-flag") { process.stderr.write("flag provided but not defined: -materialize\\nUsage of gentle-ai review capture-result:\\n"); process.exit(2); }
	if (mode === "handshake") { process.stderr.write(process.env.RELAY_FAKE_HANDSHAKE_STDERR || "the active runtime is not eligible for immutable receipt review"); process.exit(1); }
	process.stderr.write("materialize exploded\\n"); process.exit(3);
}
const inputIndex = argv.indexOf("--input");
if (inputIndex >= 0) {
	const mode = process.env.RELAY_FAKE_SUBMIT_MODE || "ok";
	if (mode === "ok") {
		const bytes = fs.readFileSync(argv[inputIndex + 1]);
		if (process.env.RELAY_FAKE_SUBMIT_CAPTURE) fs.writeFileSync(process.env.RELAY_FAKE_SUBMIT_CAPTURE, bytes);
		process.stdout.write(JSON.stringify({ schema: "gentle-ai.review-result-artifact/v2", admission_decision: "completed" }));
		process.exit(0);
	}
	process.stderr.write("capture binding does not match the current reviewing authority\\n");
	process.exit(1);
}
process.stderr.write("unexpected fake gentle-ai invocation\\n");
process.exit(9);
`;

const FAKE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (process.env.RELAY_FAKE_PI_LOG) fs.appendFileSync(process.env.RELAY_FAKE_PI_LOG, JSON.stringify({ argv, cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), contract: process.env.${GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV} ?? null }) + "\\n");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
	const stdin = Buffer.concat(chunks);
	if (process.env.RELAY_FAKE_PI_STDIN_CAPTURE) fs.writeFileSync(process.env.RELAY_FAKE_PI_STDIN_CAPTURE, stdin);
	const mode = process.env.RELAY_FAKE_PI_MODE || "ok";
	if (mode === "ok") { process.stdout.write(Buffer.from(process.env.RELAY_FAKE_PI_OUTPUT_B64 || "", "base64")); process.exit(0); }
	if (mode === "empty") process.exit(0);
	if (mode === "hang") { setTimeout(() => process.exit(0), 10_000); return; }
	process.stderr.write("pi exploded\\n");
	process.exit(4);
});
`;

interface RelayHarness {
	directory: string;
	gentleAi: string;
	pi: string;
	logPath: string;
	piLogPath: string;
	stdinCapturePath: string;
	submitCapturePath: string;
	environment: NodeJS.ProcessEnv;
}

function harness(t: test.TestContext, overrides: Record<string, string> = {}): RelayHarness {
	const directory = mkdtempSync(join(tmpdir(), "gentle-pi-relay-harness-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const gentleAi = join(directory, "gentle-ai");
	const pi = join(directory, "pi");
	writeFileSync(gentleAi, FAKE_GENTLE_AI);
	chmodSync(gentleAi, 0o755);
	writeFileSync(pi, FAKE_PI);
	chmodSync(pi, 0o755);
	const logPath = join(directory, "gentle-ai.log");
	const piLogPath = join(directory, "pi.log");
	const stdinCapturePath = join(directory, "pi-stdin.bin");
	const submitCapturePath = join(directory, "submitted.bin");
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		RELAY_FAKE_LOG: logPath,
		RELAY_FAKE_PI_LOG: piLogPath,
		RELAY_FAKE_PI_STDIN_CAPTURE: stdinCapturePath,
		RELAY_FAKE_SUBMIT_CAPTURE: submitCapturePath,
		...overrides,
	};
	// The relay itself must add the handshake; the base environment never
	// carries it, so the fake-binary log proves the injection.
	delete environment[GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV];
	return { directory, gentleAi, pi, logPath, piLogPath, stdinCapturePath, submitCapturePath, environment };
}

function readLog(path: string): Array<{ argv: string[]; contract: string | null; cwd?: string; entries?: string[] }> {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

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

// Prompt and result bytes deliberately include binary-unsafe content: NUL,
// control bytes, quotes, backslashes, CRLF, multi-byte UTF-8, and bytes that
// are not valid UTF-8 at all. The relay must move them verbatim.
const PROMPT_BYTES = Buffer.concat([
	Buffer.from('GENTLE_AI_REVIEW_BINDING {"lineage":"review-1d5aadacc600e167"}\n"quotes" \\backslash\r\n\u00e9\u{1F3A9}\n', "utf8"),
	Buffer.from([0x00, 0x01, 0x07, 0xff, 0xfe, 0x00]),
]);
const PI_OUTPUT_BYTES = Buffer.concat([
	Buffer.from(`{"subject_hash":"sha256:${"a".repeat(64)}","findings":[]}\n`, "utf8"),
	Buffer.from([0x00, 0xf0, 0x9f, 0x8e, 0xa9, 0xff, 0x0d, 0x0a]),
]);

function relayRequest(fixture: RelayHarness, overrides: Record<string, unknown> = {}) {
	return {
		captureArgumentTokens: CAPTURE_TOKENS,
		submitArgumentTokens: BINDING_TOKENS,
		gentleAiExecutable: fixture.gentleAi,
		piExecutable: fixture.pi,
		environment: {
			...fixture.environment,
			RELAY_FAKE_PROMPT_B64: PROMPT_BYTES.toString("base64"),
			RELAY_FAKE_PI_OUTPUT_B64: PI_OUTPUT_BYTES.toString("base64"),
		},
		gentleAiTimeoutMs: 30_000,
		piTimeoutMs: 30_000,
		...overrides,
	};
}

async function rejectsWithRelayError(promise: Promise<unknown>, kind: string, stage: string): Promise<ReviewHostRelayError> {
	let caught: ReviewHostRelayError | undefined;
	await assert.rejects(promise, (error: unknown) => {
		assert.ok(error instanceof ReviewHostRelayError, `expected ReviewHostRelayError, received ${String(error)}`);
		caught = error;
		return error.name === "ReviewHostRelayError" && error.kind === kind && error.stage === stage;
	});
	return caught!;
}

// ---------------------------------------------------------------------------
// Handshake — every gentle-ai CLI spawn carries the compiled declaration.
// ---------------------------------------------------------------------------

test("the central native CLI runner declares the relay contract on every gentle-ai spawn", async (t) => {
	const fixture = harness(t);
	const probe = join(fixture.directory, "env-probe");
	writeFileSync(probe, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ contract: process.env.${GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV} ?? null }));\n`);
	chmodSync(probe, 0o755);
	const hadContract = Object.prototype.hasOwnProperty.call(process.env, GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV);
	const previous = process.env[GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV];
	delete process.env[GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV];
	t.after(() => {
		if (hadContract) process.env[GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV] = previous;
	});
	const adapter = createNodeExecFileAdapter();
	for (const argv of [["version"], ["review", "status", "--cwd", fixture.directory]]) {
		const result = await adapter({ file: probe, arguments: argv, cwd: fixture.directory, timeoutMs: 10_000, maxBufferBytes: 1024 * 1024 });
		assert.equal(result.exitCode, 0);
		assert.deepEqual(JSON.parse(result.stdout), { contract: GENTLE_PI_REVIEW_RELAY_CONTRACT });
	}
});

test("relay contract constants are the compiled gentle-ai handshake values", () => {
	assert.equal(GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV, "GENTLE_PI_REVIEW_RELAY_CONTRACT");
	assert.equal(GENTLE_PI_REVIEW_RELAY_CONTRACT, "gentle-pi.review-relay/v1");
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("relay happy path moves prompt and result bytes verbatim through a fresh empty scratch pi subprocess", async (t) => {
	const fixture = harness(t);
	const result = await runReviewHostRelaySlot(relayRequest(fixture));

	assert.equal(result.promptByteLength, PROMPT_BYTES.length);
	assert.equal(result.resultByteLength, PI_OUTPUT_BYTES.length);
	assert.equal(JSON.parse(result.submission).admission_decision, "completed");

	// Prompt bytes reached pi stdin verbatim.
	assert.deepEqual(readFileSync(fixture.stdinCapturePath), PROMPT_BYTES);
	// Submission --input file bytes are EXACTLY the pi stdout bytes.
	assert.deepEqual(readFileSync(fixture.submitCapturePath), PI_OUTPUT_BYTES);

	const gentleAiCalls = readLog(fixture.logPath);
	assert.equal(gentleAiCalls.length, 2);
	// (a) exact provider tokens, verbatim, in provider order.
	assert.deepEqual(gentleAiCalls[0]!.argv, ["review", "capture-result", ...CAPTURE_TOKENS]);
	// (d) same exact binding args plus only --input; no agent/materialize.
	assert.deepEqual(gentleAiCalls[1]!.argv.slice(0, 2 + BINDING_TOKENS.length), ["review", "capture-result", ...BINDING_TOKENS]);
	assert.equal(gentleAiCalls[1]!.argv.at(-2), "--input");
	assert.equal(gentleAiCalls[1]!.argv.length, 2 + BINDING_TOKENS.length + 2);
	assert.equal(gentleAiCalls[1]!.argv.some((token) => token.includes("--agent") || token.includes("--materialize")), false);
	// Handshake declared on both gentle-ai invocations even though the base
	// environment carried none.
	assert.deepEqual(gentleAiCalls.map((call) => call.contract), [GENTLE_PI_REVIEW_RELAY_CONTRACT, GENTLE_PI_REVIEW_RELAY_CONTRACT]);

	const piCalls = readLog(fixture.piLogPath);
	assert.equal(piCalls.length, 1);
	// The pi environment stays untouched: no relay handshake is injected.
	assert.equal(piCalls[0]!.contract, null);
	// Fresh EMPTY scratch cwd, removed after the run.
	assert.deepEqual(piCalls[0]!.entries, []);
	assert.notEqual(piCalls[0]!.cwd, process.cwd());
	assert.equal(existsSync(piCalls[0]!.cwd!), false);
});

test("the pi lockdown argv is pinned exactly with no model or provider selection", async (t) => {
	const fixture = harness(t);
	await runReviewHostRelaySlot(relayRequest(fixture));
	const piCalls = readLog(fixture.piLogPath);
	const expected = [
		"--print",
		"--mode", "text",
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--no-approve",
	];
	assert.deepEqual([...REVIEW_HOST_RELAY_PI_ARGV], expected);
	assert.deepEqual(piCalls[0]!.argv, expected);
	assert.equal(piCalls[0]!.argv.some((token) => token.startsWith("--model") || token.startsWith("--provider") || token.startsWith("--profile")), false);
});

// ---------------------------------------------------------------------------
// Fail-closed legs — a typed transport error and NO submission.
// ---------------------------------------------------------------------------

test("materialize nonzero exit fails closed with a typed error and never launches pi or submits", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_MATERIALIZE_MODE: "fail" });
	const error = await rejectsWithRelayError(runReviewHostRelaySlot(relayRequest(fixture)), REVIEW_HOST_RELAY_FAILURE.MATERIALIZE_FAILED, "materialize");
	assert.equal(error.exitCode, 3);
	assert.equal(error.mutationOutcome, "none");
	assert.equal(readLog(fixture.logPath).length, 1);
	assert.equal(readLog(fixture.piLogPath).length, 0);
	assert.equal(existsSync(fixture.submitCapturePath), false);
});

test("an empty materialized prompt fails closed before pi launches", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_MATERIALIZE_MODE: "empty" });
	await rejectsWithRelayError(runReviewHostRelaySlot(relayRequest(fixture)), REVIEW_HOST_RELAY_FAILURE.EMPTY_PROMPT, "materialize");
	assert.equal(readLog(fixture.piLogPath).length, 0);
	assert.equal(existsSync(fixture.submitCapturePath), false);
});

test("pi nonzero exit fails closed with a typed error and no submission", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_PI_MODE: "fail" });
	const error = await rejectsWithRelayError(runReviewHostRelaySlot(relayRequest(fixture)), REVIEW_HOST_RELAY_FAILURE.PI_FAILED, "pi");
	assert.equal(error.exitCode, 4);
	assert.equal(error.mutationOutcome, "none");
	assert.equal(readLog(fixture.logPath).length, 1, "no submission invocation after pi failure");
	assert.equal(existsSync(fixture.submitCapturePath), false);
});

test("empty pi stdout fails closed with a typed error and no submission", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_PI_MODE: "empty" });
	await rejectsWithRelayError(runReviewHostRelaySlot(relayRequest(fixture)), REVIEW_HOST_RELAY_FAILURE.PI_EMPTY_OUTPUT, "pi");
	assert.equal(readLog(fixture.logPath).length, 1);
	assert.equal(existsSync(fixture.submitCapturePath), false);
});

test("pi timeout fails closed with a typed error and no submission", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_PI_MODE: "hang" });
	const error = await rejectsWithRelayError(runReviewHostRelaySlot(relayRequest(fixture, { piTimeoutMs: 300 })), REVIEW_HOST_RELAY_FAILURE.PI_FAILED, "pi");
	assert.equal(error.timedOut, true);
	assert.equal(readLog(fixture.logPath).length, 1);
	assert.equal(existsSync(fixture.submitCapturePath), false);
});

test("submission refusal is a typed error whose outcome is unknown pending STATUS", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_SUBMIT_MODE: "refuse" });
	const error = await rejectsWithRelayError(runReviewHostRelaySlot(relayRequest(fixture)), REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED, "submit");
	assert.equal(error.mutationOutcome, "unknown");
	assert.match(error.stderr, /capture binding does not match/);
	assert.equal(readLog(fixture.logPath).length, 2);
});

test("relay scratch and staging directories are removed after failures too", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_PI_MODE: "fail" });
	await rejectsWithRelayError(runReviewHostRelaySlot(relayRequest(fixture)), REVIEW_HOST_RELAY_FAILURE.PI_FAILED, "pi");
	const piCalls = readLog(fixture.piLogPath);
	assert.equal(piCalls.length, 1);
	assert.equal(existsSync(piCalls[0]!.cwd!), false);
});

// ---------------------------------------------------------------------------
// Capability detection — typed refusal classes, no version sniffing.
// ---------------------------------------------------------------------------

test("an old binary's unknown-flag refusal classifies as relay-unavailable with the exact report", async (t) => {
	const fixture = harness(t, { RELAY_FAKE_MATERIALIZE_MODE: "unknown-flag" });
	const error = await rejectsWithRelayError(runReviewHostRelaySlot(relayRequest(fixture)), REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE, "materialize");
	assert.equal(error.message, REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE);
	assert.match(error.stderr, /flag provided but not defined: -materialize/);
	assert.equal(readLog(fixture.piLogPath).length, 0);
	assert.equal(existsSync(fixture.submitCapturePath), false);
});

test("a handshake refusal surfaces the provider refusal verbatim", async (t) => {
	const refusal = "review capture-result --agent pi: the active runtime is not eligible for immutable receipt review; supported immutable review runtimes: claude-code, codex, opencode";
	const fixture = harness(t, { RELAY_FAKE_MATERIALIZE_MODE: "handshake", RELAY_FAKE_HANDSHAKE_STDERR: refusal });
	const error = await rejectsWithRelayError(runReviewHostRelaySlot(relayRequest(fixture)), REVIEW_HOST_RELAY_FAILURE.HANDSHAKE_REFUSED, "materialize");
	assert.equal(error.message, refusal);
	assert.equal(error.stderr, refusal);
	assert.equal(readLog(fixture.piLogPath).length, 0);
});

test("refusal classification distinguishes unknown-flag, handshake, and other", () => {
	assert.equal(classifyReviewHostRelayRefusal("flag provided but not defined: -materialize\nUsage:"), "unknown-flag");
	assert.equal(classifyReviewHostRelayRefusal("flag provided but not defined: -agent"), "unknown-flag");
	assert.equal(classifyReviewHostRelayRefusal("the active runtime is not eligible for immutable receipt review"), "handshake");
	assert.equal(classifyReviewHostRelayRefusal("declare GENTLE_PI_REVIEW_RELAY_CONTRACT=gentle-pi.review-relay/v1"), "handshake");
	assert.equal(classifyReviewHostRelayRefusal("some unrelated explosion"), "other");
});

// ---------------------------------------------------------------------------
// Slot detection — the provider decides; nothing is inferred.
// ---------------------------------------------------------------------------

function collectInput(overrides: Partial<{ captureOperation: string; arguments: ReviewCollectInputV3["arguments"] }> = {}): ReviewCollectInputV3 {
	const argumentsList: ReviewCollectInputV3["arguments"] = overrides.arguments ?? [
		{ name: "lineage", value: "review-1d5aadacc600e167", token: "--lineage=review-1d5aadacc600e167" },
		{ name: "expected-revision", value: `sha256:${"c".repeat(64)}`, token: `--expected-revision=sha256:${"c".repeat(64)}` },
		{ name: "target", value: `sha256:${"d".repeat(64)}`, token: `--target=sha256:${"d".repeat(64)}` },
		{ name: "repository-context", value: `rctx1_${"e".repeat(64)}`, token: `--repository-context=rctx1_${"e".repeat(64)}` },
		{ name: "lens", value: "review-reliability", token: "--lens=review-reliability" },
		{ name: "order", value: "0", token: "--order=0" },
		{ name: "subject-hash", value: `sha256:${"a".repeat(64)}`, token: `--subject-hash=sha256:${"a".repeat(64)}` },
		{ name: "agent", value: "pi", token: "--agent=pi" },
		{ name: "materialize", value: "true", token: "--materialize=true" },
	];
	return {
		name: "reviewer_result",
		schema: "https://gentle-ai.dev/schema/review/reviewer/v1",
		captureOperation: overrides.captureOperation ?? "review.capture-result",
		arguments: argumentsList,
	};
}

test("only provider-issued pi --materialize capture-result inputs become relay slots", () => {
	const slots = reviewHostRelaySlots([collectInput()]);
	assert.equal(slots.length, 1);
	assert.deepEqual(slots[0]!.captureArgumentTokens, [...CAPTURE_TOKENS]);
	assert.deepEqual(slots[0]!.submitArgumentTokens, [...BINDING_TOKENS]);
	assert.equal(slots[0]!.lens, "review-reliability");
	assert.equal(slots[0]!.order, "0");

	const withoutMaterialize = collectInput({ arguments: collectInput().arguments.filter((argument) => argument.name !== "materialize") });
	assert.deepEqual(reviewHostRelaySlots([withoutMaterialize]), []);

	const withoutAgent = collectInput({ arguments: collectInput().arguments.filter((argument) => argument.name !== "agent") });
	assert.deepEqual(reviewHostRelaySlots([withoutAgent]), []);

	const foreignAgent = collectInput({ arguments: collectInput().arguments.map((argument) => argument.name === "agent" ? { ...argument, value: "codex", token: "--agent=codex" } : argument) });
	assert.deepEqual(reviewHostRelaySlots([foreignAgent]), []);

	const evidence = collectInput({ captureOperation: "review.capture-evidence" });
	assert.deepEqual(reviewHostRelaySlots([evidence]), []);
});

test("relay input validation rejects empty or malformed token lists before any process launches", async () => {
	await assert.rejects(runReviewHostRelaySlot({ captureArgumentTokens: [], submitArgumentTokens: BINDING_TOKENS }), TypeError);
	await assert.rejects(runReviewHostRelaySlot({ captureArgumentTokens: CAPTURE_TOKENS, submitArgumentTokens: [""] }), TypeError);
	await assert.rejects(runReviewHostRelaySlot({ captureArgumentTokens: CAPTURE_TOKENS, submitArgumentTokens: BINDING_TOKENS, gentleAiExecutable: "gentle-ai" }), TypeError);
});
