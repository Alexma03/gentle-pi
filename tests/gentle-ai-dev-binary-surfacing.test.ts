import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import {
	GENTLE_AI_DEV_BINARY_ENV,
	GENTLE_AI_LOCAL_MAIN_SNAPSHOT_SCHEMA,
	gentleAiDevBinaryRegistrationPath,
	gentleAiPinnedMainRegistrationPath,
	registerGentleAiDevBinary,
	registerGentleAiPinnedMainBinary,
	setGentleAiDevBinaryEnvironmentForTesting,
} from "../lib/gentle-ai-binary.ts";

// Loud surfacing for the dev-binary override: while an override is active,
// every diagnostic surface must say so, name the exact binary, its live
// version, and its content digest — the maintainer must never wonder which
// gentle-ai actually answered.

interface CommandRegistration {
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

function harness(): { pi: ExtensionAPI; commands: Map<string, CommandRegistration> } {
	const commands = new Map<string, CommandRegistration>();
	const pi = {
		on() {},
		registerCommand(name: string, registration: CommandRegistration) {
			commands.set(name, registration);
		},
		registerTool() {},
	} as unknown as ExtensionAPI;
	return { pi, commands };
}

function contextFor(cwd: string, notifications: Array<{ message: string; severity: string }>): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		ui: {
			notify(message: string, severity: string) {
				notifications.push({ message, severity });
			},
		},
	} as unknown as ExtensionContext;
}

function writeFixtureBinary(directory: string, versionOutput: string): string {
	const binary = join(directory, process.platform === "win32" ? "gentle-ai.exe" : "gentle-ai");
	if (process.platform === "win32") {
		// Windows does not launch extensionless shebang files with shell:false.
		// A copied Node executable is a real PE binary; its `version` argument
		// resolves to this adjacent extensionless CommonJS probe from the binary
		// directory used by the production version check.
		copyFileSync(process.execPath, binary);
		writeFileSync(join(directory, "version"), `process.stdout.write(${JSON.stringify(`${versionOutput}\n`)});\n`);
	} else {
		writeFileSync(binary, `#!/bin/sh\necho '${versionOutput}'\n`);
		chmodSync(binary, 0o755);
	}
	return binary;
}

async function withDevOverride<T>(callback: (state: { devBinary: string; sha256: string; home: string }) => Promise<T>): Promise<T> {
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-home-"));
	const bin = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-bin-"));
	const devBinary = writeFixtureBinary(bin, "gentle-ai 9.9.9-dev+surface");
	const sha256 = createHash("sha256").update(readFileSync(devBinary)).digest("hex");
	setGentleAiDevBinaryEnvironmentForTesting({ env: { [GENTLE_AI_DEV_BINARY_ENV]: devBinary }, home });
	try {
		return await callback({ devBinary, sha256, home });
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}
}

async function withPinnedMain<T>(callback: (state: { binary: string; sha256: string; home: string; sourceBranch: string; sourceRevision: string }) => Promise<T>): Promise<T> {
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-pinned-surface-home-"));
	const snapshot = await mkdtemp(join(tmpdir(), "gentle-pi-pinned-surface-bin-"));
	const binary = writeFixtureBinary(snapshot, "gentle-ai main@abcdef123456+local");
	const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
	writeFileSync(join(snapshot, "integrity.json"), `${JSON.stringify({
		schema: GENTLE_AI_LOCAL_MAIN_SNAPSHOT_SCHEMA,
		sourceRepository: "https://github.com/Gentleman-Programming/gentle-ai",
		sourceBranch: "main",
		sourceRevision: "a".repeat(40),
		sourceTreeSha256: "b".repeat(64),
		binarySha256: sha256,
		versionOutput: "gentle-ai main@abcdef123456+local",
		buildCommand: "go build -trimpath ./cmd/gentle-ai",
	})}\n`);
	const environment = { env: {}, home };
	registerGentleAiPinnedMainBinary(binary, environment, process.platform);
	setGentleAiDevBinaryEnvironmentForTesting(environment);
	try {
		return await callback({ binary, sha256, home, sourceBranch: "main", sourceRevision: "a".repeat(40) });
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}
}

