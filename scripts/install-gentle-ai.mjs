#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
	GENTLE_AI_LOCAL_MAIN_SNAPSHOT_SCHEMA,
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

export async function installForkGentleAi(options = {}) {
	const execute = options.execFile ?? execFileAsync;
	const packageRoot = options.packageRoot ?? resolveGentleAiInstallerPackageRoot();
	const repository = options.sourceRepository ?? GENTLE_AI_FORK_REPOSITORY;
	const ref = options.sourceRef ?? GENTLE_AI_FORK_REF;
	const platform = options.platform ?? process.platform;
	const executable = platform === "win32" ? "gentle-ai.exe" : "gentle-ai";
	const runtimeRoot = join(packageRoot, ".gentle-ai");
	const sourceRoot = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), "gentle-pi-gentle-ai-"));
	const sourceDirectory = join(sourceRoot, "source");
	const sourceArchive = join(sourceRoot, "source.tar");
	const binaryDirectory = join(runtimeRoot, "custom-main");
	const stagingDirectory = join(runtimeRoot, `.custom-main-staging-${process.pid}-${Date.now()}`);
	const binaryPath = join(binaryDirectory, executable);
	const stagingBinaryPath = join(stagingDirectory, executable);
	const buildCommand = "go build -trimpath ./cmd/gentle-ai";
	await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
	try {
		await execute("git", ["clone", "--depth", "1", "--branch", ref, repository, sourceDirectory], commandOptions({ timeout: GIT_TIMEOUT_MS }));
		const revisionResult = await execute("git", ["rev-parse", "HEAD"], commandOptions({ cwd: sourceDirectory, timeout: GIT_TIMEOUT_MS }));
		const sourceRevision = String(revisionResult.stdout).trim();
		if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error("fork checkout did not resolve to one canonical commit");
		await execute("git", ["archive", "--format=tar", "--output", sourceArchive, "HEAD"], commandOptions({ cwd: sourceDirectory, timeout: GIT_TIMEOUT_MS }));
		const sourceTreeSha256 = await sha256File(sourceArchive);

		await rm(stagingDirectory, { recursive: true, force: true });
		await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
		await execute(options.goCommand ?? "go", ["build", "-trimpath", "-o", stagingBinaryPath, "./cmd/gentle-ai"], commandOptions({
			cwd: sourceDirectory,
			timeout: GO_TIMEOUT_MS,
			env: { ...process.env, CGO_ENABLED: "0", GOTOOLCHAIN: "local" },
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
		await rm(binaryDirectory, { recursive: true, force: true });
		await rename(stagingDirectory, binaryDirectory);
		const registration = registerGentleAiPinnedMainBinary(binaryPath, options.environment, platform);
		unregisterGentleAiDevBinary(options.environment);
		return { binaryPath, registrationPath: registration.registrationPath, repository, ref, sourceRevision, sourceTreeSha256, versionOutput };
	} finally {
		await rm(stagingDirectory, { recursive: true, force: true });
		await rm(sourceRoot, { recursive: true, force: true });
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
