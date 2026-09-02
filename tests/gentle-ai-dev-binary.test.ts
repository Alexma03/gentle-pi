import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	GENTLE_AI_DEV_BINARY_ENV,
	GENTLE_AI_DEV_BINARY_OVERRIDE_INVALID_CODE,
	GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA,
	GENTLE_AI_LOCAL_MAIN_SNAPSHOT_SCHEMA,
	GENTLE_AI_PINNED_MAIN_BINARY_INVALID_CODE,
	GENTLE_AI_PINNED_MAIN_REGISTRATION_SCHEMA,
	GentleAiDevBinaryOverrideError,
	GentleAiPinnedMainBinaryError,
	PackageLocalGentleAiBinaryMissingError,
	gentleAiDevBinaryRegistrationPath,
	gentleAiPinnedMainRegistrationPath,
	registerGentleAiDevBinary,
	registerGentleAiPinnedMainBinary,
	resolveGentleAiBinary,
	resolveGentleAiBinaryActivation,
	resolveGentleAiDevBinaryOverride,
	resolveGentleAiPinnedMainBinary,
	unregisterGentleAiDevBinary,
	unregisterGentleAiPinnedMainBinary,
	type GentleAiDevBinaryEnvironment,
} from "../lib/gentle-ai-binary.ts";

const PLATFORM = process.platform;

async function scratch(prefix: string): Promise<string> {
	return await mkdtemp(join(tmpdir(), prefix));
}

function writeDevBinary(directory: string, contents = "#!/bin/sh\necho 'gentle-ai 9.9.9-dev+field'\n"): string {
	const path = join(directory, "gentle-ai");
	writeFileSync(path, contents);
	chmodSync(path, 0o755);
	return path;
}

function writePinnedMainSnapshot(directory: string, contents = "#!/bin/sh\necho 'gentle-ai main@test+local'\n", sourceBranch = "main", sourceRevision = "a".repeat(40), sourceTreeSha256 = "b".repeat(64), buildCommand = "go build -trimpath ./cmd/gentle-ai", sourceRepository = "https://github.com/Gentleman-Programming/gentle-ai"): { path: string; sha256: string } {
	const path = writeDevBinary(directory, contents);
	const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
	const banner = contents.match(/gentle-ai [^']+/);
	const versionOutput = banner ? banner[0] : "gentle-ai main@test+local";
	writeFileSync(join(directory, "integrity.json"), `${JSON.stringify({
		schema: GENTLE_AI_LOCAL_MAIN_SNAPSHOT_SCHEMA,
		sourceRepository,
		sourceBranch,
		sourceRevision,
		sourceTreeSha256,
		binarySha256: sha256,
		versionOutput,
		buildCommand,
	})}\n`);
	return { path, sha256 };
}

function environment(home: string, env: Record<string, string | undefined> = {}): GentleAiDevBinaryEnvironment {
	return { env, home };
}

function registrationDocument(path: string): string {
	return `${JSON.stringify({ schema: GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA, path })}\n`;
}

function writeRegistration(home: string, contents: string): string {
	const path = gentleAiDevBinaryRegistrationPath(environment(home));
	mkdirSync(join(home, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(path, contents);
	return path;
}

const isOverrideError = (origin: string | RegExp) => (error: unknown): boolean =>
	error instanceof GentleAiDevBinaryOverrideError
	&& error.code === GENTLE_AI_DEV_BINARY_OVERRIDE_INVALID_CODE
	&& (typeof origin === "string" ? error.message.includes(origin) : origin.test(error.message));

test("the explicit env override resolves a verified dev binary and never changes the pinned path", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const bin = await scratch("gentle-pi-dev-bin-");
	const packageRoot = await scratch("gentle-pi-dev-package-");
	const devBinary = writeDevBinary(bin);
	const env = environment(home, { [GENTLE_AI_DEV_BINARY_ENV]: devBinary });

	const override = resolveGentleAiDevBinaryOverride(env, PLATFORM);
	assert.equal(override?.source, "env");
	assert.equal(override?.path, devBinary);
	assert.match(override?.sha256 ?? "", /^[0-9a-f]{64}$/);
	assert.equal(resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, env), devBinary);

	const pinnedEnvironment = environment(home);
	assert.equal(resolveGentleAiDevBinaryOverride(pinnedEnvironment, PLATFORM), undefined);
	assert.throws(
		() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, pinnedEnvironment),
		PackageLocalGentleAiBinaryMissingError,
	);
});

test("a registration is strict, env wins, and unregister restores the pinned resolver", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const registeredDirectory = await scratch("gentle-pi-dev-bin-");
	const envDirectory = await scratch("gentle-pi-dev-env-");
	const registered = writeDevBinary(registeredDirectory);
	const envBinary = writeDevBinary(envDirectory, "#!/bin/sh\necho 'gentle-ai 9.9.10-dev'\n");
	const registeredResult = registerGentleAiDevBinary(registered, environment(home), PLATFORM);

	assert.equal(readFileSync(registeredResult.registrationPath, "utf8"), registrationDocument(registered));
	assert.equal(resolveGentleAiDevBinaryOverride(environment(home), PLATFORM)?.path, registered);
	assert.equal(resolveGentleAiDevBinaryOverride(environment(home, { [GENTLE_AI_DEV_BINARY_ENV]: envBinary }), PLATFORM)?.path, envBinary);
	assert.equal(unregisterGentleAiDevBinary(environment(home)), true);
	assert.equal(resolveGentleAiDevBinaryOverride(environment(home), PLATFORM), undefined);
	assert.equal(unregisterGentleAiDevBinary(environment(home)), false);
});