async function withPinnedCustomMain<T>(callback: (state: { binary: string; sha256: string; home: string; sourceBranch: string; sourceRevision: string }) => Promise<T>): Promise<T> {
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-custom-surface-home-"));
	const snapshot = await mkdtemp(join(tmpdir(), "gentle-pi-custom-surface-bin-"));
	const binary = writeFixtureBinary(snapshot, "gentle-ai custom/main@cafe1234+local");
	const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
	writeFileSync(join(snapshot, "integrity.json"), `${JSON.stringify({
		schema: GENTLE_AI_LOCAL_MAIN_SNAPSHOT_SCHEMA,
		sourceRepository: "https://github.com/Gentleman-Programming/gentle-ai",
		sourceBranch: "custom/main",
		sourceRevision: "c".repeat(40),
		sourceTreeSha256: "d".repeat(64),
		binarySha256: sha256,
		versionOutput: "gentle-ai custom/main@cafe1234+local",
		buildCommand: "go build -trimpath ./cmd/gentle-ai",
	})}\n`);
	const environment = { env: {}, home };
	registerGentleAiPinnedMainBinary(binary, environment, process.platform);
	setGentleAiDevBinaryEnvironmentForTesting(environment);
	try {
		return await callback({ binary, sha256, home, sourceBranch: "custom/main", sourceRevision: "c".repeat(40) });
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}
}

test("gentle:doctor and gentle:status surface the active dev-binary override loudly", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-dev-agent-home-"));
	try {
		await withDevOverride(async ({ devBinary, sha256 }) => {
			const { pi, commands } = harness();
			createGentleAiExtension({ nativeReviewCli: null })(pi);
			const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
			const expected = `Gentle AI dev binary override active (unpinned, field-test only): ${devBinary} 9.9.9-dev+surface sha256:${sha256.slice(0, 16)}`;
			for (const command of ["gentle:doctor", "gentle:status"]) {
				const notifications: Array<{ message: string; severity: string }> = [];
				await commands.get(command)!.handler("", contextFor(cwd, notifications));
				assert.equal(notifications.length, 1, command);
				assert.ok(notifications[0]!.message.includes(expected), `${command}: ${notifications[0]!.message}`);
			}
		});
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	}
});

test("without an override the surfaces stay silent about dev binaries", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-dev-agent-home-"));
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-home-"));
	setGentleAiDevBinaryEnvironmentForTesting({ env: {}, home });
	try {
		const { pi, commands } = harness();
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
		for (const command of ["gentle:doctor", "gentle:status"]) {
			const notifications: Array<{ message: string; severity: string }> = [];
			await commands.get(command)!.handler("", contextFor(cwd, notifications));
			assert.equal(notifications.length, 1, command);
			assert.doesNotMatch(notifications[0]!.message, /dev binary/i, command);
		}
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	}
});

test("an invalid override is surfaced as a failure, never silently ignored", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-dev-agent-home-"));
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-home-"));
	setGentleAiDevBinaryEnvironmentForTesting({ env: { [GENTLE_AI_DEV_BINARY_ENV]: "/nonexistent/gentle-ai" }, home });
	try {
		const { pi, commands } = harness();
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
		const notifications: Array<{ message: string; severity: string }> = [];
		await commands.get("gentle:doctor")!.handler("", contextFor(cwd, notifications));
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.message, /fail: Gentle AI dev binary override/);
		assert.match(notifications[0]!.message, new RegExp(GENTLE_AI_DEV_BINARY_ENV));
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	}
});

