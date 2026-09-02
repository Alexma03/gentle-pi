import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
	GENTLE_AI_LOCAL_MAIN_SNAPSHOT_SCHEMA,
	GENTLE_AI_PINNED_MAIN_REGISTRATION_SCHEMA,
	gentleAiDevBinaryRegistrationPath,
	gentleAiPinnedMainRegistrationPath,
	registerGentleAiPinnedMainBinary,
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

test("postinstall rejects a symlinked runtime root without touching its outside target", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-fork-symlink-package-"));
	const outside = await mkdtemp(join(tmpdir(), "gentle-pi-fork-symlink-outside-"));
	const sentinel = join(outside, "custom-main", "sentinel.txt");
	await mkdir(dirname(sentinel), { recursive: true });
	await writeFile(sentinel, "outside must survive");
	await symlink(outside, join(packageRoot, ".gentle-ai"), "dir");

	await assert.rejects(() => installForkGentleAi({
		packageRoot,
		execFile: async () => { throw new Error("commands must not run through a symlinked runtime root"); },
	}), /runtime directory must be a real directory/);
	assert.equal(await readFile(sentinel, "utf8"), "outside must survive");
});

test("fork build seals hostile Go environment variables to the validated native target", async () => {
	const packageRoot = await mkdtemp(join(tmpdir(), "gentle-pi-fork-hostile-env-package-"));
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-fork-hostile-env-home-"));
	let goEnvironment: NodeJS.ProcessEnv | undefined;
	await installForkGentleAi({
		packageRoot,
		environment: { home, env: {} },
		processEnv: {
			PATH: process.env.PATH,
			GOENV: "/hostile/go.env",
			GOFLAGS: "-toolexec=attacker",
			GOWORK: "/hostile/go.work",
			GOTOOLCHAIN: "auto",
			GOSUMDB: "off",
			GOPROXY: "https://attacker.invalid",
			GOPRIVATE: "*",
			GONOSUMDB: "*",
			GONOPROXY: "*",
			GOINSECURE: "*",
			GOOS: "plan9",
			GOARCH: "386",
		},
		execFile: async (file: string, arguments_: string[], options?: { env?: NodeJS.ProcessEnv }) => {
			if (file === "git" && arguments_[0] === "clone") {
				await mkdir(arguments_.at(-1)!, { recursive: true });
				return { stdout: "", stderr: "" };
			}
			if (file === "git" && arguments_[0] === "rev-parse") return { stdout: `${"c".repeat(40)}\n`, stderr: "" };
			if (file === "git" && arguments_[0] === "archive") {
				await writeFile(arguments_[arguments_.indexOf("--output") + 1]!, "fork archive");
				return { stdout: "", stderr: "" };
			}
			if (file === "go") {
				goEnvironment = options?.env;
				const output = arguments_[arguments_.indexOf("-o") + 1]!;
				await mkdir(dirname(output), { recursive: true });
				await writeFile(output, "fork gentle-ai");
				return { stdout: "", stderr: "" };
			}
			if (file.endsWith(process.platform === "win32" ? "gentle-ai.exe" : "gentle-ai")) return { stdout: "gentle-ai 2.0.0-custom\n", stderr: "" };
			throw new Error(`unexpected command: ${file} ${arguments_.join(" ")}`);
		},
	});

	assert.ok(goEnvironment);
	assert.deepEqual({
		GOENV: goEnvironment.GOENV,
		GOFLAGS: goEnvironment.GOFLAGS,
		GOWORK: goEnvironment.GOWORK,
		GOTOOLCHAIN: goEnvironment.GOTOOLCHAIN,
		GOSUMDB: goEnvironment.GOSUMDB,
		GOPROXY: goEnvironment.GOPROXY,
		GOPRIVATE: goEnvironment.GOPRIVATE,
		GONOSUMDB: goEnvironment.GONOSUMDB,
		GONOPROXY: goEnvironment.GONOPROXY,
		GOINSECURE: goEnvironment.GOINSECURE,
		GOOS: goEnvironment.GOOS,
		GOARCH: goEnvironment.GOARCH,
		CGO_ENABLED: goEnvironment.CGO_ENABLED,
	}, {
		GOENV: "off", GOFLAGS: "-modcacherw", GOWORK: "off", GOTOOLCHAIN: "local", GOSUMDB: "sum.golang.org",
		GOPROXY: "https://proxy.golang.org", GOPRIVATE: "", GONOSUMDB: "", GONOPROXY: "", GOINSECURE: "",
		GOOS: process.platform === "win32" ? "windows" : process.platform, GOARCH: process.arch === "x64" ? "amd64" : "arm64", CGO_ENABLED: "0",
	});
});

