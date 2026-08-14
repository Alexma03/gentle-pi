// The thin Pi host relay (gentle-pi#311 P4; provider contract gentle-ai#3249).
//
// gentle-ai owns prompt materialization, role and schema selection, byte
// budgets, parsing, admission, immutable capture, retry and correction
// accounting, receipts, and delivery gates. This host boundary is
// intentionally narrow:
//
//   1. Run the exact provider-issued capture binding with `--agent pi
//      --materialize` and take stdout as opaque prompt BYTES, verbatim.
//   2. Launch a brand-new locked-down print-mode `pi` subprocess in a fresh
//      empty scratch directory, pipe the prompt through stdin, and take
//      stdout as raw final bytes. Model/provider/profile selection stays
//      user-owned: no --model, no --provider, environment untouched.
//   3. Submit those bytes untouched through the same exact binding with
//      `--input <tempfile>` (BOM-less: the buffer is written byte-for-byte).
//
// On any failure the relay returns a TYPED transport error and submits
// nothing further. After a transport failure the caller re-queries negotiated
// STATUS and relaunches only if the exact same bound slot is reoffered —
// never from transcript inference. The relay never parses or rebuilds
// binding, evidence, prompt, schema, budgets, or admission.

import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveGentleAiBinary } from "./gentle-ai-binary.ts";
import type { ReviewCollectInputV3 } from "./review-integration-v2.ts";
import { GENTLE_PI_REVIEW_RELAY_CONTRACT, GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV } from "./review-relay-contract.ts";

// The complete pinned lockdown argv for the reviewer `pi` subprocess: print
// mode, text output, and every discovery surface disabled. Nothing may be
// added or removed here without a new relay contract — in particular no
// --model/--provider/--profile, which remain user-owned.
export const REVIEW_HOST_RELAY_PI_ARGV = Object.freeze([
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
] as const);

export const REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE =
	"provider relay requires a gentle-ai build with the pi host relay surface";

export const REVIEW_HOST_RELAY_FAILURE = {
	RELAY_UNAVAILABLE: "relay-unavailable",
	HANDSHAKE_REFUSED: "handshake-refused",
	MATERIALIZE_FAILED: "materialize-failed",
	EMPTY_PROMPT: "empty-prompt",
	PI_LAUNCH_FAILED: "pi-launch-failed",
	PI_FAILED: "pi-failed",
	PI_EMPTY_OUTPUT: "pi-empty-output",
	SUBMISSION_REFUSED: "submission-refused",
} as const;
export type ReviewHostRelayFailureKind = (typeof REVIEW_HOST_RELAY_FAILURE)[keyof typeof REVIEW_HOST_RELAY_FAILURE];

export type ReviewHostRelayStage = "materialize" | "pi" | "submit";

export class ReviewHostRelayError extends Error {
	readonly kind: ReviewHostRelayFailureKind;
	readonly stage: ReviewHostRelayStage;
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly timedOut: boolean;
	// "none" until the submission invocation launches; a launched submission
	// whose outcome could not be read is "unknown" and the caller reconciles
	// through negotiated STATUS, never through a blind retry.
	readonly mutationOutcome: "none" | "unknown";
	constructor(kind: ReviewHostRelayFailureKind, stage: ReviewHostRelayStage, message: string, details?: { exitCode?: number | null; stderr?: string; timedOut?: boolean }) {
		super(message);
		this.name = "ReviewHostRelayError";
		this.kind = kind;
		this.stage = stage;
		this.exitCode = details?.exitCode ?? null;
		this.stderr = details?.stderr ?? "";
		this.timedOut = details?.timedOut ?? false;
		this.mutationOutcome = stage === "submit" ? "unknown" : "none";
	}
}

// Refusal classification for the materialize invocation. The installed
// gentle-ai is the only authority on whether the materialize form exists; Pi
// never version-sniffs. Two typed refusal classes are distinguished:
//
//   unknown-flag  the Go flag package's exact refusal for a flag the binary
//                 does not define (an old binary, e.g. the pinned 2.2.3) —
//                 the relay is unavailable and existing behavior stays
//                 untouched.
//   handshake     the provider's pre-authority pi admission refusal — always
//                 surfaced verbatim, never worked around.
const UNKNOWN_FLAG_REFUSAL = /flag provided but not defined: -{1,2}(?:materialize|agent)\b/;
const HANDSHAKE_REFUSAL = new RegExp(
	[
		GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV,
		GENTLE_PI_REVIEW_RELAY_CONTRACT.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"),
		"not eligible for immutable receipt review",
	].join("|"),
);

export function classifyReviewHostRelayRefusal(stderr: string): "unknown-flag" | "handshake" | "other" {
	if (UNKNOWN_FLAG_REFUSAL.test(stderr)) return "unknown-flag";
	if (HANDSHAKE_REFUSAL.test(stderr)) return "handshake";
	return "other";
}

// ---------------------------------------------------------------------------
// Slot detection — the provider decides. A collect input routes through the
// host relay ONLY when the provider itself issued the `--materialize` token
// (with the pi runtime identity) on a `review.capture-result` collection
// input. Nothing is ever inferred from state prose, risk, or transcript.
// ---------------------------------------------------------------------------