test("gentle:dev-binary registers, reports, and clears the persistent override", async () => {
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-home-"));
	const bin = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-bin-"));
	const devBinary = writeFixtureBinary(bin, "gentle-ai 9.9.9-dev+register");
	setGentleAiDevBinaryEnvironmentForTesting({ env: {}, home });
	try {
		const { pi, commands } = harness();
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
		const command = commands.get("gentle:dev-binary");
		assert.ok(command, "gentle:dev-binary command is registered");
		const registrationPath = gentleAiDevBinaryRegistrationPath({ env: {}, home });

		let notifications: Array<{ message: string; severity: string }> = [];
		await command!.handler("status", contextFor(cwd, notifications));
		assert.match(notifications[0]!.message, /no dev binary override/i);

		notifications = [];
		await command!.handler(devBinary, contextFor(cwd, notifications));
		assert.equal(existsSync(registrationPath), true);
		assert.match(notifications[0]!.message, /dev binary override active \(unpinned, field-test only\)/);
		assert.ok(notifications[0]!.message.includes(devBinary));

		notifications = [];
		await command!.handler("relative/gentle-ai", contextFor(cwd, notifications));
		assert.equal(notifications[0]!.severity, "error");

		notifications = [];
		await command!.handler("off", contextFor(cwd, notifications));
		assert.equal(existsSync(registrationPath), false);
		assert.match(notifications[0]!.message, /removed|cleared/i);
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}
});

test("pinned main status is digest-bound and surfaced without a field-test warning", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-pinned-agent-home-"));
	try {
		await withPinnedMain(async ({ binary, sha256 }) => {
			const { pi, commands } = harness();
			createGentleAiExtension({ nativeReviewCli: null })(pi);
			const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-pinned-cwd-"));
			const expected = `Gentle AI pinned main snapshot active: ${binary} main@${"a".repeat(12)} sha256:${sha256.slice(0, 16)}`;
			for (const command of ["gentle:doctor", "gentle:status"]) {
				const notifications: Array<{ message: string; severity: string }> = [];
				await commands.get(command)!.handler("", contextFor(cwd, notifications));
				assert.ok(notifications[0]!.message.includes(expected), `${command}: ${notifications[0]!.message}`);
				assert.doesNotMatch(notifications[0]!.message, /unpinned|field-test only/);
			}
		});
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	}
});

test("gentle:pinned-main registers, reports, and clears a digest-bound snapshot", async () => {
	await withPinnedMain(async ({ binary, home }) => {
		const registrationPath = gentleAiPinnedMainRegistrationPath({ env: {}, home });
		const { pi, commands } = harness();
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		const command = commands.get("gentle:pinned-main");
		assert.ok(command, "gentle:pinned-main command is registered");
		const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-pinned-cwd-"));
		let notifications: Array<{ message: string; severity: string }> = [];
		await command!.handler("status", contextFor(cwd, notifications));
		assert.match(notifications[0]!.message, /pinned main snapshot active/i);

		notifications = [];
		await command!.handler("off", contextFor(cwd, notifications));
		assert.equal(existsSync(registrationPath), false);
		assert.match(notifications[0]!.message, /removed/i);

		notifications = [];
		await command!.handler(binary, contextFor(cwd, notifications));
		assert.equal(existsSync(registrationPath), true);
		assert.equal(notifications[0]!.severity, "info");
		assert.doesNotMatch(notifications[0]!.message, /unpinned|field-test only/);
	});
});

