import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	GENTLE_AI_DEV_BINARY_ENV,
	GENTLE_AI_DEV_BINARY_OVERRIDE_INVALID_CODE,
	GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA,
	GentleAiDevBinaryOverrideError,
	PackageLocalGentleAiBinaryMissingError,
	gentleAiDevBinaryRegistrationPath,
	registerGentleAiDevBinary,
	resolveGentleAiBinary,
	resolveGentleAiDevBinaryOverride,
	setGentleAiDevBinaryEnvironmentForTesting,
	unregisterGentleAiDevBinary,
	type GentleAiDevBinaryEnvironment,
} from "../lib/gentle-ai-binary.ts";
import {
	NATIVE_REVIEW_ERROR_CODE,
	NativeReviewCliError,
	NativeReviewCliV214,
	NativeReviewCliV216,
	clearNativeReviewCapabilitiesCacheForTesting,
	type ExecFileAdapter,
} from "../lib/native-review-cli.ts";

// Dev-binary override, maintainer field-test lane. The pinned supply-chain
// resolver stays byte-identical while neither the env var nor the persistent
// registration file is present; every override failure is a typed refusal that
// names its origin, never a silent fallback to the pin (silently running the
// pinned release while the maintainer believes he is testing main is the worst
// outcome this contract exists to prevent).

const PLATFORM = "linux";

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function scratch(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}

function writeDevBinary(directory: string, contents = "#!/bin/sh\necho 'gentle-ai 9.9.9-dev+field'\n"): string {
	const path = join(directory, "gentle-ai");
	writeFileSync(path, contents);
	chmodSync(path, 0o755);
	return path;
}

function environment(home: string, env: Record<string, string | undefined> = {}): GentleAiDevBinaryEnvironment {
	return { env, home };
}

function writeRegistration(home: string, contents: string): string {
	const path = gentleAiDevBinaryRegistrationPath(environment(home));
	mkdirSync(join(home, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(path, contents);
	return path;
}

function registrationDocument(path: string): string {
	return `${JSON.stringify({ schema: GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA, path })}\n`;
}

const isOverrideError = (origin: string | RegExp) => (error: unknown): boolean =>
	error instanceof GentleAiDevBinaryOverrideError
	&& error.code === GENTLE_AI_DEV_BINARY_OVERRIDE_INVALID_CODE
	&& (typeof origin === "string" ? error.message.includes(origin) : origin.test(error.message));

test("the env override resolves the dev binary with a fresh sha256", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const bin = await scratch("gentle-pi-dev-bin-");
	const devBinary = writeDevBinary(bin);
	const env = environment(home, { [GENTLE_AI_DEV_BINARY_ENV]: devBinary });
	const override = resolveGentleAiDevBinaryOverride(env, PLATFORM);
	assert.equal(override?.source, "env");
	assert.equal(override?.path, devBinary);
	assert.equal(override?.sha256, sha256(devBinary));
	const packageRoot = await scratch("gentle-pi-dev-pkg-");
	assert.equal(resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, env), devBinary);
});

test("with no env var and no registration file, pinned resolution is byte-identical", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const packageRoot = await scratch("gentle-pi-dev-pkg-");
	const env = environment(home);
	assert.equal(resolveGentleAiDevBinaryOverride(env, PLATFORM), undefined);
	// An empty env value means unset, exactly like the pinned path today.
	assert.equal(resolveGentleAiDevBinaryOverride(environment(home, { [GENTLE_AI_DEV_BINARY_ENV]: "" }), PLATFORM), undefined);
	assert.throws(() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, env), PackageLocalGentleAiBinaryMissingError);
});

test("a relative path, symlink, or non-executable env override is a typed refusal naming the env var", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const bin = await scratch("gentle-pi-dev-bin-");
	const devBinary = writeDevBinary(bin);
	const packageRoot = await scratch("gentle-pi-dev-pkg-");
	const symlinked = join(bin, "gentle-ai-link");
	symlinkSync(devBinary, symlinked);
	const nonExecutable = join(bin, "gentle-ai-noexec");
	writeFileSync(nonExecutable, "#!/bin/sh\n");
	chmodSync(nonExecutable, 0o644);
	for (const value of ["relative/gentle-ai", symlinked, nonExecutable, join(bin, "missing-gentle-ai")]) {
		const env = environment(home, { [GENTLE_AI_DEV_BINARY_ENV]: value });
		assert.throws(() => resolveGentleAiDevBinaryOverride(env, PLATFORM), isOverrideError(GENTLE_AI_DEV_BINARY_ENV), value);
		// Never a silent fallback to the pin.
		assert.throws(() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, env), isOverrideError(GENTLE_AI_DEV_BINARY_ENV), value);
	}
});