export interface ReviewHostRelaySlot {
	/** Every provider-issued argument token, verbatim, in provider order. */
	readonly captureArgumentTokens: readonly string[];
	/** The same binding tokens without the agent/materialize control tokens. */
	readonly submitArgumentTokens: readonly string[];
	readonly lens?: string;
	readonly order?: string;
	readonly subjectHash?: string;
}

function argumentValue(input: ReviewCollectInputV3, name: string): string | undefined {
	const matches = input.arguments.filter((argument) => argument.name === name);
	return matches.length === 1 ? matches[0]!.value : undefined;
}

function renderToken(argument: ReviewCollectInputV3["arguments"][number]): string {
	return argument.token ?? `--${argument.name}=${argument.value}`;
}

export function isReviewHostRelayCollectInput(input: ReviewCollectInputV3): boolean {
	return input.captureOperation === "review.capture-result"
		&& argumentValue(input, "materialize") === "true"
		&& argumentValue(input, "agent") === "pi";
}

export function reviewHostRelaySlots(inputs: readonly ReviewCollectInputV3[]): readonly ReviewHostRelaySlot[] {
	return inputs.filter((input) => isReviewHostRelayCollectInput(input)).map((input) => ({
		captureArgumentTokens: input.arguments.map((argument) => renderToken(argument)),
		submitArgumentTokens: input.arguments.filter((argument) => argument.name !== "agent" && argument.name !== "materialize").map((argument) => renderToken(argument)),
		...(argumentValue(input, "lens") === undefined ? {} : { lens: argumentValue(input, "lens") }),
		...(argumentValue(input, "order") === undefined ? {} : { order: argumentValue(input, "order") }),
		...(input.artifactSubject === undefined ? {} : { subjectHash: input.artifactSubject.subjectHash }),
	}));
}

// ---------------------------------------------------------------------------
// Relay execution
// ---------------------------------------------------------------------------

export interface ReviewHostRelayRequest {
	readonly captureArgumentTokens: readonly string[];
	readonly submitArgumentTokens: readonly string[];
	/** Absolute path; defaults to the verified package-local binary. */
	readonly gentleAiExecutable?: string;
	/** User-owned pi launcher; defaults to `pi` on PATH. */
	readonly piExecutable?: string;
	readonly environment?: NodeJS.ProcessEnv;
	readonly gentleAiTimeoutMs?: number;
	readonly piTimeoutMs?: number;
	readonly signal?: AbortSignal;
}

export interface ReviewHostRelayResult {
	readonly promptByteLength: number;
	readonly resultByteLength: number;
	/** Raw submission stdout (the provider's admitted-manifest JSON), opaque. */
	readonly submission: string;
}

export type ReviewHostRelayRunner = (request: ReviewHostRelayRequest) => Promise<ReviewHostRelayResult>;

const DEFAULT_GENTLE_AI_TIMEOUT_MS = 120_000;
const DEFAULT_PI_TIMEOUT_MS = 600_000;

interface ProcessCapture {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number | null;
	timedOut: boolean;
}

function collectProcess(
	file: string,
	arguments_: readonly string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; stdin?: Buffer; timeoutMs: number; signal?: AbortSignal },
): Promise<ProcessCapture> {
	return new Promise((resolve, reject) => {
		const child = spawn(file, [...arguments_], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let timedOut = false;
		let settled = false;
		const timer = options.timeoutMs > 0
			? setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, options.timeoutMs)
			: undefined;
		timer?.unref();
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code, timedOut });
		});
		if (options.stdin === undefined) {
			child.stdin.end();
		} else {
			child.stdin.on("error", () => undefined);
			child.stdin.end(options.stdin);
		}
	});
}

function assertTokens(name: string, tokens: readonly string[]): void {
	if (tokens.length === 0) throw new TypeError(`Pi host relay requires the provider-issued ${name} tokens`);
	if (tokens.some((token) => typeof token !== "string" || token.length === 0)) {
		throw new TypeError(`Pi host relay ${name} tokens must all be non-empty strings`);
	}
}

/**
 * Runs one complete host-relay capture for one provider-bound slot:
 * materialize → fresh locked-down pi subprocess → submit. Throws a typed
 * {@link ReviewHostRelayError} on every failure leg and submits nothing after
 * a failure; the caller re-queries negotiated STATUS instead of retrying.
 */