test("registering one persistent channel clears the other via its command", async () => {
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-channel-home-"));
	const bin = await mkdtemp(join(tmpdir(), "gentle-pi-channel-bin-"));
	const devBinary = writeFixtureBinary(bin, "gentle-ai 9.9.9-dev+channel");
	const snapshotDir = await mkdtemp(join(tmpdir(), "gentle-pi-channel-snap-"));
	const snapshot = writeFixtureBinary(snapshotDir, "gentle-ai main@abcdef123456+channel");
	const sha256 = createHash("sha256").update(readFileSync(snapshot)).digest("hex");
	writeFileSync(join(snapshotDir, "integrity.json"), `${JSON.stringify({
		schema: GENTLE_AI_LOCAL_MAIN_SNAPSHOT_SCHEMA,
		sourceRepository: "https://github.com/Gentleman-Programming/gentle-ai",
		sourceBranch: "main",
		sourceRevision: "a".repeat(40),
		sourceTreeSha256: "b".repeat(64),
		binarySha256: sha256,
		versionOutput: "gentle-ai main@abcdef123456+channel",
		buildCommand: "go build -trimpath ./cmd/gentle-ai",
	})}\n`);
	const env = { env: {}, home };
	setGentleAiDevBinaryEnvironmentForTesting(env);
	try {
		const { pi, commands } = harness();
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-channel-cwd-"));
		const devRegistration = gentleAiDevBinaryRegistrationPath(env);
		const pinnedRegistration = gentleAiPinnedMainRegistrationPath(env);

		// Seed both channels.
		registerGentleAiDevBinary(devBinary, env, process.platform);
		registerGentleAiPinnedMainBinary(snapshot, env, process.platform);
		assert.equal(existsSync(devRegistration), true);
		assert.equal(existsSync(pinnedRegistration), true);

		// /gentle:pinned-main <path> removes the legacy dev registration.
		await commands.get("gentle:pinned-main")!.handler(snapshot, contextFor(cwd, []));
		assert.equal(existsSync(pinnedRegistration), true);
		assert.equal(existsSync(devRegistration), false, "pinned-main registration must clear the legacy dev channel");

		// Seed both again, then /gentle:dev-binary <path> removes the pinned registration.
		registerGentleAiDevBinary(devBinary, env, process.platform);
		registerGentleAiPinnedMainBinary(snapshot, env, process.platform);
		assert.equal(existsSync(devRegistration), true);
		assert.equal(existsSync(pinnedRegistration), true);
		await commands.get("gentle:dev-binary")!.handler(devBinary, contextFor(cwd, []));
		assert.equal(existsSync(devRegistration), true);
		assert.equal(existsSync(pinnedRegistration), false, "dev-binary registration must clear the pinned channel");
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}
});

test("a corrupted pinned registration fails closed instead of falling back to legacy or signed", async () => {
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-corrupt-home-"));
	const bin = await mkdtemp(join(tmpdir(), "gentle-pi-corrupt-bin-"));
	const devBinary = writeFixtureBinary(bin, "gentle-ai 9.9.9-dev+fallback");
	const snapshotDir = await mkdtemp(join(tmpdir(), "gentle-pi-corrupt-snap-"));
	const snapshot = writeFixtureBinary(snapshotDir, "gentle-ai main@abcdef123456+corrupt");
	const sha256 = createHash("sha256").update(readFileSync(snapshot)).digest("hex");
	writeFileSync(join(snapshotDir, "integrity.json"), `${JSON.stringify({
		schema: GENTLE_AI_LOCAL_MAIN_SNAPSHOT_SCHEMA,
		sourceRepository: "https://github.com/Gentleman-Programming/gentle-ai",
		sourceBranch: "main",
		sourceRevision: "a".repeat(40),
		sourceTreeSha256: "b".repeat(64),
		binarySha256: sha256,
		versionOutput: "gentle-ai main@abcdef123456+corrupt",
		buildCommand: "go build -trimpath ./cmd/gentle-ai",
	})}\n`);
	const env = { env: {}, home };
	registerGentleAiDevBinary(devBinary, env, process.platform);
	registerGentleAiPinnedMainBinary(snapshot, env, process.platform);
	setGentleAiDevBinaryEnvironmentForTesting(env);
	try {
		// Corrupt the pinned registration document (drift in the stored revision).
		const pinnedRegistration = gentleAiPinnedMainRegistrationPath(env);
		const record = JSON.parse(readFileSync(pinnedRegistration, "utf8"));
		record.sourceRevision = "0".repeat(40);
		writeFileSync(pinnedRegistration, `${JSON.stringify(record)}\n`);
		const { pi, commands } = harness();
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-corrupt-cwd-"));
		const notifications: Array<{ message: string; severity: string }> = [];
		await commands.get("gentle:doctor")!.handler("", contextFor(cwd, notifications));
		assert.equal(notifications.length, 1, JSON.stringify(notifications));
		assert.match(notifications[0]!.message, /fail: Gentle AI pinned main snapshot invalid/);
		assert.match(notifications[0]!.message, /pinned-main-binary-invalid/);
		assert.doesNotMatch(notifications[0]!.message, /dev binary override active/);
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}
});

