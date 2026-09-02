#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	GENTLE_AI_LOCAL_MAIN_SNAPSHOT_SCHEMA,
	gentleAiDevBinaryRegistrationPath,
	gentleAiPinnedMainRegistrationPath,
	registerGentleAiPinnedMainBinary,
	unregisterGentleAiDevBinary,
} from "../runtime/gentle-ai-binary.mjs";
import { resolveGentleAiInstallerPackageRoot } from "./gentle-ai-installer.mjs";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;
const GO_TIMEOUT_MS = 180_000;
const COMMAND_MAX_BUFFER = 1024 * 1024;

export const GENTLE_AI_FORK_REPOSITORY = "https://github.com/Alexma03/gentle-ai.git";
export const GENTLE_AI_FORK_REF = "custom/main";

function commandOptions(extra = {}) {
	return { shell: false, windowsHide: true, maxBuffer: COMMAND_MAX_BUFFER, ...extra };
}

async function sha256File(path) {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

function missing(error) {
	return error && typeof error === "object" && error.code === "ENOENT";
}

function confined(path, parent) {
	const value = relative(parent, path);
	return value !== "" && !value.startsWith("..") && !isAbsolute(value);
}

async function realDirectory(path, label, allowMissing = false) {
	try {
		const details = await lstat(path);
		if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
		return true;
	} catch (error) {
		if (allowMissing && missing(error)) return false;
		throw error;
	}
}

async function prepareRuntimeRoot(packageRoot) {
	const root = resolve(packageRoot);
	await realDirectory(root, "Gentle AI package root");
	const runtimeRoot = join(root, ".gentle-ai");
	if (!confined(runtimeRoot, root)) throw new Error("Gentle AI package-local runtime directory escaped the package root");
	if (!await realDirectory(runtimeRoot, "Gentle AI package-local runtime directory", true)) {
		await mkdir(runtimeRoot, { mode: 0o700 });
		await realDirectory(runtimeRoot, "Gentle AI package-local runtime directory");
	}
	return runtimeRoot;
}

function nativeGoTarget(platform, architecture) {
	const goos = platform === "win32" ? "windows" : platform;
	if (!new Set(["linux", "darwin", "windows"]).has(goos)) throw new Error(`unsupported native Go platform ${platform}`);
	const goarch = architecture === "x64" ? "amd64" : architecture === "arm64" ? "arm64" : undefined;
	if (goarch === undefined) throw new Error(`unsupported native Go architecture ${architecture}`);
	return { goos, goarch };
}

function sealedGoEnvironment(base, buildRoot, platform, architecture) {
	const target = nativeGoTarget(platform, architecture);
	const path = base.PATH ?? base.Path ?? "";
	return {
		PATH: path,
		...(platform === "win32" && typeof base.SystemRoot === "string" ? { SystemRoot: base.SystemRoot } : {}),
		...(platform === "win32" && typeof base.WINDIR === "string" ? { WINDIR: base.WINDIR } : {}),
		GOENV: "off", GOFLAGS: "-modcacherw", GOWORK: "off", GOTOOLCHAIN: "local", GOSUMDB: "sum.golang.org",
		GONOSUMDB: "", GOPRIVATE: "", GONOPROXY: "", GOINSECURE: "", GOPROXY: "https://proxy.golang.org",
		GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: "0",
		GOPATH: join(buildRoot, "gopath"), GOMODCACHE: join(buildRoot, "gomodcache"), GOCACHE: join(buildRoot, "gocache"),
	};
}

async function fileSnapshot(path) {
	try {
		const details = await lstat(path);
		if (!details.isFile() || details.isSymbolicLink()) throw new Error(`registration path must be a regular non-symlink file: ${path}`);
		return { path, exists: true, contents: await readFile(path), mode: details.mode & 0o777 };
	} catch (error) {
		if (missing(error)) return { path, exists: false };
		throw error;
	}
}

async function restoreFileSnapshot(snapshot, renameFile) {
	let currentExists = false;
	try {
		const details = await lstat(snapshot.path);
		if (!details.isFile() || details.isSymbolicLink()) throw new Error(`registration path became unsafe during rollback: ${snapshot.path}`);
		currentExists = true;
	} catch (error) {
		if (!missing(error)) throw error;
	}
	if (!snapshot.exists) {
		if (currentExists) await rm(snapshot.path);
		return;
	}
	await mkdir(dirname(snapshot.path), { recursive: true, mode: 0o700 });
	const staging = `${snapshot.path}.rollback-${process.pid}-${Date.now()}`;
	await writeFile(staging, snapshot.contents, { mode: snapshot.mode });
	try {
		if (currentExists) await rm(snapshot.path);
		await renameFile(staging, snapshot.path);
		await chmod(snapshot.path, snapshot.mode);
	} finally {
		await rm(staging, { force: true });
	}
}

async function removeRealDirectory(path, removeDirectory, label) {
	if (!await realDirectory(path, label, true)) return;
	await removeDirectory(path);
}

async function publishRuntime(input) {
	const {
		runtimeRoot, stagingDirectory, sourceRoot, executable, environment, platform,
		renameFile, removeDirectory, registerPinnedMainBinary, unregisterDevBinary,
	} = input;
	const live = join(runtimeRoot, "custom-main");
	const backup = join(runtimeRoot, `.custom-main-backup-${process.pid}-${Date.now()}`);
	const discarded = join(runtimeRoot, `.custom-main-discarded-${process.pid}-${Date.now()}`);
	for (const path of [live, backup, discarded, stagingDirectory]) {
		if (!confined(path, runtimeRoot)) throw new Error("Gentle AI runtime publication path escaped its runtime root");
	}
	const pinnedBefore = await fileSnapshot(gentleAiPinnedMainRegistrationPath(environment));
	const devBefore = await fileSnapshot(gentleAiDevBinaryRegistrationPath(environment));
	let priorMoved = false;
	let stagedMoved = false;
	try {
		if (await realDirectory(live, "Gentle AI current custom-main runtime", true)) {
			await renameFile(live, backup);
			priorMoved = true;
		}
		await renameFile(stagingDirectory, live);
		stagedMoved = true;
		const binaryPath = join(live, executable);
		const registration = registerPinnedMainBinary(binaryPath, environment, platform);
		unregisterDevBinary(environment);
		await removeRealDirectory(sourceRoot, removeDirectory, "Gentle AI temporary source directory");
		if (priorMoved) await removeRealDirectory(backup, removeDirectory, "Gentle AI previous custom-main runtime backup");
		return { binaryPath, registrationPath: registration.registrationPath };
	} catch (error) {
		const rollbackErrors = [];
		try {
			if (stagedMoved && await realDirectory(live, "Gentle AI failed custom-main runtime", true)) await renameFile(live, discarded);
			if (priorMoved) await renameFile(backup, live);
			else await removeRealDirectory(discarded, removeDirectory, "Gentle AI discarded custom-main runtime");
		} catch (rollbackError) { rollbackErrors.push(rollbackError); }
		for (const snapshot of [pinnedBefore, devBefore]) {
			try { await restoreFileSnapshot(snapshot, renameFile); }
			catch (rollbackError) { rollbackErrors.push(rollbackError); }
		}
		try { await removeRealDirectory(discarded, removeDirectory, "Gentle AI discarded custom-main runtime"); }
		catch (rollbackError) { rollbackErrors.push(rollbackError); }
		if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], "Gentle AI runtime publication failed and rollback was incomplete");
		throw error;
	}
}

