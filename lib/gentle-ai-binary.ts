import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	GENTLE_AI_INSTALL_METHOD,
	GENTLE_AI_WINDOWS_SOURCE_MODULE,
	GENTLE_AI_WINDOWS_SOURCE_MODULE_CHECKSUM,
	GENTLE_AI_WINDOWS_SOURCE_PACKAGE_PATH,
	GENTLE_AI_WINDOWS_SOURCE_TAG,
	INSTALLER_VERSION,
	isGentleAiWindowsGoVersionSupported,
	isWindowsGoSumdbSourceTarget,
	resolveGentleAiReleaseAsset,
} from "../scripts/gentle-ai-installer.mjs";
import { fileURLToPath } from "node:url";

export const GENTLE_AI_BINARY_MISSING_CODE = "package-local-binary-missing";
// Derived from the one authoritative pinned version in
// scripts/gentle-ai-installer.mjs rather than repeating the literal here, so
// the two can never independently drift apart the way they once did.
export const GENTLE_AI_VERSION = INSTALLER_VERSION;

export class PackageLocalGentleAiBinaryMissingError extends Error {
	readonly code = GENTLE_AI_BINARY_MISSING_CODE;
	constructor(path: string) {
		super(
			`${GENTLE_AI_BINARY_MISSING_CODE}: Gentle AI v${GENTLE_AI_VERSION} is not installed at ${path}. Reinstall gentle-pi, or use GENTLE_PI_SKIP_GENTLE_AI_INSTALL=1 only for development/offline installs.`,
		);
		this.name = "PackageLocalGentleAiBinaryMissingError";
	}
}

export function gentleAiBinaryPath(
	packageRoot = dirname(dirname(fileURLToPath(import.meta.url))),
	platform = process.platform,
): string {
	return join(
		resolve(packageRoot),
		".gentle-ai",
		`v${GENTLE_AI_VERSION}`,
		platform === "win32" ? "gentle-ai.exe" : "gentle-ai",
	);
}