export async function runReviewHostRelaySlot(request: ReviewHostRelayRequest): Promise<ReviewHostRelayResult> {
	assertTokens("capture", request.captureArgumentTokens);
	assertTokens("submit", request.submitArgumentTokens);
	const gentleAi = request.gentleAiExecutable ?? resolveGentleAiBinary();
	if (!isAbsolute(gentleAi)) throw new TypeError("Pi host relay requires an absolute gentle-ai executable path");
	const baseEnvironment = request.environment ?? process.env;
	// Every gentle-ai invocation the relay makes carries the handshake; the
	// pi subprocess environment stays exactly as the user configured it.
	const gentleAiEnvironment = { ...baseEnvironment, [GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV]: GENTLE_PI_REVIEW_RELAY_CONTRACT };
	const gentleAiTimeoutMs = request.gentleAiTimeoutMs ?? DEFAULT_GENTLE_AI_TIMEOUT_MS;
	const piTimeoutMs = request.piTimeoutMs ?? DEFAULT_PI_TIMEOUT_MS;

	// (a) Materialize the Go-issued opaque prompt. This invocation is also the
	// capability detection: an old binary's unknown-flag refusal proves the
	// relay surface is absent, and the provider's handshake refusal surfaces
	// verbatim. No version sniffing.
	let materialized: ProcessCapture;
	try {
		materialized = await collectProcess(gentleAi, ["review", "capture-result", ...request.captureArgumentTokens], {
			cwd: process.cwd(),
			env: gentleAiEnvironment,
			timeoutMs: gentleAiTimeoutMs,
			...(request.signal === undefined ? {} : { signal: request.signal }),
		});
	} catch (error) {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.MATERIALIZE_FAILED, "materialize", `gentle-ai prompt materialization could not start: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (materialized.exitCode !== 0 || materialized.timedOut) {
		const stderr = materialized.stderr.toString("utf8");
		const refusal = classifyReviewHostRelayRefusal(stderr);
		if (refusal === "unknown-flag") {
			throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.RELAY_UNAVAILABLE, "materialize", REVIEW_HOST_RELAY_UNAVAILABLE_MESSAGE, { exitCode: materialized.exitCode, stderr, timedOut: materialized.timedOut });
		}
		if (refusal === "handshake") {
			throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.HANDSHAKE_REFUSED, "materialize", stderr, { exitCode: materialized.exitCode, stderr, timedOut: materialized.timedOut });
		}
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.MATERIALIZE_FAILED, "materialize", "gentle-ai prompt materialization failed", { exitCode: materialized.exitCode, stderr, timedOut: materialized.timedOut });
	}
	const promptBytes = materialized.stdout;
	if (promptBytes.length === 0) {
		throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.EMPTY_PROMPT, "materialize", "gentle-ai prompt materialization produced no bytes", { exitCode: 0, stderr: materialized.stderr.toString("utf8") });
	}

	// (b)/(c) Fresh locked-down pi subprocess in an empty scratch directory.
	const scratchDirectory = await mkdtemp(join(tmpdir(), "gentle-pi-host-relay-scratch-"));
	const stagingDirectory = await mkdtemp(join(tmpdir(), "gentle-pi-host-relay-result-"));
	try {
		await chmod(scratchDirectory, 0o700);
		await chmod(stagingDirectory, 0o700);
		let piRun: ProcessCapture;
		try {
			piRun = await collectProcess(request.piExecutable ?? "pi", REVIEW_HOST_RELAY_PI_ARGV, {
				cwd: scratchDirectory,
				env: baseEnvironment,
				stdin: promptBytes,
				timeoutMs: piTimeoutMs,
				...(request.signal === undefined ? {} : { signal: request.signal }),
			});
		} catch (error) {
			throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_LAUNCH_FAILED, "pi", `pi subprocess could not start: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (piRun.exitCode !== 0 || piRun.timedOut) {
			throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_FAILED, "pi", "pi subprocess failed", { exitCode: piRun.exitCode, stderr: piRun.stderr.toString("utf8"), timedOut: piRun.timedOut });
		}
		const resultBytes = piRun.stdout;
		if (resultBytes.length === 0) {
			throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.PI_EMPTY_OUTPUT, "pi", "pi subprocess produced no output bytes", { exitCode: 0, stderr: piRun.stderr.toString("utf8") });
		}

		// (d) Submit the raw final bytes untouched through the exact binding.
		const resultFile = join(stagingDirectory, "result.raw");
		await writeFile(resultFile, resultBytes, { mode: 0o600 });
		await chmod(resultFile, 0o600);
		let submission: ProcessCapture;
		try {
			submission = await collectProcess(gentleAi, ["review", "capture-result", ...request.submitArgumentTokens, "--input", resultFile], {
				cwd: process.cwd(),
				env: gentleAiEnvironment,
				timeoutMs: gentleAiTimeoutMs,
				...(request.signal === undefined ? {} : { signal: request.signal }),
			});
		} catch (error) {
			throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED, "submit", `gentle-ai capture submission could not start: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (submission.exitCode !== 0 || submission.timedOut || submission.stdout.length === 0) {
			throw new ReviewHostRelayError(REVIEW_HOST_RELAY_FAILURE.SUBMISSION_REFUSED, "submit", "gentle-ai refused the relayed capture submission", { exitCode: submission.exitCode, stderr: submission.stderr.toString("utf8"), timedOut: submission.timedOut });
		}
		return {
			promptByteLength: promptBytes.length,
			resultByteLength: resultBytes.length,
			submission: submission.stdout.toString("utf8"),
		};
	} finally {
		await rm(scratchDirectory, { recursive: true, force: true }).catch(() => undefined);
		await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
	}
}