test("invalid override sources fail closed instead of silently falling back to the pin", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const bin = await scratch("gentle-pi-dev-bin-");
	const packageRoot = await scratch("gentle-pi-dev-package-");
	const devBinary = writeDevBinary(bin);
	const symlinked = join(bin, "gentle-ai-link");
	symlinkSync(devBinary, symlinked);
	const nonExecutable = join(bin, "gentle-ai-noexec");
	writeFileSync(nonExecutable, "#!/bin/sh\n");
	chmodSync(nonExecutable, 0o644);

	const invalidPaths = ["relative/gentle-ai", symlinked, ...(PLATFORM === "win32" ? [] : [nonExecutable]), join(bin, "missing-gentle-ai")];
	for (const value of invalidPaths) {
		const env = environment(home, { [GENTLE_AI_DEV_BINARY_ENV]: value });
		assert.throws(() => resolveGentleAiDevBinaryOverride(env, PLATFORM), isOverrideError(GENTLE_AI_DEV_BINARY_ENV), value);
		assert.throws(() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, env), isOverrideError(GENTLE_AI_DEV_BINARY_ENV), value);
	}

	const registrationPath = writeRegistration(home, "not-json\n");
	assert.throws(() => resolveGentleAiDevBinaryOverride(environment(home), PLATFORM), isOverrideError(registrationPath));
});

test("an unset dev-binary environment preserves the package-local resolver, but an empty declared env fails closed", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const packageRoot = await scratch("gentle-pi-dev-package-");
	// Unset: no channel declared, package-local resolver untouched.
	const unset = environment(home);
	assert.equal(resolveGentleAiDevBinaryOverride(unset, PLATFORM), undefined);
	assert.throws(() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, unset), PackageLocalGentleAiBinaryMissingError);
	// Empty declared env: a declared-but-invalid override, typed, never a fallback.
	const empty = environment(home, { [GENTLE_AI_DEV_BINARY_ENV]: "" });
	assert.throws(() => resolveGentleAiDevBinaryOverride(empty, PLATFORM), isOverrideError(GENTLE_AI_DEV_BINARY_ENV));
	assert.throws(() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, empty), isOverrideError(GENTLE_AI_DEV_BINARY_ENV));
	assert.throws(() => resolveGentleAiBinaryActivation(empty, PLATFORM), isOverrideError(GENTLE_AI_DEV_BINARY_ENV));
});

test("GENTLE_PI_CONFIG_HOME relocates only the local registration document", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const configHome = await scratch("gentle-pi-dev-config-");
	assert.equal(gentleAiDevBinaryRegistrationPath(environment(home, { GENTLE_PI_CONFIG_HOME: configHome })), join(configHome, "dev-binary.json"));
	assert.equal(gentleAiDevBinaryRegistrationPath(environment(home)), join(home, ".pi", "gentle-ai", "dev-binary.json"));
});