function sha256(value: Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// Dev-binary override — the maintainer field-test lane.
//
// Two explicit activation paths, in precedence order:
//   1. GENTLE_PI_GENTLE_AI_DEV_BINARY (session override, absolute path), then
//   2. the persistent registration file at
//      <GENTLE_PI_CONFIG_HOME|~/.pi/gentle-ai>/dev-binary.json with the strict
//      shape {"schema":"gentle-pi.dev-binary/v1","path":"<absolute path>"}.
//
// The registration deliberately pins no digest: it is the unpinned field-test
// mode, and the binary at that path changes on every rebuild. Every resolution
// re-validates the file and recomputes the sha256, so a rebuilt binary is
// followed automatically with a fresh digest and no re-registration.
//
// Guardrails per resolution: absolute path, regular non-symlink file, POSIX
// executable. Any failure — including a malformed registration document or a
// registered-but-missing binary — is a typed error naming its origin, never a
// silent fallback to the pinned binary: silently running the pin while the
// maintainer believes he is field-testing main is the worst possible outcome.
// With neither activation path present, the pinned supply-chain resolution
// below stays byte-identical.
// ---------------------------------------------------------------------------

export const GENTLE_AI_DEV_BINARY_ENV = "GENTLE_PI_GENTLE_AI_DEV_BINARY";
export const GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA = "gentle-pi.dev-binary/v1";
export const GENTLE_AI_DEV_BINARY_OVERRIDE_INVALID_CODE = "dev-binary-override-invalid";
export const GENTLE_AI_LOCAL_MAIN_SNAPSHOT_SCHEMA = "gentle-pi.local-main-snapshot/v1";
export const GENTLE_AI_PINNED_MAIN_REGISTRATION_SCHEMA = "gentle-pi.pinned-main-binary/v1";
export const GENTLE_AI_PINNED_MAIN_BINARY_INVALID_CODE = "pinned-main-binary-invalid";

export interface GentleAiPinnedMainBinary {
	path: string;
	sha256: string;
	sourceRepository: string;
	sourceBranch: "main" | "custom/main";
	sourceRevision: string;
	sourceTreeSha256: string;
	versionOutput: string;
	buildCommand: string;
}

export class GentleAiPinnedMainBinaryError extends Error {
	readonly code = GENTLE_AI_PINNED_MAIN_BINARY_INVALID_CODE;
	readonly origin: string;
	constructor(origin: string, reason: string) {
		super(`${GENTLE_AI_PINNED_MAIN_BINARY_INVALID_CODE}: ${origin} ${reason}. Fix or remove the pinned-main registration; no fallback binary will run while it is declared.`);
		this.name = "GentleAiPinnedMainBinaryError";
		this.origin = origin;
	}
}

export type GentleAiBinaryActivation =
	| { kind: "dev"; binary: GentleAiDevBinaryOverride }
	| { kind: "pinned-main"; binary: GentleAiPinnedMainBinary };

export interface GentleAiDevBinaryEnvironment {
	env: Record<string, string | undefined>;
	home: string;
}

export interface GentleAiDevBinaryOverride {
	source: "env" | "registration";
	/** The env var name or registration file path that selected this binary. */
	origin: string;
	path: string;
	sha256: string;
}

export class GentleAiDevBinaryOverrideError extends Error {
	readonly code = GENTLE_AI_DEV_BINARY_OVERRIDE_INVALID_CODE;
	readonly source: "env" | "registration";
	readonly origin: string;
	constructor(source: "env" | "registration", origin: string, reason: string) {
		super(`${GENTLE_AI_DEV_BINARY_OVERRIDE_INVALID_CODE}: ${origin} ${reason}. Fix or remove the override; the pinned binary is never used silently while an override is declared.`);
		this.name = "GentleAiDevBinaryOverrideError";
		this.source = source;
		this.origin = origin;
	}
}

let devBinaryEnvironmentTestingOverlay: GentleAiDevBinaryEnvironment | undefined;

/** Testing-only environment overlay; production code never calls this. */
export function setGentleAiDevBinaryEnvironmentForTesting(environment: GentleAiDevBinaryEnvironment | undefined): void {
	devBinaryEnvironmentTestingOverlay = environment;
}

function ambientDevBinaryEnvironment(): GentleAiDevBinaryEnvironment {
	return devBinaryEnvironmentTestingOverlay ?? { env: process.env, home: homedir() };
}

function gentleAiBinaryConfigHome(environment: GentleAiDevBinaryEnvironment): string {
	return environment.env.GENTLE_PI_CONFIG_HOME ?? join(environment.home, ".pi", "gentle-ai");
}

export function gentleAiDevBinaryRegistrationPath(environment: GentleAiDevBinaryEnvironment = ambientDevBinaryEnvironment()): string {
	return join(gentleAiBinaryConfigHome(environment), "dev-binary.json");
}

export function gentleAiPinnedMainRegistrationPath(environment: GentleAiDevBinaryEnvironment = ambientDevBinaryEnvironment()): string {
	return join(gentleAiBinaryConfigHome(environment), "pinned-main-binary.json");
}

function validateDevBinary(source: "env" | "registration", origin: string, path: string, platform: string): GentleAiDevBinaryOverride {
	if (typeof path !== "string" || path.length === 0) throw new GentleAiDevBinaryOverrideError(source, origin, "declares an empty dev binary path");
	if (!isAbsolute(path)) throw new GentleAiDevBinaryOverrideError(source, origin, `must name an absolute path, received "${path}"`);
	let details: ReturnType<typeof lstatSync>;
	try {
		details = lstatSync(path);
	} catch {
		throw new GentleAiDevBinaryOverrideError(source, origin, `names "${path}", which does not exist`);
	}
	if (!details.isFile() || details.isSymbolicLink()) throw new GentleAiDevBinaryOverrideError(source, origin, `names "${path}", which is not a regular non-symlink file`);
	if (platform !== "win32" && (details.mode & 0o111) === 0) throw new GentleAiDevBinaryOverrideError(source, origin, `names "${path}", which is not a POSIX executable`);
	let digest: string;
	try {
		digest = sha256(readFileSync(path));
	} catch {
		throw new GentleAiDevBinaryOverrideError(source, origin, `names "${path}", which could not be read`);
	}
	return { source, origin, path, sha256: digest };
}

function readDevBinaryRegistration(registrationPath: string): string {
	let contents: string;
	try {
		contents = readFileSync(registrationPath, "utf8");
	} catch {
		throw new GentleAiDevBinaryOverrideError("registration", registrationPath, "could not be read");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		throw new GentleAiDevBinaryOverrideError("registration", registrationPath, "is not valid JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new GentleAiDevBinaryOverrideError("registration", registrationPath, "must be a JSON object");
	const record = parsed as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.length !== 2 || keys[0] !== "path" || keys[1] !== "schema") throw new GentleAiDevBinaryOverrideError("registration", registrationPath, `must carry exactly the keys "schema" and "path"`);
	if (record.schema !== GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA) throw new GentleAiDevBinaryOverrideError("registration", registrationPath, `must declare schema ${GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA}`);
	if (typeof record.path !== "string" || record.path.length === 0) throw new GentleAiDevBinaryOverrideError("registration", registrationPath, "must declare a non-empty string path");
	return record.path;
}

const PINNED_MAIN_REGISTRATION_KEYS = Object.freeze([
	"buildCommand", "path", "schema", "sha256", "sourceBranch", "sourceRepository", "sourceRevision", "sourceTreeSha256", "versionOutput",
]);
const LOCAL_MAIN_SNAPSHOT_KEYS = Object.freeze([
	"binarySha256", "buildCommand", "schema", "sourceBranch", "sourceRepository", "sourceRevision", "sourceTreeSha256", "versionOutput",
]);

function readPinnedObject(path: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new GentleAiPinnedMainBinaryError(path, "is not valid readable JSON");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new GentleAiPinnedMainBinaryError(path, "must be a JSON object");
	return parsed as Record<string, unknown>;
}

function requireExactPinnedKeys(record: Record<string, unknown>, expected: readonly string[], origin: string): void {
	const keys = Object.keys(record).sort();
	if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
		throw new GentleAiPinnedMainBinaryError(origin, `must carry exactly ${expected.join(", ")}`);
	}
}

function pinnedString(record: Record<string, unknown>, key: string, origin: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) throw new GentleAiPinnedMainBinaryError(origin, `must declare a non-empty ${key}`);
	return value;
}