export async function installForkGentleAi(options = {}) {
	const execute = options.execFile ?? execFileAsync;
	const packageRoot = options.packageRoot ?? resolveGentleAiInstallerPackageRoot();
	const repository = options.sourceRepository ?? GENTLE_AI_FORK_REPOSITORY;
	const ref = options.sourceRef ?? GENTLE_AI_FORK_REF;
	const platform = options.platform ?? process.platform;
	const architecture = options.architecture ?? process.arch;
	nativeGoTarget(platform, architecture);
	const executable = platform === "win32" ? "gentle-ai.exe" : "gentle-ai";
	const runtimeRoot = await prepareRuntimeRoot(packageRoot);
	const sourceRoot = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), "gentle-pi-gentle-ai-"));
	const sourceDirectory = join(sourceRoot, "source");
	const sourceArchive = join(sourceRoot, "source.tar");
	const stagingDirectory = await mkdtemp(join(runtimeRoot, ".custom-main-staging-"));
	const stagingBinaryPath = join(stagingDirectory, executable);
	const buildCommand = "go build -trimpath ./cmd/gentle-ai";
	const renameFile = options.rename ?? rename;
	const removeDirectory = options.removeDirectory ?? ((path) => rm(path, { recursive: true, force: true }));
	try {
		await execute("git", ["clone", "--depth", "1", "--branch", ref, repository, sourceDirectory], commandOptions({ timeout: GIT_TIMEOUT_MS }));
		const revisionResult = await execute("git", ["rev-parse", "HEAD"], commandOptions({ cwd: sourceDirectory, timeout: GIT_TIMEOUT_MS }));
		const sourceRevision = String(revisionResult.stdout).trim();
		if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error("fork checkout did not resolve to one canonical commit");
		await execute("git", ["archive", "--format=tar", "--output", sourceArchive, "HEAD"], commandOptions({ cwd: sourceDirectory, timeout: GIT_TIMEOUT_MS }));
		const sourceTreeSha256 = await sha256File(sourceArchive);

		await execute(options.goCommand ?? "go", ["build", "-trimpath", "-o", stagingBinaryPath, "./cmd/gentle-ai"], commandOptions({
			cwd: sourceDirectory,
			timeout: GO_TIMEOUT_MS,
			env: sealedGoEnvironment(options.processEnv ?? process.env, sourceRoot, platform, architecture),
		}));
		if (platform !== "win32") await chmod(stagingBinaryPath, 0o700);
		const versionResult = await execute(stagingBinaryPath, ["--version"], commandOptions({ timeout: GIT_TIMEOUT_MS }));
		const versionOutput = String(versionResult.stdout).trim();
		if (!versionOutput.startsWith("gentle-ai ")) throw new Error("built fork did not report a valid gentle-ai version");
		const binarySha256 = await sha256File(stagingBinaryPath);
		await writeFile(join(stagingDirectory, "integrity.json"), `${JSON.stringify({
			schema: GENTLE_AI_LOCAL_MAIN_SNAPSHOT_SCHEMA,
			binarySha256,
			sourceRepository: repository,
			sourceBranch: ref,
			sourceRevision,
			sourceTreeSha256,
			versionOutput,
			buildCommand,
		})}\n`, { mode: 0o600 });
		const publication = await publishRuntime({
			runtimeRoot, stagingDirectory, sourceRoot, executable, environment: options.environment,
			platform, renameFile, removeDirectory,
			registerPinnedMainBinary: options.registerPinnedMainBinary ?? registerGentleAiPinnedMainBinary,
			unregisterDevBinary: options.unregisterDevBinary ?? unregisterGentleAiDevBinary,
		});
		const { binaryPath, registrationPath } = publication;
		return { binaryPath, registrationPath, repository, ref, sourceRevision, sourceTreeSha256, versionOutput };
	} finally {
		await removeRealDirectory(stagingDirectory, removeDirectory, "Gentle AI abandoned staging directory");
		await removeRealDirectory(sourceRoot, removeDirectory, "Gentle AI abandoned temporary source directory");
	}
}

async function main() {
	if (process.env.GENTLE_PI_SKIP_GENTLE_AI_INSTALL === "1") {
		console.warn("GENTLE_PI_SKIP_GENTLE_AI_INSTALL=1: skipped fork Gentle AI installation; native review operations will fail until a binary is registered.");
		return;
	}
	try {
		const result = await installForkGentleAi();
		console.log(`Gentle AI ${result.ref} built from ${result.repository} at ${result.binaryPath}`);
	} catch (error) {
		console.error(`gentle-pi could not build Gentle AI from ${GENTLE_AI_FORK_REPOSITORY}@${GENTLE_AI_FORK_REF}: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) await main();