test("malformed registration variants name their local registration path and never fall back", async () => {
	const bin = await scratch("gentle-pi-dev-bin-");
	const packageRoot = await scratch("gentle-pi-dev-package-");
	const devBinary = writeDevBinary(bin);
	for (const contents of [
		"not json at all",
		`${JSON.stringify({ schema: "gentle-pi.dev-binary/v0", path: devBinary })}\n`,
		`${JSON.stringify({ schema: GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA })}\n`,
		`${JSON.stringify({ schema: GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA, path: "relative/gentle-ai" })}\n`,
		`${JSON.stringify([devBinary])}\n`,
	]) {
		const home = await scratch("gentle-pi-dev-home-");
		const registrationPath = writeRegistration(home, contents);
		const env = environment(home);
		assert.throws(() => resolveGentleAiDevBinaryOverride(env, PLATFORM), isOverrideError(registrationPath));
		assert.throws(() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, env), isOverrideError(registrationPath));
	}
});

test("registered binary replacement is observed on the next resolution", async () => {
	const home = await scratch("gentle-pi-dev-home-");
	const bin = await scratch("gentle-pi-dev-bin-");
	const devBinary = writeDevBinary(bin, "#!/bin/sh\necho 'gentle-ai 9.9.9-dev+build1'\n");
	writeRegistration(home, registrationDocument(devBinary));
	const env = environment(home);
	const first = resolveGentleAiDevBinaryOverride(env, PLATFORM);
	writeFileSync(devBinary, "#!/bin/sh\necho 'gentle-ai 9.9.9-dev+build2'\n");
	chmodSync(devBinary, 0o755);
	const second = resolveGentleAiDevBinaryOverride(env, PLATFORM);
	assert.notEqual(first?.sha256, second?.sha256);
	assert.equal(second?.path, devBinary);
});

test("a non-HTTPS or malformed sourceRepository fails closed", async () => {
	const home = await scratch("gentle-pi-repo-home-");
	const env = environment(home);
	const isPinnedError = (error: unknown): boolean => error instanceof GentleAiPinnedMainBinaryError && error.code === GENTLE_AI_PINNED_MAIN_BINARY_INVALID_CODE;
	const malformed: Array<[string, string]> = [
		["bare-https", "https://"],
		["http", "http://github.com/Gentleman-Programming/gentle-ai"],
		["credentials-user", "https://user@github.com/Gentleman-Programming/gentle-ai"],
		["credentials-pass", "https://user:pass@github.com/Gentleman-Programming/gentle-ai"],
		["no-host", "https:///repo"],
		["no-path", "https://github.com"],
		["root-path", "https://github.com/"],
		["bad-port", "https://github.com:bad/repo"],
		["query", "https://github.com/Gentleman-Programming/gentle-ai?tab=repositories"],
		["fragment", "https://github.com/Gentleman-Programming/gentle-ai#readme"],
	];
	for (const [label, sourceRepository] of malformed) {
		const snapshot = writePinnedMainSnapshot(await scratch("gentle-pi-repo-snapshot-"), undefined, "main", "a".repeat(40), "b".repeat(64), undefined, sourceRepository);
		assert.throws(() => registerGentleAiPinnedMainBinary(snapshot.path, env, PLATFORM), isPinnedError, label);
	}
});