function validatePinnedMainIdentity(record: Record<string, unknown>, origin: string): Omit<GentleAiPinnedMainBinary, "path" | "sha256"> {
	const sourceRepository = pinnedString(record, "sourceRepository", origin);
	const sourceBranch = pinnedString(record, "sourceBranch", origin);
	const sourceRevision = pinnedString(record, "sourceRevision", origin);
	const sourceTreeSha256 = pinnedString(record, "sourceTreeSha256", origin);
	const versionOutput = pinnedString(record, "versionOutput", origin);
	const buildCommand = pinnedString(record, "buildCommand", origin);
	if (!isValidHttpsRepository(sourceRepository)) throw new GentleAiPinnedMainBinaryError(origin, "must bind an HTTPS sourceRepository with a non-empty host and no credentials");
	if (sourceBranch !== "main" && sourceBranch !== "custom/main") throw new GentleAiPinnedMainBinaryError(origin, `must bind sourceBranch main or custom/main, received ${sourceBranch}`);
	if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new GentleAiPinnedMainBinaryError(origin, "must bind a canonical 40-hex sourceRevision");
	if (!/^[0-9a-f]{64}$/.test(sourceTreeSha256)) throw new GentleAiPinnedMainBinaryError(origin, "must bind a canonical sourceTreeSha256");
	if (!versionOutput.startsWith("gentle-ai ")) throw new GentleAiPinnedMainBinaryError(origin, "must bind the exact gentle-ai version output");
	return { sourceRepository, sourceBranch, sourceRevision, sourceTreeSha256, versionOutput, buildCommand };
}

