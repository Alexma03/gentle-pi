#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "gentle-pi-packed-runner-"));
const packDirectory = join(temporary, "pack");
const installDirectory = join(temporary, "install");
const isolatedConfigHome = join(temporary, "config");
const ambientConfigHome = process.env.GENTLE_PI_CONFIG_HOME ?? join(homedir(), ".pi", "gentle-ai");
const ambientRegistrationPaths = [join(ambientConfigHome, "dev-binary.json"), join(ambientConfigHome, "pinned-main-binary.json")];
const ambientRegistrationSnapshot = ambientRegistrationPaths.map((path) => existsSync(path) ? readFileSync(path) : undefined);

function assertAmbientRegistrationsUnchanged() {
	for (const [index, path] of ambientRegistrationPaths.entries()) {
		const before = ambientRegistrationSnapshot[index];
		const after = existsSync(path) ? readFileSync(path) : undefined;
		if (before?.equals(after) ?? after === undefined) continue;
		throw new Error(`packed package E2E modified ambient Gentle Pi registration: ${path}`);
	}
}

function windowsNpmInvocation() {
	const candidates = [];
	if (process.env.npm_execpath !== undefined && /[\\/]npm[\\/]bin[\\/]npm-cli\.js$/i.test(process.env.npm_execpath)) candidates.push(process.env.npm_execpath);
	for (const executable of new Set([process.execPath, realpathSync(process.execPath)])) candidates.push(join(dirname(executable), "node_modules", "npm", "bin", "npm-cli.js"));
	const installedCli = candidates.find((path) => existsSync(path));
	if (installedCli !== undefined) return { file: process.execPath, prefix: [installedCli] };
	let commandPaths = [];
	try { commandPaths = execFileSync("where.exe", ["npm"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).filter(Boolean); }
	catch { /* fall through to the explicit resolution error */ }
	for (const path of commandPaths) {
		if (basename(path).toLowerCase() === "npm.exe") return { file: path, prefix: [] };
		const cli = join(dirname(path), "node_modules", "npm", "bin", "npm-cli.js");
		if (existsSync(cli)) return { file: process.execPath, prefix: [cli] };
	}
	throw new Error("could not resolve npm-cli.js without a command shell");
}

function runNpm(arguments_, options) {
	const invocation = process.platform === "win32" ? windowsNpmInvocation() : { file: "npm", prefix: [] };
	return execFileSync(invocation.file, [...invocation.prefix, ...arguments_], options);
}

try {
	mkdirSync(packDirectory);
	mkdirSync(installDirectory);
	const packed = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
}));
	if (packed.length !== 1 || typeof packed[0]?.filename !== "string") throw new Error("npm pack did not return one tarball");
	const tarball = join(packDirectory, packed[0].filename);
	writeFileSync(join(installDirectory, "package.json"), JSON.stringify({ name: "gentle-pi-packed-runner-test", private: true }), "utf8");
	runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--omit=dev", "--legacy-peer-deps", tarball], {
		cwd: installDirectory,
		stdio: "inherit",
		env: { ...process.env, GENTLE_PI_CONFIG_HOME: isolatedConfigHome },
	});
	const packageRoot = join(installDirectory, "node_modules", "gentle-pi");
	const executable = process.env.GENTLE_PI_PACKED_GENTLE_AI_BINARY ?? join(root, ".gentle-ai", "custom-main", process.platform === "win32" ? "gentle-ai.exe" : "gentle-ai");
	if (!existsSync(executable)) throw new Error("packed package E2E requires one previously built custom/main Gentle AI binary");
	const integrity = JSON.parse(readFileSync(join(dirname(executable), "integrity.json"), "utf8"));
	if (integrity.sourceRepository !== "https://github.com/Alexma03/gentle-ai.git" || integrity.sourceBranch !== "custom/main") {
		throw new Error("packed package E2E binary is not the expected Alexma03/custom-main snapshot");
	}
	if (existsSync(join(root, ".gentle-ai", "fork-src"))) throw new Error("Gentle AI installer retained its temporary source checkout");
	const capabilities = JSON.parse(execFileSync(executable, ["review", "capabilities", "--contract", "gentle-ai.review-integration/v2"], { cwd: installDirectory, encoding: "utf8" }));
	// Decode with the PACKED consumer's own decoder rather than comparing the
	// schema string against a list hand-copied into this script. The copy was a
	// second, silent pin: it accepted only `capabilities/v2`, so the moment the
	// pinned provider advertised an additive minor this E2E rejected a pairing
	// that gentle-pi reads correctly, and it would have done so again on the
	// next minor. Using the shipped decoder makes the assertion what it always
	// meant to be — the packed consumer can read the packed provider — and it
	// checks the whole envelope (protocol major/minor, required operations,
	// gates, projections, advertised schemas, mandatory features, and the
	// self-reported executable digest) instead of one string.
	const { decodeReviewCapabilitiesV2 } = await import(pathToFileURL(join(packageRoot, "runtime", "review-integration-v2.mjs")).href);
	const executableDigest = `sha256:${createHash("sha256").update(readFileSync(executable)).digest("hex")}`;
	const decoded = decodeReviewCapabilitiesV2(capabilities, executableDigest);
	if (decoded.contract !== "gentle-ai.review-integration/v2") throw new Error("package-local Gentle AI returned incompatible capabilities");
	const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	process.stdout.write(`packed package E2E passed (gentle-pi ${packageManifest.version ?? "unknown"}; Gentle AI ${decoded.packageVersion ?? "unknown"})\n`);
} finally {
	try {
		assertAmbientRegistrationsUnchanged();
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}
