#!/usr/bin/env node
import { execFile } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { registerGentleAiDevBinary } from "../runtime/gentle-ai-binary.mjs";
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

export async function installForkGentleAi(options = {}) {
	const execute = options.execFile ?? execFileAsync;
	const packageRoot = options.packageRoot ?? resolveGentleAiInstallerPackageRoot();
	const repository = options.sourceRepository ?? GENTLE_AI_FORK_REPOSITORY;
	const ref = options.sourceRef ?? GENTLE_AI_FORK_REF;
	const platform = options.platform ?? process.platform;
	const executable = platform === "win32" ? "gentle-ai.exe" : "gentle-ai";
	const runtimeRoot = join(packageRoot, ".gentle-ai");
	const sourceDirectory = join(runtimeRoot, "fork-src");
	const binaryDirectory = join(runtimeRoot, "fork");
	const binaryPath = join(binaryDirectory, executable);
	await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
	await rm(sourceDirectory, { recursive: true, force: true });
	await execute("git", ["clone", "--depth", "1", "--branch", ref, repository, sourceDirectory], commandOptions({ timeout: GIT_TIMEOUT_MS }));
	await mkdir(binaryDirectory, { recursive: true, mode: 0o700 });
	await execute(options.goCommand ?? "go", ["build", "-trimpath", "-o", binaryPath, "./cmd/gentle-ai"], commandOptions({
		cwd: sourceDirectory,
		timeout: GO_TIMEOUT_MS,
		env: { ...process.env, CGO_ENABLED: "0", GOTOOLCHAIN: "local" },
	}));
	if (platform !== "win32") await chmod(binaryPath, 0o700);
	const registration = registerGentleAiDevBinary(binaryPath, options.environment, platform);
	return { binaryPath, registrationPath: registration.registrationPath, repository, ref };
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