function isValidHttpsRepository(value: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		// Malformed URL (including invalid port syntax) fails closed.
		return false;
	}
	if (parsed.protocol !== "https:") return false;
	if (parsed.hostname.length === 0) return false;
	if (parsed.username.length > 0 || parsed.password.length > 0) return false;
	// A repository URL must name a non-root path; a bare host or "/" is not a repo.
	if (parsed.pathname.length < 2 || parsed.pathname === "/") return false;
	if (parsed.search !== "" || parsed.hash !== "") return false;
	return true;
}

function validatePinnedExecutable(path: string, expectedSha256: string, origin: string, platform: string): string {
	if (!isAbsolute(path)) throw new GentleAiPinnedMainBinaryError(origin, `must name an absolute path, received "${path}"`);
	let details: ReturnType<typeof lstatSync>;
	try {
		details = lstatSync(path);
	} catch {
		throw new GentleAiPinnedMainBinaryError(origin, `names "${path}", which does not exist`);
	}
	if (!details.isFile() || details.isSymbolicLink()) throw new GentleAiPinnedMainBinaryError(origin, `names "${path}", which is not a regular non-symlink file`);
	if (platform !== "win32" && (details.mode & 0o111) === 0) throw new GentleAiPinnedMainBinaryError(origin, `names "${path}", which is not executable`);
	const digest = sha256(readFileSync(path));
	if (!/^[0-9a-f]{64}$/.test(expectedSha256) || digest !== expectedSha256) throw new GentleAiPinnedMainBinaryError(origin, `binary digest mismatch for "${path}"`);
	return digest;
}

function readLocalMainSnapshot(binaryPath: string, platform: string): GentleAiPinnedMainBinary {
	const manifestPath = join(dirname(binaryPath), "integrity.json");
	let details: ReturnType<typeof lstatSync>;
	try {
		details = lstatSync(manifestPath);
	} catch {
		throw new GentleAiPinnedMainBinaryError(manifestPath, "is missing");
	}
	if (!details.isFile() || details.isSymbolicLink()) throw new GentleAiPinnedMainBinaryError(manifestPath, "must be a regular non-symlink file");
	const manifest = readPinnedObject(manifestPath);
	requireExactPinnedKeys(manifest, LOCAL_MAIN_SNAPSHOT_KEYS, manifestPath);
	if (manifest.schema !== GENTLE_AI_LOCAL_MAIN_SNAPSHOT_SCHEMA) throw new GentleAiPinnedMainBinaryError(manifestPath, `must declare schema ${GENTLE_AI_LOCAL_MAIN_SNAPSHOT_SCHEMA}`);
	pinnedString(manifest, "buildCommand", manifestPath);
	const sha256Value = pinnedString(manifest, "binarySha256", manifestPath);
	validatePinnedExecutable(binaryPath, sha256Value, manifestPath, platform);
	return { path: binaryPath, sha256: sha256Value, ...validatePinnedMainIdentity(manifest, manifestPath) };
}

function pinnedMainRegistrationDocument(binary: GentleAiPinnedMainBinary): Record<string, string> {
	return {
		schema: GENTLE_AI_PINNED_MAIN_REGISTRATION_SCHEMA,
		path: binary.path,
		sha256: binary.sha256,
		sourceRepository: binary.sourceRepository,
		sourceBranch: binary.sourceBranch,
		sourceRevision: binary.sourceRevision,
		sourceTreeSha256: binary.sourceTreeSha256,
		versionOutput: binary.versionOutput,
		buildCommand: binary.buildCommand,
	};
}