test("the registration file resolves the dev binary and the env var wins over it", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const bin = await scratch("gentle-pi-dev-bin-");
	const registered = writeDevBinary(bin);
	writeRegistration(home, registrationDocument(registered));
	const fileOnly = resolveGentleAiDevBinaryOverride(environment(home), PLATFORM);
	assert.equal(fileOnly?.source, "registration");
	assert.equal(fileOnly?.path, registered);
	const envDirectory = await scratch("gentle-pi-dev-bin-");
	const envBinary = writeDevBinary(envDirectory, "#!/bin/sh\necho 'gentle-ai 9.9.10-dev'\n");
	const both = resolveGentleAiDevBinaryOverride(environment(home, { [GENTLE_AI_DEV_BINARY_ENV]: envBinary }), PLATFORM);
	assert.equal(both?.source, "env");
	assert.equal(both?.path, envBinary);
});

test("GENTLE_PI_CONFIG_HOME relocates the registration file", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const configHome = await scratch("gentle-pi-dev-config-");
	const env = environment(home, { GENTLE_PI_CONFIG_HOME: configHome });
	assert.equal(gentleAiDevBinaryRegistrationPath(env), join(configHome, "dev-binary.json"));
	assert.equal(gentleAiDevBinaryRegistrationPath(environment(home)), join(home, ".pi", "gentle-ai", "dev-binary.json"));
});

test("a malformed or unresolvable registration is a typed refusal naming the file, never the pin", async () => {
	const bin = await scratch("gentle-pi-dev-bin-");
	const packageRoot = await scratch("gentle-pi-dev-pkg-");
	const devBinary = writeDevBinary(bin);
	const cases = [
		"not json at all",
		`${JSON.stringify({ schema: "gentle-pi.dev-binary/v0", path: devBinary })}\n`,
		`${JSON.stringify({ schema: GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA, path: devBinary, sha256: "0".repeat(64) })}\n`,
		`${JSON.stringify({ schema: GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA })}\n`,
		`${JSON.stringify({ schema: GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA, path: "relative/gentle-ai" })}\n`,
		`${JSON.stringify({ schema: GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA, path: join(bin, "missing-gentle-ai") })}\n`,
		`${JSON.stringify([devBinary])}\n`,
	];
	for (const contents of cases) {
		const home = await scratch("gentle-pi-dev-home-");
		const registrationPath = writeRegistration(home, contents);
		const env = environment(home);
		assert.throws(() => resolveGentleAiDevBinaryOverride(env, PLATFORM), isOverrideError(registrationPath), contents);
		assert.throws(() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, env), isOverrideError(registrationPath), contents);
	}
});

test("replacing the registered binary is picked up on the next resolution with the new sha256", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const bin = await scratch("gentle-pi-dev-bin-");
	const devBinary = writeDevBinary(bin, "#!/bin/sh\necho 'gentle-ai 9.9.9-dev+build1'\n");
	writeRegistration(home, registrationDocument(devBinary));
	const env = environment(home);
	const first = resolveGentleAiDevBinaryOverride(env, PLATFORM);
	writeFileSync(devBinary, "#!/bin/sh\necho 'gentle-ai 9.9.9-dev+build2'\n");
	chmodSync(devBinary, 0o755);
	const second = resolveGentleAiDevBinaryOverride(env, PLATFORM);
	assert.equal(first?.sha256, createHash("sha256").update("#!/bin/sh\necho 'gentle-ai 9.9.9-dev+build1'\n").digest("hex"));
	assert.equal(second?.sha256, createHash("sha256").update("#!/bin/sh\necho 'gentle-ai 9.9.9-dev+build2'\n").digest("hex"));
	assert.notEqual(first?.sha256, second?.sha256);
});