test("publication failure restores the prior runtime and both registration records", async () => {
	for (const failure of ["rename", "registration", "cleanup"] as const) {
		const packageRoot = await mkdtemp(join(tmpdir(), `gentle-pi-fork-${failure}-package-`));
		const home = await mkdtemp(join(tmpdir(), `gentle-pi-fork-${failure}-home-`));
		const environment = { home, env: {} };
		const live = join(packageRoot, ".gentle-ai", "custom-main");
		await mkdir(live, { recursive: true });
		await writeFile(join(live, "gentle-ai"), "previous runtime");
		await writeFile(join(live, "integrity.json"), "previous integrity");
		const pinnedRegistration = gentleAiPinnedMainRegistrationPath(environment);
		const devRegistration = gentleAiDevBinaryRegistrationPath(environment);
		await mkdir(dirname(pinnedRegistration), { recursive: true });
		await writeFile(pinnedRegistration, "previous pinned registration\n");
		await writeFile(devRegistration, "previous dev registration\n");
		let renameCalls = 0;

		await assert.rejects(() => installForkGentleAi({
			packageRoot,
			environment,
			rename: async (from: string, to: string) => {
				renameCalls += 1;
				if (failure === "rename" && renameCalls === 2) throw new Error("synthetic publication rename failure");
				return await import("node:fs/promises").then((fs) => fs.rename(from, to));
			},
			registerPinnedMainBinary: failure === "registration" ? (path: string, selectedEnvironment: typeof environment, platform: string) => {
				registerGentleAiPinnedMainBinary(path, selectedEnvironment, platform);
				throw new Error("synthetic registration failure after replacement");
			} : undefined,
			removeDirectory: async (path: string) => {
				if (failure === "cleanup" && path.includes(".custom-main-backup-")) throw new Error("synthetic backup cleanup failure");
				return await import("node:fs/promises").then((fs) => fs.rm(path, { recursive: true, force: true }));
			},
			execFile: async (file: string, arguments_: string[]) => {
				if (file === "git" && arguments_[0] === "clone") {
					await mkdir(arguments_.at(-1)!, { recursive: true });
					return { stdout: "", stderr: "" };
				}
				if (file === "git" && arguments_[0] === "rev-parse") return { stdout: `${"d".repeat(40)}\n`, stderr: "" };
				if (file === "git" && arguments_[0] === "archive") {
					await writeFile(arguments_[arguments_.indexOf("--output") + 1]!, "fork archive");
					return { stdout: "", stderr: "" };
				}
				if (file === "go") {
					const output = arguments_[arguments_.indexOf("-o") + 1]!;
					await mkdir(dirname(output), { recursive: true });
					await writeFile(output, "new runtime");
					return { stdout: "", stderr: "" };
				}
				if (file.endsWith(process.platform === "win32" ? "gentle-ai.exe" : "gentle-ai")) return { stdout: "gentle-ai 2.0.0-custom\n", stderr: "" };
				throw new Error(`unexpected command: ${file} ${arguments_.join(" ")}`);
			},
		}), new RegExp(`synthetic .*${failure}`));

		assert.equal(await readFile(join(live, "gentle-ai"), "utf8"), "previous runtime", `${failure}: runtime`);
		assert.equal(await readFile(join(live, "integrity.json"), "utf8"), "previous integrity", `${failure}: integrity`);
		assert.equal(await readFile(pinnedRegistration, "utf8"), "previous pinned registration\n", `${failure}: pinned registration`);
		assert.equal(await readFile(devRegistration, "utf8"), "previous dev registration\n", `${failure}: dev registration`);
	}
});