export function resolveGentleAiPinnedMainBinary(
	environment: GentleAiDevBinaryEnvironment = ambientDevBinaryEnvironment(),
	platform = process.platform,
): GentleAiPinnedMainBinary | undefined {
	const registrationPath = gentleAiPinnedMainRegistrationPath(environment);
	if (!existsSync(registrationPath)) return undefined;
	const record = readPinnedObject(registrationPath);
	requireExactPinnedKeys(record, PINNED_MAIN_REGISTRATION_KEYS, registrationPath);
	if (record.schema !== GENTLE_AI_PINNED_MAIN_REGISTRATION_SCHEMA) throw new GentleAiPinnedMainBinaryError(registrationPath, `must declare schema ${GENTLE_AI_PINNED_MAIN_REGISTRATION_SCHEMA}`);
	const path = pinnedString(record, "path", registrationPath);
	const expected = {
		path,
		sha256: pinnedString(record, "sha256", registrationPath),
		...validatePinnedMainIdentity(record, registrationPath),
	};
	validatePinnedExecutable(path, expected.sha256, registrationPath, platform);
	const snapshot = readLocalMainSnapshot(path, platform);
	if (JSON.stringify(pinnedMainRegistrationDocument(snapshot)) !== JSON.stringify(pinnedMainRegistrationDocument(expected))) {
		throw new GentleAiPinnedMainBinaryError(registrationPath, "does not match the snapshot integrity manifest");
	}
	return expected;
}

export function registerGentleAiPinnedMainBinary(
	path: string,
	environment: GentleAiDevBinaryEnvironment = ambientDevBinaryEnvironment(),
	platform = process.platform,
): { registrationPath: string; binary: GentleAiPinnedMainBinary } {
	const binary = readLocalMainSnapshot(path, platform);
	const registrationPath = gentleAiPinnedMainRegistrationPath(environment);
	mkdirSync(dirname(registrationPath), { recursive: true, mode: 0o700 });
	writeFileSync(registrationPath, `${JSON.stringify(pinnedMainRegistrationDocument(binary))}\n`, { mode: 0o600 });
	chmodSync(registrationPath, 0o600);
	return { registrationPath, binary };
}

export function unregisterGentleAiPinnedMainBinary(environment: GentleAiDevBinaryEnvironment = ambientDevBinaryEnvironment()): boolean {
	const registrationPath = gentleAiPinnedMainRegistrationPath(environment);
	if (!existsSync(registrationPath)) return false;
	rmSync(registrationPath);
	return true;
}

/**
 * Resolves the active dev-binary override, if any. Returns undefined only when
 * neither activation path is present; a present-but-invalid override always
 * throws a typed GentleAiDevBinaryOverrideError naming its origin.
 */
function resolveGentleAiEnvironmentDevBinaryOverride(
	environment: GentleAiDevBinaryEnvironment,
	platform: string,
): GentleAiDevBinaryOverride | undefined {
	const envValue = environment.env[GENTLE_AI_DEV_BINARY_ENV];
	if (envValue === undefined) return undefined;
	// A declared-but-empty env channel is an invalid override: it must fail
	// closed with the typed error rather than falling through to another lane.
	return validateDevBinary("env", GENTLE_AI_DEV_BINARY_ENV, envValue, platform);
}

function resolveGentleAiRegisteredDevBinaryOverride(
	environment: GentleAiDevBinaryEnvironment,
	platform: string,
): GentleAiDevBinaryOverride | undefined {
	const registrationPath = gentleAiDevBinaryRegistrationPath(environment);
	return existsSync(registrationPath)
		? validateDevBinary("registration", registrationPath, readDevBinaryRegistration(registrationPath), platform)
		: undefined;
}

export function resolveGentleAiDevBinaryOverride(
	environment: GentleAiDevBinaryEnvironment = ambientDevBinaryEnvironment(),
	platform = process.platform,
): GentleAiDevBinaryOverride | undefined {
	return resolveGentleAiEnvironmentDevBinaryOverride(environment, platform)
		?? resolveGentleAiRegisteredDevBinaryOverride(environment, platform);
}