test("a pinned main snapshot persists exact provenance and resolves before a legacy registration", async () => {
	const home = await scratch("gentle-pi-pinned-home-");
	const snapshotDirectory = await scratch("gentle-pi-pinned-snapshot-");
	const legacyDirectory = await scratch("gentle-pi-pinned-legacy-");
	const snapshot = writePinnedMainSnapshot(snapshotDirectory);
	const legacy = writeDevBinary(legacyDirectory);
	registerGentleAiDevBinary(legacy, environment(home), PLATFORM);
	const registered = registerGentleAiPinnedMainBinary(snapshot.path, environment(home), PLATFORM);

	assert.equal(registered.registrationPath, gentleAiPinnedMainRegistrationPath(environment(home)));
	assert.equal(statSync(registered.registrationPath).mode & 0o777, 0o600);
	const document = JSON.parse(readFileSync(registered.registrationPath, "utf8"));
	assert.deepEqual(document, {
		schema: GENTLE_AI_PINNED_MAIN_REGISTRATION_SCHEMA,
		path: snapshot.path,
		sha256: snapshot.sha256,
		sourceRepository: "https://github.com/Gentleman-Programming/gentle-ai",
		sourceBranch: "main",
		sourceRevision: "a".repeat(40),
		sourceTreeSha256: "b".repeat(64),
		versionOutput: "gentle-ai main@test+local",
		buildCommand: "go build -trimpath ./cmd/gentle-ai",
	});
	assert.equal(registered.binary.buildCommand, "go build -trimpath ./cmd/gentle-ai");
	assert.equal(resolveGentleAiPinnedMainBinary(environment(home), PLATFORM)?.buildCommand, "go build -trimpath ./cmd/gentle-ai");
	assert.equal(resolveGentleAiPinnedMainBinary(environment(home), PLATFORM)?.path, snapshot.path);
	assert.deepEqual(resolveGentleAiBinaryActivation(environment(home), PLATFORM), { kind: "pinned-main", binary: registered.binary });
	assert.equal(resolveGentleAiBinary(await scratch("gentle-pi-pinned-package-"), PLATFORM, readFileSync, environment(home)), snapshot.path);
});

test("a pinned main snapshot binds buildCommand immutably and fails closed on drift or missing key", async () => {
	const home = await scratch("gentle-pi-build-home-");
	const snapshotDirectory = await scratch("gentle-pi-build-snapshot-");
	const snapshot = writePinnedMainSnapshot(snapshotDirectory, undefined, "main", "a".repeat(40), "b".repeat(64), "go build -trimpath ./cmd/gentle-ai");
	const env = environment(home);
	const registered = registerGentleAiPinnedMainBinary(snapshot.path, env, PLATFORM);
	const isPinnedError = (error: unknown): boolean => error instanceof GentleAiPinnedMainBinaryError && error.code === GENTLE_AI_PINNED_MAIN_BINARY_INVALID_CODE;

	// Drift in the live manifest's buildCommand fails closed on resolution.
	const manifestPath = join(dirname(snapshot.path), "integrity.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.buildCommand = "go build -tags=drift ./cmd/gentle-ai";
	writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
	assert.throws(() => resolveGentleAiPinnedMainBinary(env, PLATFORM), isPinnedError);

	// Re-register with the matching manifest to restore, then prove the stored
	// buildCommand participates in the exact registration document.
	const rebuilt = writePinnedMainSnapshot(snapshotDirectory, undefined, "main", "a".repeat(40), "b".repeat(64), "go build -trimpath ./cmd/gentle-ai");
	registerGentleAiPinnedMainBinary(rebuilt.path, env, PLATFORM);
	const document = JSON.parse(readFileSync(registered.registrationPath, "utf8"));
	assert.equal(document.buildCommand, "go build -trimpath ./cmd/gentle-ai");

	// A registration record lacking the buildCommand key (old v1 record) fails closed.
	const oldRecord = JSON.parse(readFileSync(registered.registrationPath, "utf8"));
	delete oldRecord.buildCommand;
	writeFileSync(registered.registrationPath, `${JSON.stringify(oldRecord)}\n`);
	assert.throws(() => resolveGentleAiPinnedMainBinary(env, PLATFORM), isPinnedError);
});

test("an explicit session dev override wins over the persistent pinned main snapshot", async () => {
	const home = await scratch("gentle-pi-pinned-home-");
	const snapshot = writePinnedMainSnapshot(await scratch("gentle-pi-pinned-snapshot-"));
	const dev = writeDevBinary(await scratch("gentle-pi-pinned-env-"));
	registerGentleAiPinnedMainBinary(snapshot.path, environment(home), PLATFORM);
	const env = environment(home, { [GENTLE_AI_DEV_BINARY_ENV]: dev });
	assert.equal(resolveGentleAiBinaryActivation(env, PLATFORM)?.kind, "dev");
	assert.equal(resolveGentleAiBinary(await scratch("gentle-pi-pinned-package-"), PLATFORM, readFileSync, env), dev);
});

test("a pinned main snapshot fails closed on binary, registration, or provenance drift", async () => {
	const home = await scratch("gentle-pi-pinned-home-");
	const snapshotDirectory = await scratch("gentle-pi-pinned-snapshot-");
	const snapshot = writePinnedMainSnapshot(snapshotDirectory);
	const env = environment(home);
	const registered = registerGentleAiPinnedMainBinary(snapshot.path, env, PLATFORM);
	const isPinnedError = (error: unknown): boolean => error instanceof GentleAiPinnedMainBinaryError && error.code === GENTLE_AI_PINNED_MAIN_BINARY_INVALID_CODE;

	writeFileSync(snapshot.path, "#!/bin/sh\necho tampered\n");
	chmodSync(snapshot.path, 0o755);
	assert.throws(() => resolveGentleAiPinnedMainBinary(env, PLATFORM), isPinnedError);
	const packageRoot = await scratch("gentle-pi-pinned-package-");
	assert.throws(() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, env), isPinnedError);

	const replacement = writePinnedMainSnapshot(snapshotDirectory, "#!/bin/sh\necho restored\n");
	registerGentleAiPinnedMainBinary(replacement.path, env, PLATFORM);
	const registration = JSON.parse(readFileSync(registered.registrationPath, "utf8"));
	registration.sourceBranch = "release";
	writeFileSync(registered.registrationPath, `${JSON.stringify(registration)}\n`);
	assert.throws(() => resolveGentleAiPinnedMainBinary(env, PLATFORM), isPinnedError);
});

