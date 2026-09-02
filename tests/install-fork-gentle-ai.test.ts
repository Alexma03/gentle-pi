import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	GENTLE_AI_LOCAL_MAIN_SNAPSHOT_SCHEMA,
	GENTLE_AI_PINNED_MAIN_REGISTRATION_SCHEMA,
} from "../lib/gentle-ai-binary.ts";
import { GENTLE_AI_FORK_REF, GENTLE_AI_FORK_REPOSITORY, installForkGentleAi } from "../scripts/install-gentle-ai.mjs";

test("postinstall snapshots Alexma03 custom/main without retaining its source checkout", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-fork-package-"));
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-fork-home-"));
	const legacyDevRegistration = join(home, ".pi", "gentle-ai", "dev-binary.json");
	await mkdir(dirname(legacyDevRegistration), { recursive: true });
	await writeFile(legacyDevRegistration, '{"schema":"gentle-pi.dev-binary/v1","path":"/stale"}\n');
	const calls: { file: string; arguments_: string[] }[] = [];
	let sourceDirectory = "";
	const result = await installForkGentleAi({
		packageRoot,
		platform: "win32",
		environment: { home, env: {} },
		execFile: async (file: string, arguments_: string[]) => {
			calls.push({ file, arguments_ });
			if (file === "git" && arguments_[0] === "clone") {
				sourceDirectory = arguments_.at(-1)!;
				await mkdir(sourceDirectory, { recursive: true });
				return { stdout: "", stderr: "" };
			}
			if (file === "git" && arguments_[0] === "rev-parse") {
				return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
			}
			if (file === "git" && arguments_[0] === "archive") {
				await writeFile(arguments_[arguments_.indexOf("--output") + 1]!, "fork archive");
				return { stdout: "", stderr: "" };
			}
			if (file === "go" && arguments_[0] === "build") {
				const output = arguments_[arguments_.indexOf("-o") + 1];
				await mkdir(dirname(output), { recursive: true });
				await writeFile(output, "fork gentle-ai");
				return { stdout: "", stderr: "" };
			}
			if (file.endsWith("gentle-ai.exe") && arguments_[0] === "--version") {
				return { stdout: "gentle-ai 2.0.0-custom\n", stderr: "" };
			}
			throw new Error(`unexpected command: ${file} ${arguments_.join(" ")}`);
		},
	});

	assert.equal(result.repository, GENTLE_AI_FORK_REPOSITORY);
	assert.equal(result.ref, GENTLE_AI_FORK_REF);
	assert.deepEqual(calls[0]?.arguments_.slice(0, -1), ["clone", "--depth", "1", "--branch", "custom/main", "https://github.com/Alexma03/gentle-ai.git"]);
	assert.notEqual(sourceDirectory, join(packageRoot, ".gentle-ai", "fork-src"));
	await assert.rejects(access(sourceDirectory), /ENOENT/);
	assert.equal(result.binaryPath, join(packageRoot, ".gentle-ai", "custom-main", "gentle-ai.exe"));
	const registration = JSON.parse(await readFile(result.registrationPath, "utf8"));
	assert.equal(registration.schema, GENTLE_AI_PINNED_MAIN_REGISTRATION_SCHEMA);
	assert.equal(registration.path, result.binaryPath);
	assert.equal(registration.sourceRepository, GENTLE_AI_FORK_REPOSITORY);
	assert.equal(registration.sourceBranch, GENTLE_AI_FORK_REF);
	assert.equal(registration.sourceRevision, "a".repeat(40));
	assert.equal(registration.sourceTreeSha256, createHash("sha256").update("fork archive").digest("hex"));
	assert.equal(registration.versionOutput, "gentle-ai 2.0.0-custom");
	const integrity = JSON.parse(await readFile(join(dirname(result.binaryPath), "integrity.json"), "utf8"));
	assert.equal(integrity.schema, GENTLE_AI_LOCAL_MAIN_SNAPSHOT_SCHEMA);
	assert.equal(integrity.binarySha256, createHash("sha256").update("fork gentle-ai").digest("hex"));
	assert.equal(await readFile(result.binaryPath, "utf8"), "fork gentle-ai");
	await assert.rejects(access(legacyDevRegistration), /ENOENT/);
});

test("a failed fork build removes temporary source and preserves the previous runtime", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-fork-failure-package-"));
	const temporaryRoot = await mkdtemp(join(tmpdir(), "gentle-pi-fork-failure-temp-"));
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-fork-failure-home-"));
	const previousBinary = join(packageRoot, ".gentle-ai", "custom-main", "gentle-ai");
	await mkdir(dirname(previousBinary), { recursive: true });
	await writeFile(previousBinary, "previous verified runtime");
	let sourceDirectory = "";

	await assert.rejects(() => installForkGentleAi({
		packageRoot,
		temporaryRoot,
		environment: { home, env: {} },
		execFile: async (file: string, arguments_: string[]) => {
			if (file === "git" && arguments_[0] === "clone") {
				sourceDirectory = arguments_.at(-1)!;
				await mkdir(sourceDirectory, { recursive: true });
				return { stdout: "", stderr: "" };
			}
			if (file === "git" && arguments_[0] === "rev-parse") return { stdout: `${"b".repeat(40)}\n`, stderr: "" };
			if (file === "git" && arguments_[0] === "archive") {
				await writeFile(arguments_[arguments_.indexOf("--output") + 1]!, "fork archive");
				return { stdout: "", stderr: "" };
			}
			if (file === "go") throw new Error("synthetic Go build failure");
			throw new Error(`unexpected command: ${file} ${arguments_.join(" ")}`);
		},
	}), /synthetic Go build failure/);

	await assert.rejects(access(sourceDirectory), /ENOENT/);
	assert.equal(await readFile(previousBinary, "utf8"), "previous verified runtime");
});