/** Resolves custom binary activation in strict precedence: session dev, pinned main, legacy persistent dev. */
export function resolveGentleAiBinaryActivation(
	environment: GentleAiDevBinaryEnvironment = ambientDevBinaryEnvironment(),
	platform = process.platform,
): GentleAiBinaryActivation | undefined {
	const environmentDev = resolveGentleAiEnvironmentDevBinaryOverride(environment, platform);
	if (environmentDev !== undefined) return { kind: "dev", binary: environmentDev };
	const pinnedMain = resolveGentleAiPinnedMainBinary(environment, platform);
	if (pinnedMain !== undefined) return { kind: "pinned-main", binary: pinnedMain };
	const registeredDev = resolveGentleAiRegisteredDevBinaryOverride(environment, platform);
	return registeredDev === undefined ? undefined : { kind: "dev", binary: registeredDev };
}

/**
 * Cheap presence probe: is a dev-binary override declared at all? Used by the
 * native CLI to select the unpinned version gate without hashing the binary.
 * Declared-but-invalid still counts as configured — the resolution path will
 * fail loudly with the typed error instead of quietly using the pin.
 */
export function gentleAiDevBinaryOverrideConfigured(environment: GentleAiDevBinaryEnvironment = ambientDevBinaryEnvironment()): boolean {
	const envValue = environment.env[GENTLE_AI_DEV_BINARY_ENV];
	if (envValue !== undefined) return true;
	return existsSync(gentleAiDevBinaryRegistrationPath(environment));
}

/** Validates and persistently registers a dev binary; returns the fresh override. */
export function registerGentleAiDevBinary(
	path: string,
	environment: GentleAiDevBinaryEnvironment = ambientDevBinaryEnvironment(),
	platform = process.platform,
): { registrationPath: string; override: GentleAiDevBinaryOverride } {
	const registrationPath = gentleAiDevBinaryRegistrationPath(environment);
	const validated = validateDevBinary("registration", registrationPath, path, platform);
	mkdirSync(dirname(registrationPath), { recursive: true });
	writeFileSync(registrationPath, `${JSON.stringify({ schema: GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA, path })}\n`);
	return { registrationPath, override: validated };
}

/** Deletes the persistent registration; returns whether one existed. */
export function unregisterGentleAiDevBinary(environment: GentleAiDevBinaryEnvironment = ambientDevBinaryEnvironment()): boolean {
	const registrationPath = gentleAiDevBinaryRegistrationPath(environment);
	if (!existsSync(registrationPath)) return false;
	rmSync(registrationPath);
	return true;
}