test("a custom/main snapshot binds its exact branch, persists exact provenance, and resolves over legacy registrations", async () => {
	const home = await scratch("gentle-pi-custom-home-");
	const snapshotDirectory = await scratch("gentle-pi-custom-snapshot-");
	const legacyDirectory = await scratch("gentle-pi-custom-legacy-");
	const snapshot = writePinnedMainSnapshot(
		snapshotDirectory,
		"#!/bin/sh\necho 'gentle-ai custom/main@cafe1234+local'\n",
		"custom/main",
		"c".repeat(40),
		"d".repeat(64),
	);
	const legacy = writeDevBinary(legacyDirectory);
	registerGentleAiDevBinary(legacy, environment(home), PLATFORM);
	const registered = registerGentleAiPinnedMainBinary(snapshot.path, environment(home), PLATFORM);

	assert.equal(registered.binary.sourceBranch, "custom/main");
	assert.equal(registered.binary.sourceRevision, "c".repeat(40));
	assert.equal(registered.binary.sourceTreeSha256, "d".repeat(64));
	assert.equal(registered.binary.versionOutput, "gentle-ai custom/main@cafe1234+local");
	assert.equal(registered.binary.buildCommand, "go build -trimpath ./cmd/gentle-ai");
	assert.equal(statSync(registered.registrationPath).mode & 0o777, 0o600);
	const document = JSON.parse(readFileSync(registered.registrationPath, "utf8"));
	assert.deepEqual(document, {
		schema: GENTLE_AI_PINNED_MAIN_REGISTRATION_SCHEMA,
		path: snapshot.path,
		sha256: snapshot.sha256,
		sourceRepository: "https://github.com/Gentleman-Programming/gentle-ai",
		sourceBranch: "custom/main",
		sourceRevision: "c".repeat(40),
		sourceTreeSha256: "d".repeat(64),
		versionOutput: "gentle-ai custom/main@cafe1234+local",
		buildCommand: "go build -trimpath ./cmd/gentle-ai",
	});
	assert.equal(resolveGentleAiPinnedMainBinary(environment(home), PLATFORM)?.path, snapshot.path);
	assert.deepEqual(resolveGentleAiBinaryActivation(environment(home), PLATFORM), { kind: "pinned-main", binary: registered.binary });
	assert.equal(resolveGentleAiBinary(await scratch("gentle-pi-custom-package-"), PLATFORM, readFileSync, environment(home)), snapshot.path);
});