test("register and unregister write and delete the strict registration document", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const bin = await scratch("gentle-pi-dev-bin-");
	const devBinary = writeDevBinary(bin);
	const env = environment(home);
	const registered = registerGentleAiDevBinary(devBinary, env, PLATFORM);
	assert.equal(registered.registrationPath, gentleAiDevBinaryRegistrationPath(env));
	assert.equal(readFileSync(registered.registrationPath, "utf8"), registrationDocument(devBinary));
	assert.equal(resolveGentleAiDevBinaryOverride(env, PLATFORM)?.path, devBinary);
	assert.throws(() => registerGentleAiDevBinary("relative/gentle-ai", env, PLATFORM), isOverrideError(/relative\/gentle-ai/));
	assert.equal(unregisterGentleAiDevBinary(env), true);
	assert.equal(resolveGentleAiDevBinaryOverride(env, PLATFORM), undefined);
	assert.equal(unregisterGentleAiDevBinary(env), false);
});

// ---------------------------------------------------------------------------
// Version gate: dev mode accepts the binary's reported version with the latest
// known contract row as the capability floor; pinned mode stays byte-identical.
// ---------------------------------------------------------------------------

interface QueuedResult { stdout: string; stderr?: string; exitCode?: number }

function queuedAdapter(results: QueuedResult[]): { adapter: ExecFileAdapter; calls: Array<{ file: string; arguments: readonly string[] }> } {
	const calls: Array<{ file: string; arguments: readonly string[] }> = [];
	return {
		calls,
		adapter: async (request) => {
			calls.push({ file: request.file, arguments: request.arguments });
			const result = results.shift();
			if (!result) throw new Error("unexpected native invocation");
			return { stdout: result.stdout, stderr: result.stderr ?? "", exitCode: result.exitCode ?? 0, signal: null, timedOut: false, outputLimitExceeded: false };
		},
	};
}

const START = { stdout: JSON.stringify({ operation: "review/start", lineage_id: "lineage-1", state: "reviewing", risk_level: "medium", selected_lenses: ["review-reliability"], changed_files: 1, changed_lines: 2, correction_budget: 1, action: "created", lenses_required: true, projection: "workspace" }) };
const DEV_VERSION_OUTPUTS = ["gentle-ai 2.4.0-rc.8+fix.verify-attestation-recovery\n", "gentle-ai 9.9.9\n"];

async function withDevEnvironment<T>(callback: () => Promise<T>): Promise<T> {
	const home = await scratch("gentle-pi-dev-home-");
	const bin = await scratch("gentle-pi-dev-bin-");
	const devBinary = writeDevBinary(bin);
	setGentleAiDevBinaryEnvironmentForTesting({ env: { [GENTLE_AI_DEV_BINARY_ENV]: devBinary }, home });
	try {
		return await callback();
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}
}

async function withPinnedEnvironment<T>(callback: () => Promise<T>): Promise<T> {
	const home = await scratch("gentle-pi-dev-home-");
	setGentleAiDevBinaryEnvironmentForTesting({ env: {}, home });
	try {
		return await callback();
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}
}