test("session start announces the active pinned main snapshot as informational", async () => {
	await withPinnedMain(async ({ binary, sha256 }) => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
		const pi = {
			on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) { handlers.set(name, handler); },
			registerCommand() {},
			registerTool() {},
		} as unknown as ExtensionAPI;
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		const notifications: Array<{ message: string; severity: string }> = [];
		await handlers.get("session_start")!({}, contextFor(await mkdtemp(join(tmpdir(), "gentle-pi-pinned-cwd-")), notifications));
		const expected = `Gentle AI pinned main snapshot active: ${binary} main@${"a".repeat(12)} sha256:${sha256.slice(0, 16)}`;
		const announcement = notifications.find((entry) => entry.message.includes(expected));
		assert.ok(announcement, JSON.stringify(notifications));
		assert.equal(announcement!.severity, "info");
	});
});

test("custom/main status surfaces <sourceBranch>@<revision-prefix> without a field-test warning", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-custom-agent-home-"));
	try {
		await withPinnedCustomMain(async ({ binary, sha256, sourceBranch, sourceRevision }) => {
			const { pi, commands } = harness();
			createGentleAiExtension({ nativeReviewCli: null })(pi);
			const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-custom-cwd-"));
			const expected = `Gentle AI pinned main snapshot active: ${binary} ${sourceBranch}@${sourceRevision.slice(0, 12)} sha256:${sha256.slice(0, 16)}`;
			for (const command of ["gentle:doctor", "gentle:status"]) {
				const notifications: Array<{ message: string; severity: string }> = [];
				await commands.get(command)!.handler("", contextFor(cwd, notifications));
				assert.ok(notifications[0]!.message.includes(expected), `${command}: ${notifications[0]!.message}`);
				assert.doesNotMatch(notifications[0]!.message, /unpinned|field-test only/);
			}
		});
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	}
});

test("session start announces a custom/main snapshot with its exact branch and revision prefix", async () => {
	await withPinnedCustomMain(async ({ binary, sha256, sourceBranch, sourceRevision }) => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
		const pi = {
			on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) { handlers.set(name, handler); },
			registerCommand() {},
			registerTool() {},
		} as unknown as ExtensionAPI;
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		const notifications: Array<{ message: string; severity: string }> = [];
		await handlers.get("session_start")!({}, contextFor(await mkdtemp(join(tmpdir(), "gentle-pi-custom-cwd-")), notifications));
		const expected = `Gentle AI pinned main snapshot active: ${binary} ${sourceBranch}@${sourceRevision.slice(0, 12)} sha256:${sha256.slice(0, 16)}`;
		const announcement = notifications.find((entry) => entry.message.includes(expected));
		assert.ok(announcement, JSON.stringify(notifications));
		assert.equal(announcement!.severity, "info");
	});
});

test("session start announces the active override once, loudly", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-dev-agent-home-"));
	try {
		await withDevOverride(async ({ devBinary, sha256 }) => {
			const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
			const pi = {
				on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) {
					handlers.set(name, handler);
				},
				registerCommand() {},
				registerTool() {},
			} as unknown as ExtensionAPI;
			createGentleAiExtension({ nativeReviewCli: null })(pi);
			const sessionStart = handlers.get("session_start");
			assert.equal(typeof sessionStart, "function");
			const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
			const notifications: Array<{ message: string; severity: string }> = [];
			await sessionStart!({}, contextFor(cwd, notifications));
			const expected = `Gentle AI dev binary override active (unpinned, field-test only): ${devBinary} 9.9.9-dev+surface sha256:${sha256.slice(0, 16)}`;
			const announcement = notifications.find((entry) => entry.message.includes(expected));
			assert.ok(announcement, JSON.stringify(notifications));
			assert.equal(announcement!.severity, "warning");
		});
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	}
});