test("a custom/main snapshot is revalidated against its integrity manifest on every resolution", async () => {
	const home = await scratch("gentle-pi-custom-revalidate-home-");
	const snapshotDirectory = await scratch("gentle-pi-custom-revalidate-snapshot-");
	const snapshot = writePinnedMainSnapshot(
		snapshotDirectory,
		"#!/bin/sh\necho 'gentle-ai custom/main@cafe1234+local'\n",
		"custom/main",
		"c".repeat(40),
		"d".repeat(64),
	);
	const env = environment(home);
	registerGentleAiPinnedMainBinary(snapshot.path, env, PLATFORM);
	const resolved = resolveGentleAiPinnedMainBinary(env, PLATFORM);
	assert.equal(resolved?.sourceBranch, "custom/main");
	assert.equal(resolved?.sourceRevision, "c".repeat(40));
	assert.equal(resolved?.sourceTreeSha256, "d".repeat(64));
	assert.equal(resolveGentleAiBinary(await scratch("gentle-pi-custom-revalidate-package-"), PLATFORM, readFileSync, env), snapshot.path);

	// The registration stores the snapshot's exact branch; resolution re-checks
	// the live manifest. Re-registering a rebuilt snapshot that keeps provenance
	// must keep resolving with the fresh digest.
	const rebuilt = writePinnedMainSnapshot(
		dirname(snapshot.path),
		"#!/bin/sh\necho 'gentle-ai custom/main@cafe1234+rebuilt'\n",
		"custom/main",
		"c".repeat(40),
		"d".repeat(64),
	);
	assert.equal(rebuilt.path, snapshot.path);
	assert.notEqual(rebuilt.sha256, snapshot.sha256);
	registerGentleAiPinnedMainBinary(rebuilt.path, env, PLATFORM);
	assert.equal(resolveGentleAiPinnedMainBinary(env, PLATFORM)?.path, snapshot.path);

	// Drift in the live manifest's branch fails closed.
	const manifest = JSON.parse(readFileSync(join(dirname(snapshot.path), "integrity.json"), "utf8"));
	manifest.sourceBranch = "develop";
	writeFileSync(join(dirname(snapshot.path), "integrity.json"), `${JSON.stringify(manifest)}\n`);
	assert.throws(() => resolveGentleAiPinnedMainBinary(env, PLATFORM), (error: unknown) => error instanceof GentleAiPinnedMainBinaryError && error.code === GENTLE_AI_PINNED_MAIN_BINARY_INVALID_CODE);
});

test("a non-allowed source branch fails closed without falling back to another binary", async () => {
	const home = await scratch("gentle-pi-custom-forbidden-home-");
	const snapshotDirectory = await scratch("gentle-pi-custom-forbidden-snapshot-");
	const snapshot = writePinnedMainSnapshot(snapshotDirectory, "#!/bin/sh\necho 'gentle-ai develop@test+local'\n", "develop", "e".repeat(40), "f".repeat(64));
	const env = environment(home);
	const isPinnedError = (error: unknown): boolean => error instanceof GentleAiPinnedMainBinaryError && error.code === GENTLE_AI_PINNED_MAIN_BINARY_INVALID_CODE;

	assert.throws(() => registerGentleAiPinnedMainBinary(snapshot.path, env, PLATFORM), isPinnedError);
	// The registration was refused; no snapshot can resolve, so no binary at all
	// may be surfaced. The package pin is not the forbidden snapshot.
	assert.equal(resolveGentleAiPinnedMainBinary(env, PLATFORM), undefined);
	const packageRoot = await scratch("gentle-pi-custom-forbidden-package-");
	assert.throws(() => resolveGentleAiBinary(packageRoot, PLATFORM, readFileSync, env), PackageLocalGentleAiBinaryMissingError);
});

test("the pinned main registration can be removed without touching the snapshot", async () => {
	const home = await scratch("gentle-pi-pinned-home-");
	const snapshot = writePinnedMainSnapshot(await scratch("gentle-pi-pinned-snapshot-"));
	const env = environment(home);
	registerGentleAiPinnedMainBinary(snapshot.path, env, PLATFORM);
	assert.equal(unregisterGentleAiPinnedMainBinary(env), true);
	assert.equal(unregisterGentleAiPinnedMainBinary(env), false);
	assert.equal(readFileSync(snapshot.path, "utf8").includes("gentle-ai"), true);
});
