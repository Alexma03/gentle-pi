import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const OPAQUE_PI_REVIEWER_ARGV = Object.freeze([
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

export const OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE = {
	SCRATCH_FAILED: "scratch-failed",
	LAUNCH_FAILED: "launch-failed",
	CANCELLED: "cancelled",
	TIMED_OUT: "timed-out",
	NONZERO_EXIT: "nonzero-exit",
	EMPTY_OUTPUT: "empty-output",
	CLEANUP_FAILED: "cleanup-failed",
} as const;
export type OpaquePiReviewerTransportFailureKind = (typeof OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE)[keyof typeof OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE];

export interface OpaquePiReviewerOptions {
	readonly piExecutable?: string;
	readonly environment?: NodeJS.ProcessEnv;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export interface OpaquePiReviewerResult {
	readonly stdout: Buffer;
	readonly promptByteLength: number;
	readonly stdoutByteLength: number;
}

export interface OpaquePiReviewerTransportDetails {
	readonly exitCode?: number | null;
	readonly stderr?: Buffer;
	readonly timedOut?: boolean;
	readonly cancelled?: boolean;
}

export class OpaquePiReviewerTransportError extends Error {
	readonly kind: OpaquePiReviewerTransportFailureKind;
	readonly exitCode: number | null;
	readonly stderr: Buffer;
	readonly timedOut: boolean;
	readonly cancelled: boolean;

	constructor(kind: OpaquePiReviewerTransportFailureKind, message: string, details: OpaquePiReviewerTransportDetails = {}) {
		super(message);
		this.name = "OpaquePiReviewerTransportError";
		this.kind = kind;
		this.exitCode = details.exitCode ?? null;
		this.stderr = details.stderr ?? Buffer.alloc(0);
		this.timedOut = details.timedOut ?? false;
		this.cancelled = details.cancelled ?? false;
	}
}

interface OpaquePiProcessResult {
	readonly stdout: Buffer;
	readonly stderr: Buffer;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
}

const DEFAULT_OPAQUE_PI_TIMEOUT_MS = 600_000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function runPiProcess(prompt: Buffer, scratchDirectory: string, options: OpaquePiReviewerOptions): Promise<OpaquePiProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(options.piExecutable ?? "pi", [...OPAQUE_PI_REVIEWER_ARGV], {
			cwd: scratchDirectory,
			env: options.environment ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const timeoutMs = options.timeoutMs ?? DEFAULT_OPAQUE_PI_TIMEOUT_MS;
		let timedOut = false;
		let cancelled = false;
		let settled = false;
		const timer = timeoutMs > 0
			? setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, timeoutMs)
			: undefined;
		timer?.unref();
		const cancel = () => {
			cancelled = true;
			child.kill("SIGKILL");
		};
		const clear = () => {
			if (timer !== undefined) clearTimeout(timer);
			options.signal?.removeEventListener("abort", cancel);
		};

		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clear();
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clear();
			resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: code, timedOut, cancelled });
		});
		if (options.signal?.aborted) cancel();
		else options.signal?.addEventListener("abort", cancel, { once: true });
		child.stdin.on("error", () => undefined);
		child.stdin.end(prompt);
	});
}

/** Runs raw prompt bytes through one fixed, isolated Pi process. */
export async function runOpaquePiReviewer(prompt: Buffer, options: OpaquePiReviewerOptions = {}): Promise<OpaquePiReviewerResult> {
	if (options.signal?.aborted) {
		throw new OpaquePiReviewerTransportError(
			OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.CANCELLED,
			"Pi process was cancelled before launch",
			{ cancelled: true },
		);
	}

	let scratchDirectory: string | undefined;
	try {
		try {
			scratchDirectory = await mkdtemp(join(tmpdir(), "gentle-pi-opaque-reviewer-"));
			await chmod(scratchDirectory, 0o700);
		} catch (error) {
			throw new OpaquePiReviewerTransportError(
				OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.SCRATCH_FAILED,
				`Pi scratch directory could not be prepared: ${errorMessage(error)}`,
			);
		}

		let processResult: OpaquePiProcessResult;
		try {
			processResult = await runPiProcess(prompt, scratchDirectory, options);
		} catch (error) {
			if (options.signal?.aborted) {
				throw new OpaquePiReviewerTransportError(
					OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.CANCELLED,
					"Pi process was cancelled",
					{ cancelled: true },
				);
			}
			throw new OpaquePiReviewerTransportError(
				OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.LAUNCH_FAILED,
				`Pi process could not start: ${errorMessage(error)}`,
			);
		}
		if (processResult.timedOut) {
			throw new OpaquePiReviewerTransportError(
				OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.TIMED_OUT,
				"Pi process timed out",
				{ exitCode: processResult.exitCode, stderr: processResult.stderr, timedOut: true },
			);
		}
		if (processResult.cancelled) {
			throw new OpaquePiReviewerTransportError(
				OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.CANCELLED,
				"Pi process was cancelled",
				{ exitCode: processResult.exitCode, stderr: processResult.stderr, cancelled: true },
			);
		}
		if (processResult.exitCode !== 0) {
			throw new OpaquePiReviewerTransportError(
				OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.NONZERO_EXIT,
				"Pi process failed",
				{ exitCode: processResult.exitCode, stderr: processResult.stderr },
			);
		}
		if (processResult.stdout.length === 0) {
			throw new OpaquePiReviewerTransportError(
				OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.EMPTY_OUTPUT,
				"Pi process produced no output bytes",
				{ exitCode: 0, stderr: processResult.stderr },
			);
		}
		return {
			stdout: processResult.stdout,
			promptByteLength: prompt.length,
			stdoutByteLength: processResult.stdout.length,
		};
	} finally {
		if (scratchDirectory !== undefined) {
			try {
				await rm(scratchDirectory, { recursive: true, force: true });
			} catch (error) {
				throw new OpaquePiReviewerTransportError(
					OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.CLEANUP_FAILED,
					`Pi scratch directory cleanup failed: ${errorMessage(error)}`,
				);
			}
		}
	}
}