function isConfined(path: string, directory: string): boolean {
	const relativePath = relative(directory, path);
	return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function assertRegularNonSymlink(path: string): void {
	const details = lstatSync(path);
	if (!details.isFile() || details.isSymbolicLink()) throw new Error("expected regular non-symlink file");
}

function assertPosixExecutable(path: string, platform: string): void {
	if (platform !== "win32" && (lstatSync(path).mode & 0o111) === 0) {
		throw new Error("expected executable POSIX binary");
	}
}

function signedReleaseManifest(asset: { name: string; sha256: string; binarySha256: string }): Record<string, string> {
	return { version: GENTLE_AI_VERSION, asset: asset.name, assetSha256: asset.sha256, binarySha256: asset.binarySha256 };
}

function windowsSourceManifest(manifest: Record<string, unknown>, binarySha256: string, platform: string): Record<string, string> {
	if (!isWindowsGoSumdbSourceTarget(platform, process.arch)) throw new Error("unsupported Windows source architecture");
	const architecture = process.arch === "x64" ? "x64" : "arm64";
	const goVersion = manifest.goVersion;
	if (manifest.moduleChecksum !== GENTLE_AI_WINDOWS_SOURCE_MODULE_CHECKSUM || typeof goVersion !== "string" || !isGentleAiWindowsGoVersionSupported(goVersion)) throw new Error("invalid Windows source provenance");
	return {
		version: GENTLE_AI_VERSION,
		method: GENTLE_AI_INSTALL_METHOD.GO_SUMDB_SOURCE_BUILD,
		package: GENTLE_AI_WINDOWS_SOURCE_PACKAGE_PATH,
		module: GENTLE_AI_WINDOWS_SOURCE_MODULE,
		tag: GENTLE_AI_WINDOWS_SOURCE_TAG,
		architecture,
		binarySha256,
		moduleChecksum: GENTLE_AI_WINDOWS_SOURCE_MODULE_CHECKSUM,
		goVersion,
		goos: "windows",
		goarch: process.arch === "x64" ? "amd64" : "arm64",
		buildMode: "exe",
		compiler: "gc",
		cgoEnabled: "0",
	};
}

function expectedRuntimeManifest(platform: string, binarySha256: string, manifest: Record<string, unknown>): Record<string, string> {
	if (platform === "win32") return windowsSourceManifest(manifest, binarySha256, platform);
	const asset = resolveGentleAiReleaseAsset(platform, process.arch);
	if (binarySha256 !== asset.binarySha256) throw new Error("runtime binary does not match pinned release digest");
	return signedReleaseManifest(asset);
}

function isCanonicalManifest(contents: string, manifest: Record<string, unknown>, expected: Record<string, string>): boolean {
	return contents === `${JSON.stringify(expected)}\n`
		&& Object.keys(manifest).length === Object.keys(expected).length
		&& Object.entries(expected).every(([key, value]) => manifest[key] === value);
}

function sameFile(before: ReturnType<typeof lstatSync>, after: ReturnType<typeof lstatSync>): boolean {
	return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs;
}

export function resolveGentleAiBinary(
	packageRoot = dirname(dirname(fileURLToPath(import.meta.url))),
	platform = process.platform,
	readBinary: (path: string) => Buffer = readFileSync,
	environment: GentleAiDevBinaryEnvironment = ambientDevBinaryEnvironment(),
): string {
	// Custom activation precedes the signed release pin: an explicit session
	// dev override, then a digest-bound main snapshot, then the legacy unpinned
	// registration. Every declared-but-invalid lane fails closed without fallback.
	const activation = resolveGentleAiBinaryActivation(environment, platform);
	if (activation !== undefined) return activation.binary.path;
	const binaryPath = gentleAiBinaryPath(packageRoot, platform);
	const versionDirectory = dirname(binaryPath);
	const manifestPath = join(versionDirectory, "integrity.json");
	try {
		if (!isAbsolute(binaryPath) || !isConfined(binaryPath, versionDirectory)) throw new Error("unconfined binary");
		for (const path of [join(resolve(packageRoot), ".gentle-ai"), versionDirectory]) {
			const details = lstatSync(path);
			if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("symlinked runtime directory");
		}
		assertRegularNonSymlink(binaryPath);
		assertPosixExecutable(binaryPath, platform);
		assertRegularNonSymlink(manifestPath);
		const beforeBinary = lstatSync(binaryPath);
		const beforeManifest = lstatSync(manifestPath);
		const manifestContents = readFileSync(manifestPath, "utf8");
		const manifest = JSON.parse(manifestContents) as Record<string, unknown>;
		const binarySha256 = sha256(readBinary(binaryPath));
		const expected = expectedRuntimeManifest(platform, binarySha256, manifest);
		if (!isCanonicalManifest(manifestContents, manifest, expected)) throw new Error("invalid runtime integrity manifest");
		const afterBinary = lstatSync(binaryPath);
		const afterManifest = lstatSync(manifestPath);
		if (!sameFile(beforeBinary, afterBinary) || !sameFile(beforeManifest, afterManifest)) throw new Error("runtime replaced during verification");
		assertPosixExecutable(binaryPath, platform);
		return binaryPath;
	} catch {
		throw new PackageLocalGentleAiBinaryMissingError(binaryPath);
	}
}
