import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA } from "../lib/gentle-ai-binary.ts";
import { GENTLE_AI_FORK_REF, GENTLE_AI_FORK_REPOSITORY, installForkGentleAi } from "../scripts/install-gentle-ai.mjs";

test("postinstall clones the Alexma03 fork and registers the built binary", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-fork-package-"));
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-fork-home-"));
	const calls: { file: string; arguments_: string[] }[] = [];
	const result = await installForkGentleAi({
		packageRoot,
		platform: "win32",
		environment: { home, env: {} },
		execFile: async (file: string, arguments_: string[]) => {
			calls.push({ file, arguments_ });
			if (file === "git" && arguments_[0] === "clone") {
				await mkdir(arguments_.at(-1)!, { recursive: true });
				return { stdout: "", stderr: "" };
			}
			if (file === "go" && arguments_[0] === "build") {
				const output = arguments_[arguments_.indexOf("-o") + 1];
				await mkdir(dirname(output), { recursive: true });
				await writeFile(output, "fork gentle-ai");
				return { stdout: "", stderr: "" };
			}
			throw new Error(`unexpected command: ${file} ${arguments_.join(" ")}`);
		},
	});

	assert.equal(result.repository, GENTLE_AI_FORK_REPOSITORY);
	assert.equal(result.ref, GENTLE_AI_FORK_REF);
	assert.deepEqual(calls[0], {
		file: "git",
		arguments_: ["clone", "--depth", "1", "--branch", "custom/main", "https://github.com/Alexma03/gentle-ai.git", join(packageRoot, ".gentle-ai", "fork-src")],
	});
	assert.equal(calls[1]?.file, "go");
	assert.deepEqual(calls[1]?.arguments_.slice(0, 3), ["build", "-trimpath", "-o"]);
	const registration = JSON.parse(await readFile(result.registrationPath, "utf8"));
	assert.equal(registration.schema, GENTLE_AI_DEV_BINARY_REGISTRATION_SCHEMA);
	assert.equal(registration.path, result.binaryPath);
	assert.equal(await readFile(result.binaryPath, "utf8"), "fork gentle-ai");
});