test("pinned mode still refuses an unknown reported version", async () => {
	await withPinnedEnvironment(async () => {
		for (const stdout of DEV_VERSION_OUTPUTS) {
			const queue = queuedAdapter([{ stdout }]);
			await assert.rejects(
				() => new NativeReviewCliV214(queue.adapter, "/package/.gentle-ai/gentle-ai").start({ cwd: "/repo" }),
				(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.VERSION_INCOMPATIBLE,
				stdout,
			);
		}
	});
});

test("dev mode accepts the reported version and floors capabilities at the latest known contract row", async () => {
	await withDevEnvironment(async () => {
		for (const stdout of DEV_VERSION_OUTPUTS) {
			const queue = queuedAdapter([{ stdout }, START]);
			const result = await new NativeReviewCliV214(queue.adapter, "/package/.gentle-ai/gentle-ai").start({ cwd: "/repo" });
			assert.equal(result.lineageId, "lineage-1", stdout);
		}
	});
});

test("dev mode never rescues a pinned-mode unparseable version banner", async () => {
	await withDevEnvironment(async () => {
		const queue = queuedAdapter([{ stdout: "definitely not a version banner\n" }]);
		await assert.rejects(
			() => new NativeReviewCliV214(queue.adapter, "/package/.gentle-ai/gentle-ai").start({ cwd: "/repo" }),
			(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.VERSION_INCOMPATIBLE,
		);
	});
});

// Captured 2026-08-15 from /home/gentleman/.cargo/bin/gentle-ai reporting
// "gentle-ai 2.4.0-rc.8+fix.verify-attestation-recovery" (a gentle-ai main
// line dev build) via `gentle-ai review capabilities --contract
// gentle-ai.review-integration/v2` in a scratch git repository.
const CAPABILITIES_V22 = readFileSync(join(import.meta.dirname, "fixtures", "devbinary", "capabilities-v2.2.captured.json"), "utf8");
const CAPTURED_EXECUTABLE_DIGEST = "ffc91d8fa79c869aba9aa3d1ec80edebb5b1744e5a06fef75d4c8b73c0e46bc1";
const STATUS_V5 = readFileSync(join(import.meta.dirname, "fixtures", "devbinary", "status-v5.captured.json"), "utf8");
const FORECAST_STDERR = "Forecast horizon: partial\nstep 1: collect; reason_code=empty_candidate_base_ref_required; description=empty candidate base ref required\nRe-query STATUS after completing this partial head.\n";

function v216(adapter: ExecFileAdapter, digest: string): NativeReviewCliV216 {
	return new NativeReviewCliV216(adapter, "/package/.gentle-ai/gentle-ai", 30_000, 16 * 1024 * 1024, async () => undefined, () => digest);
}

test("pinned mode refuses a dev-version capabilities envelope on package version equality", async () => {
	clearNativeReviewCapabilitiesCacheForTesting();
	await withPinnedEnvironment(async () => {
		const queue = queuedAdapter([{ stdout: CAPABILITIES_V22 }]);
		await assert.rejects(
			() => v216(queue.adapter, CAPTURED_EXECUTABLE_DIGEST).capabilities({ cwd: "/repo" }),
			(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.VERSION_INCOMPATIBLE,
		);
	});
});

test("dev mode negotiates the captured v2.2 capabilities envelope without the pin equality", async () => {
	clearNativeReviewCapabilitiesCacheForTesting();
	await withDevEnvironment(async () => {
		const queue = queuedAdapter([{ stdout: CAPABILITIES_V22 }]);
		const capabilities = await v216(queue.adapter, CAPTURED_EXECUTABLE_DIGEST).capabilities({ cwd: "/repo" });
		assert.equal(capabilities.packageVersion, "2.4.0-rc.8+fix.verify-attestation-recovery");
	});
});

test("dev mode tolerates the provider's forecast narration on negotiated STATUS stderr and still refuses other stderr", async () => {
	await withDevEnvironment(async () => {
		clearNativeReviewCapabilitiesCacheForTesting();
		const queue = queuedAdapter([{ stdout: CAPABILITIES_V22 }, { stdout: STATUS_V5, stderr: FORECAST_STDERR }]);
		const status = await v216(queue.adapter, CAPTURED_EXECUTABLE_DIGEST).targetStatus({ cwd: "/repo", projection: "workspace" });
		assert.equal(status.action, "start");
		assert.equal(status.forecast?.horizon, "partial");
		clearNativeReviewCapabilitiesCacheForTesting();
		const noisy = queuedAdapter([{ stdout: CAPABILITIES_V22 }, { stdout: STATUS_V5, stderr: "panic: something else\n" }]);
		await assert.rejects(
			() => v216(noisy.adapter, CAPTURED_EXECUTABLE_DIGEST).targetStatus({ cwd: "/repo", projection: "workspace" }),
			(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.UNEXPECTED_STDERR,
		);
		clearNativeReviewCapabilitiesCacheForTesting();
	});
});

test("pinned mode still refuses forecast narration stderr on negotiated STATUS", async () => {
	await withPinnedEnvironment(async () => {
		clearNativeReviewCapabilitiesCacheForTesting();
		// A pinned-version capabilities envelope cannot be captured from the dev
		// binary; assert one layer down instead: with the dev override absent the
		// forecast narration is not in any tolerated stderr set, so the negotiated
		// STATUS invocation itself reports UNEXPECTED_STDERR. Capability
		// negotiation is bypassed by pre-seeding the cache through a dev-mode run
		// being impossible here, so this test drives the legacy client, whose
		// stderr discipline is the same code path.
		const queue = queuedAdapter([{ stdout: "gentle-ai 2.1.5\n" }, { stdout: STATUS_V5, stderr: FORECAST_STDERR }]);
		await assert.rejects(
			() => new NativeReviewCliV214(queue.adapter, "/package/.gentle-ai/gentle-ai").reviewStatus({ cwd: "/repo" }),
			(error: unknown) => error instanceof NativeReviewCliError && error.code === NATIVE_REVIEW_ERROR_CODE.UNEXPECTED_STDERR,
		);
		clearNativeReviewCapabilitiesCacheForTesting();
	});
});
