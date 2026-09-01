import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { initTheme, keyHint } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import gentleAi, { __testing, createGentleAiExtension } from "../extensions/gentle-ai.ts";
import type { NativeReviewCli } from "../lib/native-review-cli.ts";
import type { ReviewCollectInputV3, ReviewStatusV3 } from "../lib/review-integration-v2.ts";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import { MANDATORY_SUBAGENT_CAPABILITIES, type SubagentResultV1, type SubagentRuntimeCapabilitiesV1, type SubagentRuntimeHandleV1, type SubagentRuntimeStatusV1, type SubagentTaskV1 } from "../lib/subagent-runtime.ts";
import type { WorkspaceBindingV1, WorkspaceGuardV1 } from "../lib/workspace-guard.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

initTheme("dark");

function writeMarkdown(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

const lifecycleTheme = {
	bold(value: string): string {
		return value;
	},
	fg(color: string, value: string): string {
		return `<${color}>${value}</${color}>`;
	},
};

function renderComponent(component: { render(width: number): string[] }): string {
	return component.render(120).map((line) => line.replace(/[ \t]+$/g, "")).join("\n");
}

function registeredGentleTools(): Map<string, any> {
	const tools = new Map<string, any>();
	const pi = {
		on() {},
		registerCommand() {},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, subagentRuntime: null })(pi);
	return tools;
}

function lifecycleContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		executionStarted: false,
		isPartial: true,
		isError: false,
		lastComponent: undefined,
		...overrides,
	};
}

test("injected runtime routes provider-neutral delegation through the workspace guard", async () => {
	const tools = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const calls: string[] = [];
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-runtime-route-"));
	const binding: WorkspaceBindingV1 = {
		cwd: root,
		worktree: root,
		commonDir: join(root, ".git"),
		repositoryId: join(root, ".git"),
	};
	const guard: WorkspaceGuardV1 = {
		binding,
		checkPath: (path) => ({ allowed: true, code: "allowed", path }),
		assertPath(path) {
			calls.push(`path:${path}`);
			return path;
		},
		checkCommand: (command) => ({ allowed: true, code: "allowed", command }),
		assertCommand(command) {
			calls.push(`command:${command}`);
			return command;
		},
	};
	const capabilities: SubagentRuntimeCapabilitiesV1 = {
		protocol: 1,
		provider: "nicobailon",
		capabilities: [...MANDATORY_SUBAGENT_CAPABILITIES],
	};
	const handle: SubagentRuntimeHandleV1 = { id: "runtime-route-1" };
	const result: SubagentResultV1 = {
		status: "completed",
		summary: "delegated",
		evidence: ["runtime evidence"],
		blockers: [],
	};
	const runtime = {
		capabilities,
		isNegotiated: true,
		async negotiate() {
			calls.push("negotiate");
			return capabilities;
		},
		async start(task: SubagentTaskV1, options: { role?: string; cwd?: string }) {
			calls.push(`start:${task.task}:${options.role}:${options.cwd}`);
			return handle;
		},
		async status(_run: SubagentRuntimeHandleV1): Promise<SubagentRuntimeStatusV1> {
			calls.push("status");
			return { id: handle.id, status: "completed", result };
		},
		async result(_run: SubagentRuntimeHandleV1): Promise<SubagentResultV1> {
			calls.push("result");
			return result;
		},
		async cancel(_run: SubagentRuntimeHandleV1, reason?: string) {
			calls.push(`cancel:${reason ?? ""}`);
		},
	} as unknown;
	const pi = {
		events: { on() {}, emit() {} },
		on(name: string, handler: (...args: any[]) => unknown) {
			handlers.set(name, handler);
		},
		registerCommand() {},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
		getActiveTools() {
			throw new Error("legacy capability probes must not run for injected runtime delegation");
		},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, subagentRuntime: runtime as never, workspaceGuard: guard })(pi);
	const delegate = tools.get("gentle_subagent");
	assert.ok(delegate, "injected runtime must register provider-neutral delegation");
	const output = await delegate.execute("call-1", {
		task: "Run focused verification",
		context: "Use the approved worktree",
		dependencies: ["runtime"],
		expectedOutcome: "A portable result",
		role: "gentle-ai-worker",
	}, undefined, undefined, { cwd: root, hasUI: false } as unknown as ExtensionContext);
	assert.deepEqual(JSON.parse(output.content[0].text), result);
	assert.deepEqual(calls, [
		`path:${root}`,
		"negotiate",
		`start:Run focused verification:gentle-ai-worker:${root}`,
		"result",
	]);
});

test("review delegation decorates the provider-neutral task before runtime start", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-runtime-review-decoration-"));
	const git = (...arguments_: string[]) => execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).trim();
	git("init", "-b", "main");
	writeFileSync(join(root, "tracked.txt"), "base\n");
	git("add", "tracked.txt");
	git("-c", "user.name=Candidate Test", "-c", "user.email=candidate@example.invalid", "commit", "-m", "base");
	writeFileSync(join(root, "tracked.txt"), "candidate\n");
	const candidateViews = new CandidateViewRegistry();
	t.after(() => {
		candidateViews.cleanupAll();
		try { chmodSync(root, 0o755); } catch {}
		try { rmSync(root, { recursive: true, force: true }); } catch {}
	});
	const view = candidateViews.create({ contributorRoot: root });
	candidateViews.bindCurrent({ token: view.token, lineageId: "runtime-decoration-lineage", selectedLenses: ["review-risk"] });
	const tools = new Map<string, any>();
	const calls: string[] = [];
	const runtime = {
		async negotiate() { calls.push("negotiate"); },
		async start(task: SubagentTaskV1, options: { role?: string; cwd?: string }) {
			calls.push(`start:${task.task.includes("Controller-owned candidate view")}:${options.role}:${options.cwd}`);
			return { id: "review-decoration-runtime" };
		},
		async result() { calls.push("result"); return { status: "completed", summary: "ok", evidence: ["bound"], blockers: [] }; },
		async status() { return { id: "review-decoration-runtime", status: "completed" }; },
		async cancel() {},
	} as unknown;
	const guard: WorkspaceGuardV1 = {
		binding: { cwd: root, worktree: root, commonDir: join(root, ".git"), repositoryId: join(root, ".git") },
		checkPath: (path) => ({ allowed: true, code: "allowed", path }),
		assertPath: (path) => path,
		checkCommand: (command) => ({ allowed: true, code: "allowed", command }),
		assertCommand: (command) => command,
	};
	const pi = {
		events: { on() {}, emit() {} },
		on() {},
		registerCommand() {},
		registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, subagentRuntime: runtime as never, workspaceGuard: guard, candidateViews })(pi);
	const delegate = tools.get("gentle_subagent");
	assert.ok(delegate);
	await delegate.execute("review-decoration-call", {
		role: "review-risk",
		task: "Inspect the frozen candidate",
		context: "Return bounded findings",
		dependencies: [],
		expectedOutcome: "A review result",
	}, undefined, undefined, { cwd: root, hasUI: false } as unknown as ExtensionContext);
	assert.deepEqual(calls, [
		"negotiate",
		`start:true:review-risk:${root}`,
		"result",
	]);
});

test("provider-neutral delegation denies before runtime start when the injected guard rejects", async () => {
	const tools = new Map<string, any>();
	let starts = 0;
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-runtime-deny-"));
	const guard: WorkspaceGuardV1 = {
		binding: { cwd: root, worktree: root, commonDir: root, repositoryId: root },
		checkPath: () => ({ allowed: false, code: "outside-worktree", reason: "outside" }),
		assertPath() {
			throw new Error("workspace binding denied");
		},
		checkCommand: () => ({ allowed: false, code: "destructive-command", reason: "destructive" }),
		assertCommand() {
			throw new Error("command denied");
		},
	};
	const runtime = {
		async negotiate() {},
		async start() {
			starts += 1;
			throw new Error("runtime start must not run");
		},
		async result() {
			throw new Error("runtime result must not run");
		},
		async status() {
			throw new Error("runtime status must not run");
		},
		async cancel() {},
	} as unknown;
	const pi = {
		events: { on() {}, emit() {} },
		on() {},
		registerCommand() {},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, subagentRuntime: runtime as never, workspaceGuard: guard })(pi);
	const delegate = tools.get("gentle_subagent");
	await assert.rejects(delegate.execute("call-denied", {
		role: "gentle-ai-worker",
		task: "must not start",
		context: "",
		dependencies: [],
		expectedOutcome: "denied",
	}, undefined, undefined, { cwd: root, hasUI: false } as unknown as ExtensionContext), /workspace binding denied/);
	assert.equal(starts, 0);
});

test("provider-neutral delegation rejects provider-specific fields before crossing the runtime port", async () => {
	const tools = new Map<string, any>();
	let starts = 0;
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-runtime-contract-"));
	const guard: WorkspaceGuardV1 = {
		binding: { cwd: root, worktree: root, commonDir: root, repositoryId: root },
		checkPath: (path) => ({ allowed: true, code: "allowed", path }),
		assertPath: (path) => path,
		checkCommand: (command) => ({ allowed: true, code: "allowed", command }),
		assertCommand: (command) => command,
	};
	const runtime = {
		async negotiate() {},
		async start() {
			starts += 1;
			return { id: "must-not-start" };
		},
		async result() {
			return { status: "completed", summary: "", evidence: [], blockers: [] };
		},
		async status() {
			return { id: "must-not-start", status: "completed" };
		},
		async cancel() {},
	} as unknown;
	const pi = {
		events: { on() {}, emit() {} },
		on() {},
		registerCommand() {},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, subagentRuntime: runtime as never, workspaceGuard: guard })(pi);
	const delegate = tools.get("gentle_subagent");
	await assert.rejects(delegate.execute("call-contract", {
		role: "gentle-ai-worker",
		task: "must not start",
		context: "",
		dependencies: [],
		expectedOutcome: "denied",
		provider: "forbidden",
	}, undefined, undefined, { cwd: root, hasUI: false } as unknown as ExtensionContext), /unsupported|provider|field/i);
	assert.equal(starts, 0);
});

test("default extension wires the Pi event bus through the Nicobailon runtime", async () => {
	const tools = new Map<string, any>();
	const events = new Map<string, Set<(payload: unknown) => void>>();
	const root = process.cwd();
	const on = (event: string, handler: (payload: unknown) => void): (() => void) => {
		const handlers = events.get(event) ?? new Set();
		handlers.add(handler);
		events.set(event, handlers);
		return () => handlers.delete(handler);
	};
	const emit = (event: string, payload: unknown): void => {
		for (const handler of [...(events.get(event) ?? [])]) handler(payload);
	};
	const pi = {
		events: { on, emit },
		on() {},
		registerCommand() {},
		registerTool(tool: { name: string }) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	emit("subagents:rpc:v1:ready", {
		version: 1,
		methods: ["ping", "spawn", "status", "stop"],
		capabilities: { spawn: true, asyncSpawn: true, status: true, stop: true },
		events: {
			ready: "subagents:rpc:v1:ready",
			request: "subagents:rpc:v1:request",
			replyPrefix: "subagents:rpc:v1:reply:",
			asyncComplete: "subagent:async-complete",
		},
	});
	// The host must answer requests after extension registration; production
	// wiring is verified by observing the adapter's event-bus requests.
	on("subagents:rpc:v1:request", (payload) => {
		const request = payload as { requestId: string; method: string };
		const data = request.method === "ping"
			? {
				version: 1,
				methods: ["ping", "spawn", "status", "stop"],
				capabilities: { spawn: true, asyncSpawn: true, status: true, stop: true },
				events: { asyncComplete: "subagent:async-complete" },
			}
			: request.method === "spawn"
				? { runId: "default-runtime-1", state: "queued" }
				: { runId: "default-runtime-1", state: "completed", summary: "default wired" };
		emit(`subagents:rpc:v1:reply:${request.requestId}`, {
			version: 1,
			requestId: request.requestId,
			method: request.method,
			success: true,
			data,
		});
	});
	gentleAi(pi);
	const delegate = tools.get("gentle_subagent");
	assert.ok(delegate, "default extension must register provider-neutral delegation");
	const output = await delegate.execute("default-call", {
		role: "gentle-ai-worker",
		task: "Run default wiring",
		context: "Use the event bus",
		dependencies: ["runtime"],
		expectedOutcome: "A result",
	}, undefined, undefined, { cwd: root, hasUI: false } as unknown as ExtensionContext);
	assert.equal(JSON.parse(output.content[0].text).summary, "default wired");
});

test("workspace guard factory is bound once for the extension session", async () => {
	const tools = new Map<string, any>();
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-guard-cache-"));
	let bindings = 0;
	const guard: WorkspaceGuardV1 = {
		binding: { cwd: root, worktree: root, commonDir: root, repositoryId: root },
		checkPath: (path) => ({ allowed: true, code: "allowed", path }),
		assertPath: (path) => path,
		checkCommand: (command) => ({ allowed: true, code: "allowed", command }),
		assertCommand: (command) => command,
	};
	const result: SubagentResultV1 = { status: "completed", summary: "cached", evidence: [], blockers: [] };
	const runtime = {
		async negotiate() {},
		async start() { return { id: "cached" }; },
		async result() { return result; },
		async status() { return { id: "cached", status: "completed", result }; },
		async cancel() {},
	} as unknown;
	const pi = {
		events: { on() {}, emit() {} },
		on() {},
		registerCommand() {},
		registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: null,
		subagentRuntime: runtime as never,
		workspaceGuard: () => { bindings += 1; return guard; },
	})(pi);
	const delegate = tools.get("gentle_subagent");
	for (let index = 0; index < 2; index += 1) {
		await delegate.execute(`cached-${index}`, {
			role: "worker",
			task: "task",
			context: "",
			dependencies: [],
			expectedOutcome: "done",
		}, undefined, undefined, { cwd: root, hasUI: false } as unknown as ExtensionContext);
	}
	assert.equal(bindings, 1);
});

test("registered Gentle Review tools render reusable rose lifecycle call rows", () => {
	const tools = registeredGentleTools();
	const cases = [
		["gentle_review", { operation: "status" }, "review status"],
		["gentle_review", { operation: "future-operation", secret: "/private" }, "review"],
		["gentle_review_scope", {}, "review scope"],
		[
			"gentle_review_capture",
			{
				lineageId: "lineage-id",
				collectBinding: "binding-id",
				sha256: "sha256:hash-value",
				secret: "secret-value",
				arbitrary: "arbitrary-value",
			},
			"review capture",
		],
	] as const;

	assert.deepEqual(
		[...new Set(cases.map(([name]) => name))].sort(),
		[...tools.keys()].filter((name) => name.startsWith("gentle_")).sort(),
	);

	for (const [name, args, operationPath] of cases) {
		const tool = tools.get(name);
		assert.ok(tool, `missing ${name}`);
		const initial = tool.renderCall(args, lifecycleTheme, lifecycleContext());
		const initialText = renderComponent(initial);
		const running = tool.renderCall(
			args,
			lifecycleTheme,
			lifecycleContext({ executionStarted: true, lastComponent: initial }),
		);
		const runningText = renderComponent(running);
		const completed = tool.renderCall(
			args,
			lifecycleTheme,
			lifecycleContext({ executionStarted: true, isPartial: false, lastComponent: running }),
		);
		const completedText = renderComponent(completed);
		const failed = tool.renderCall(
			args,
			lifecycleTheme,
			lifecycleContext({ executionStarted: true, isPartial: false, isError: true, lastComponent: completed }),
		);
		const failedText = renderComponent(failed);

		assert.strictEqual(initial, running);
		assert.strictEqual(running, completed);
		assert.strictEqual(completed, failed);
		assert.equal(initialText, `<warning>🌹︎ Gentle AI · running · ${operationPath}</warning>`);
		assert.equal(runningText, `<warning>🌹︎ Gentle AI · running · ${operationPath}</warning>`);
		assert.equal(completedText, `<success>🌹︎ Gentle AI · completed · ${operationPath}</success>`);
		assert.equal(failedText, `<error>🌹︎ Gentle AI · failed · ${operationPath}</error>`);
		assert.doesNotMatch(renderComponent(failed), /future-operation|secret|private/);
		for (const forbiddenValue of ["lineage-id", "binding-id", "sha256:hash-value", "secret-value", "arbitrary-value"]) {
			assert.doesNotMatch(failedText, new RegExp(forbiddenValue));
		}
	}
});

test("registered Gentle Review tools preserve result envelopes and redact collapsed result rendering", async () => {
	const tools = registeredGentleTools();
	const scope = tools.get("gentle_review_scope");
	const manifest = { version: 1, scopeByMode: { "100644": ["src/file.ts"] }, gitlinks: {} };
	const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
	const encoded = gzipSync(bytes, { mtime: 0 }).toString("base64url");
	const sha256 = createHash("sha256").update(bytes).digest("hex");

	const result = await scope.execute(
		"scope-call",
		{ manifest: encoded, sha256, cursor: 0 },
		undefined,
		undefined,
		{ cwd: process.cwd() } as ExtensionContext,
	);
	const visibleEnvelope = JSON.parse(result.content[0].text);
	assert.deepEqual(visibleEnvelope, {
		version: 1,
		sha256,
		cursor: 0,
		totalPaths: 1,
		entries: [{ path: "src/file.ts", mode: "100644" }],
	});
	assert.deepEqual(result.details, visibleEnvelope);

	const resultText = "safe result\x1b[31m\nlineage=secret body=private";
	const expandHint = keyHint("app.tools.expand", "to expand");
	for (const name of ["gentle_review", "gentle_review_scope", "gentle_review_capture"]) {
		const tool = tools.get(name);
		assert.equal(typeof tool?.renderResult, "function", `${name} must define result rendering`);
		for (const options of [
			{ expanded: false, isPartial: true, isError: false },
			{ expanded: false, isPartial: false, isError: false },
			{ expanded: false, isPartial: false, isError: true },
		]) {
			const collapsed = renderComponent(tool.renderResult({ content: [{ type: "text", text: resultText }] }, options, lifecycleTheme, {}));
			assert.equal(collapsed, expandHint, `${name} collapsed output must contain one expand hint`);
			assert.equal(collapsed.split("\n")[0], expandHint, `${name} collapsed output must start with the hint`);
			assert.doesNotMatch(collapsed, /safe result|lineage=secret|private/);
		}
		const expanded = renderComponent(tool.renderResult({ content: [{ type: "text", text: resultText }] }, { expanded: true, isPartial: false, isError: true }, lifecycleTheme, {}));
		assert.equal(expanded.split("\n")[0], "safe result");
		assert.match(expanded, /safe result/);
		assert.match(expanded, /lineage=secret body=private/);
		assert.doesNotMatch(expanded, /to expand/);
		assert.doesNotMatch(expanded, /\x1b\[/);
		const nonText = renderComponent(tool.renderResult({ content: [{ type: "image", data: "opaque", mimeType: "image/png" }] }, { expanded: true, isPartial: false }, lifecycleTheme, {}));
		assert.equal(nonText, "");
		const empty = renderComponent(tool.renderResult({ content: [{ type: "text", text: "" }] }, { expanded: false, isPartial: false }, lifecycleTheme, {}));
		assert.equal(empty, "");
	}
});

test("session startup reports invalid project routing without mutating the profile", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-model-routing-startup-"));
	const configHome = join(root, "global");
	const projectConfigDir = join(root, ".pi", "gentle-ai");
	const projectAgentsDir = join(root, ".pi", "agents");
	const projectProfileDir = join(root, ".pi");
	const rootAgentsDir = join(root, "agents");
	const agentHome = join(root, "agent-home");
	const agentHomeAgentsDir = join(agentHome, "agents");
	const agentHomeSubagentsDir = join(agentHome, "subagents");
	mkdirSync(configHome, { recursive: true });
	mkdirSync(projectConfigDir, { recursive: true });
	mkdirSync(projectAgentsDir, { recursive: true });
	mkdirSync(projectProfileDir, { recursive: true });
	mkdirSync(rootAgentsDir, { recursive: true });
	mkdirSync(agentHomeAgentsDir, { recursive: true });
	mkdirSync(agentHomeSubagentsDir, { recursive: true });
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	t.after(() => {
		if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	});

	writeFileSync(join(projectConfigDir, "models.json"), "[]");
	writeMarkdown(join(projectAgentsDir, "worker.md"), "---\nname: worker\ndescription: Worker\n---\nbody\n");
	const profilePath = join(projectProfileDir, "subagents.json");
	const profileBytes = `${JSON.stringify({ unrelated: { keep: true } }, null, 2)}\n`;
	writeFileSync(profilePath, profileBytes);
	const before = readFileSync(profilePath, "utf8");

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
	const notifications: Array<{ message: string; severity: string }> = [];
	await sessionStart!({}, {
		cwd: root,
		hasUI: true,
		ui: {
			notify(message: string, severity: string) {
				notifications.push({ message, severity });
			},
		},
	} as unknown as ExtensionContext);

	const warning = notifications.find((entry) => entry.message.includes(join(projectConfigDir, "models.json")));
	assert.ok(warning, JSON.stringify(notifications));
	assert.equal(warning!.severity, "warning");
	assert.match(warning!.message, /skipped model config/);
	assert.equal(readFileSync(profilePath, "utf8"), before);
});

test("agent discovery skips skills directories", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-agents-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dotAgents = join(root, ".agents");
	writeMarkdown(join(dotAgents, "review-risk.md"), "name: review-risk\n");
	writeMarkdown(join(dotAgents, "team", "worker.md"), "name: worker\n");
	writeMarkdown(join(dotAgents, "skills", "ai-sdk", "SKILL.md"), "name: ai-sdk\n");
	writeMarkdown(
		join(dotAgents, "skills", "ai-sdk", "references", "evaluation.md"),
		"name: Prompt Evaluation\n",
	);

	const syncAgents = __testing.listAgentsFromDir(dotAgents, "user");
	const asyncAgents = await __testing.listAgentsFromDirAsync(dotAgents, "user");

	assert.deepEqual(
		syncAgents.map((agent) => agent.name),
		["review-risk", "worker"],
	);
	assert.deepEqual(
		asyncAgents.map((agent) => agent.name),
		["review-risk", "worker"],
	);
});

test("runtime guidance keeps review policy out of the static orchestrator", () => {
	const staticReferences = ["README.md", "skills/gentle-ai/SKILL.md"];
	const forbiddenGenericRoutes = [
		/fresh-context `reviewer`/,
		/fresh reviewer audits/,
		/reviewer fresh audits/,
		/run a fresh-context `reviewer`/,
	];

	for (const file of staticReferences) {
		const content = readFileSync(file, "utf8");
		assert.match(content, /Review Lens Selection|review lens/);
		assert.match(content, /review-risk/);
		assert.match(content, /review-reliability/);
		assert.match(content, /review-resilience/);
		assert.match(content, /review-readability/);
		for (const forbidden of forbiddenGenericRoutes) {
			assert.doesNotMatch(content, forbidden, `${file} must not route to generic reviewer`);
		}
	}

	const orchestrator = readFileSync("assets/orchestrator.md", "utf8")
		+ readFileSync("assets/orchestrator-delegation.md", "utf8");
	assert.match(orchestrator, /Gentle AI dynamically supplies runtime-specific RDD instructions/);
	assert.match(orchestrator, /this package does not invent or fall back/);
	for (const lifecycleMarker of ["review-risk", "review-reliability", "review-resilience", "review-readability", "Authority-First Terminal Procedure", "reconcile-terminal-mirrors"]) {
		assert.doesNotMatch(orchestrator, new RegExp(lifecycleMarker), `static orchestrator must not mirror ${lifecycleMarker}`);
	}
});

test("ordinary native capture exposes a registered schema and STATUS binding copied unchanged to one slot", async (t) => {
	const tools = new Map<string, { name: string; parameters: { required?: readonly string[] } }>();
	const pi = {
		on() {},
		registerCommand() {},
		registerTool(tool: { name: string; parameters: { required?: readonly string[] } }) {
			tools.set(tool.name, tool);
		},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);

	assert.ok(tools.has("gentle_review_capture"));
	assert.deepEqual(tools.get("gentle_review_capture")?.parameters.required, ["lineageId", "collectBinding"]);

	const sha = `sha256:${"a".repeat(64)}`;
	const lineageId = "ordinary-capture";
	const collectInput: ReviewCollectInputV3 = {
		name: "reviewer_result",
		schema: "https://gentle-ai.dev/schema/review/reviewer/v1",
		captureOperation: "review.capture-result",
		arguments: [
			{ name: "lineage", value: lineageId, token: `--lineage=${lineageId}` },
			{ name: "target", value: sha, token: `--target=${sha}` },
			{ name: "agent", value: "pi", token: "--agent=pi" },
			{ name: "materialize", value: "true", token: "--materialize=true" },
		],
		submission: {
			operationToken: "capture-result",
			argumentTokens: ["--lineage=ordinary-capture", `--target=${sha}`, "--agent=pi", "--materialize=true", "--input={{value}}"],
			values: [{ slot: "reviewer_result", domain: "artifact_path_or_stdin", substitutionLocation: 4 }],
		},
	};
	const currentStatus = {
		contract: "gentle-ai.review-integration/v2",
		applicability: "current_target",
		authority: { version: "compact-v2", lineageId, state: "reviewing", generation: 1, revision: sha },
		action: "stop",
		replayability: "not_replayable",
		targetIdentity: sha,
		projection: {
			schema: "gentle-ai.review-candidate-projection/v1",
			kind: "current-changes",
			projection: "workspace",
			baseTree: "b".repeat(40),
			initialReviewTree: "b".repeat(40),
			currentCandidateTree: "b".repeat(40),
			pathsDigest: sha,
			paths: ["app.ts"],
			intendedUntracked: [],
			intendedUntrackedProof: sha,
			initialSnapshotIdentity: sha,
			currentSnapshotIdentity: sha,
		},
		candidates: [],
		nextTransition: { kind: "collect", reasonCode: "capture_required", collect: { inputs: [collectInput] } },
		raw: { schema: "gentle-ai.review-integration.status/v5" },
	} as unknown as ReviewStatusV3;
	const native = { targetStatus: async () => currentStatus } as unknown as NativeReviewCli;

	const publicStatus = await __testing.executeReviewControllerOperation({ operation: "status" }, process.cwd(), native);
	const bindings = publicStatus.collectBindings as readonly { collectBinding: unknown }[];
	assert.equal(bindings.length, 1);
	assert.equal(typeof bindings[0]?.collectBinding, "string");

	let launches = 0;
	t.after(() => __testing.setReviewHostRelayRunnerForTesting());
	__testing.setReviewHostRelayRunnerForTesting(async () => {
		launches += 1;
		return { promptByteLength: 1, resultByteLength: 1, submission: "{}" };
	});
	const captured = await __testing.executeReviewCaptureOperation({
		lineageId,
		collectBinding: bindings[0]!.collectBinding,
		reviewerRunAcknowledged: true,
	}, process.cwd(), native);
	assert.equal(captured.status, "captured");
	assert.equal(launches, 1);
});

test("agent model discovery prioritizes SDD and Judgment Day agents", (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-model-agents-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeMarkdown(join(root, "zeta.md"), "name: zeta\n");
	writeMarkdown(join(root, "jd-fix-agent.md"), "name: jd-fix-agent\n");
	writeMarkdown(join(root, "sdd-apply.md"), "name: sdd-apply\n");
	writeMarkdown(join(root, "alpha.md"), "name: alpha\n");
	writeMarkdown(join(root, "jd-judge-b.md"), "name: jd-judge-b\n");
	writeMarkdown(join(root, "sdd-init.md"), "name: sdd-init\n");
	writeMarkdown(join(root, "jd-judge-a.md"), "name: jd-judge-a\n");

	const discovered = __testing.listAgentsFromDir(root, "user");
	const ordered = __testing.orderDiscoverableAgents(discovered);

	assert.deepEqual(
		ordered.map((agent) => agent.name),
		[
			"sdd-init",
			"sdd-apply",
			"jd-judge-a",
			"jd-judge-b",
			"jd-fix-agent",
			"alpha",
			"zeta",
		],
	);
});

test("discoverable model agents include installed Judgment Day agents", (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-installed-agents-"));
	const previousHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = root;
	t.after(() => {
		if (previousHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	});
	writeMarkdown(join(root, "agents", "jd-judge-a.md"), "name: jd-judge-a\n");
	writeMarkdown(join(root, "agents", "jd-judge-b.md"), "name: jd-judge-b\n");
	writeMarkdown(join(root, "agents", "jd-fix-agent.md"), "name: jd-fix-agent\n");

	const discovered = __testing.listDiscoverableAgents(root).map((agent) => agent.name);

	assert.deepEqual(
		discovered.filter((name) => name.startsWith("jd-")),
		["jd-judge-a", "jd-judge-b", "jd-fix-agent"],
	);
});

test("model panel render does not auto-apply the Gentle theme and sanitizes agent labels", () => {
	const lines = __testing.renderSddModelPanel(
		{},
		["openai/gpt-5.5"],
		["safe-agent\x1b[31m"],
		72,
	);
	const rendered = lines.join("\n");
	const plain = stripAnsi(rendered);

	assert.doesNotMatch(rendered, /\x1b\[38;2;71;85;105m/);
	assert.doesNotMatch(rendered, /\x1b\[38;2;125;211;252m/);
	assert.match(plain, /Assign Models and Effort to Agents/);
	assert.match(plain, /safe-agent\s+model=inherit, effort=inherit/);
	assert.doesNotMatch(plain, /\[31m/);
});

test("model panel render uses the Pi-provided current theme when supplied", () => {
	const currentTheme = {
		fg(_color: string, text: string): string {
			return `\x1b[35m${text}\x1b[39m`;
		},
	} as unknown as Theme;

	const rendered = __testing
		.renderSddModelPanel({}, ["openai/gpt-5.5"], ["safe-agent"], 72, currentTheme)
		.join("\n");

	assert.match(rendered, /\x1b\[35m/);
	assert.match(stripAnsi(rendered), /Assign Models and Effort to Agents/);
});

test("delivery commands bypass RDD under every mode outcome while command safety remains independent", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;
	const commands = [
		"git commit -m relay",
		"git push origin feature/relay",
		"gh pr create --base main --head feature/relay",
		"gh release create v1.2.3",
		"git status && git commit -m relay",
		"env SAFE=1 git push origin feature/relay",
		"sh -c 'gh pr create --base main --head feature/relay'",
		"sh -c 'gh release create v1.2.3'",
	] as const;
	const modes = [
		{ label: "no native CLI", nativeReviewCli: null },
		{ label: "RDD off", nativeReviewCli: { reviewMode: async () => ({ status: { effective: "off" } }) } },
		{ label: "RDD on", nativeReviewCli: { reviewMode: async () => ({ status: { effective: "on" } }) } },
		{ label: "mode failure", nativeReviewCli: { reviewMode: async () => { throw new Error("mode unavailable"); } } },
	] as const;

	for (const mode of modes) {
		const handlers = new Map<string, ToolCallHandler>();
		const pi = {
			on(name: string, handler: ToolCallHandler) {
				handlers.set(name, handler);
			},
			events: { emit() {} },
			registerCommand() {},
			registerTool() {},
		} as unknown as ExtensionAPI;
		createGentleAiExtension({ nativeReviewCli: mode.nativeReviewCli as never })(pi);
		const toolCall = handlers.get("tool_call");
		assert.equal(typeof toolCall, "function", mode.label);
		const ctx = {
			cwd: process.cwd(),
			hasUI: true,
			ui: { confirm: async () => true },
		} as ExtensionContext;

		for (const command of commands) {
			const result = await toolCall!({ toolName: "bash", input: { command } }, ctx);
			assert.equal(result, undefined, `${mode.label}: ${command}`);
		}
	}
});

test("guarded command confirmation emits a generic correlated permission lifecycle", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;
	type PermissionEvent = {
		channel: string;
		data: {
			requestId: string;
			state: "waiting" | "approved" | "denied";
			source: "tool_call";
			message: string;
			toolName: "bash";
		};
	};
	type HerdrBlockedEvent = {
		channel: "herdr:blocked";
		data: { active: boolean; label?: string };
	};
	type EmittedEvent = PermissionEvent | HerdrBlockedEvent;
	const handlers = new Map<string, ToolCallHandler>();
	const emitted: EmittedEvent[] = [];
	const sequence: string[] = [];
	let confirm!: () => Promise<boolean>;
	const pi = {
		on(name: string, handler: ToolCallHandler) {
			handlers.set(name, handler);
		},
		events: {
			emit(channel: string, data: EmittedEvent["data"]) {
				sequence.push(
					channel === "herdr:blocked"
						? `herdr:${"active" in data && data.active ? "active" : "inactive"}`
						: `event:${data.state}`,
				);
				emitted.push({ channel, data } as EmittedEvent);
			},
		},
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	const toolCall = handlers.get("tool_call");
	assert.equal(typeof toolCall, "function");
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-permission-request-"));
	try {
		const ctx = {
			cwd,
			hasUI: true,
			ui: {
				confirm: async () => {
					sequence.push("confirm");
					return confirm();
				},
			},
		} as ExtensionContext;
		let resolveConfirmation!: (approved: boolean) => void;
		confirm = () => new Promise<boolean>((resolve) => { resolveConfirmation = resolve; });
		const denied = toolCall!({
			toolName: "bash",
			input: { command: "git rebase main --secret-command-content" },
		}, ctx);

		await Promise.resolve();
		assert.equal(emitted[0].channel, "pi-permission-system:permission-request");
		assert.equal(emitted[0].data.state, "waiting");
		assert.deepEqual(emitted[1], {
			channel: "herdr:blocked",
			data: { active: true, label: "Guarded command confirmation" },
		});
		assert.deepEqual(sequence, ["event:waiting", "herdr:active", "confirm"]);
		const deniedRequestId = emitted[0].data.requestId;
		assert.match(deniedRequestId, /^[0-9a-f-]{36}$/);
		assert.deepEqual(emitted[0].data, {
			requestId: deniedRequestId,
			state: "waiting",
			source: "tool_call",
			message: "Gentle AI safety policy requires confirmation for this tool call.",
			toolName: "bash",
		});
		assert.equal(Object.keys(emitted[0].data).includes("command"), false);
		assert.equal(Object.keys(emitted[0].data).includes("preview"), false);
		assert.doesNotMatch(JSON.stringify(emitted), /secret-command-content|git rebase/);

		resolveConfirmation(false);
		assert.deepEqual(await denied, {
			block: true,
			reason: "Gentle AI safety policy blocked the command because it was not confirmed.",
		});
		assert.deepEqual(emitted[2], {
			channel: "pi-permission-system:permission-request",
			data: {
				requestId: deniedRequestId,
				state: "denied",
				source: "tool_call",
				message: "Gentle AI safety policy requires confirmation for this tool call.",
				toolName: "bash",
			},
		});
		assert.deepEqual(emitted[3], {
			channel: "herdr:blocked",
			data: { active: false },
		});
		assert.deepEqual(sequence, ["event:waiting", "herdr:active", "confirm", "event:denied", "herdr:inactive"]);

		emitted.length = 0;
		sequence.length = 0;
		confirm = async () => true;
		assert.equal(await toolCall!({ toolName: "bash", input: { command: "git rebase main" } }, ctx), undefined);
		assert.equal(emitted.length, 4);
		assert.equal(emitted[0].data.state, "waiting");
		assert.deepEqual(emitted[1], {
			channel: "herdr:blocked",
			data: { active: true, label: "Guarded command confirmation" },
		});
		assert.equal(emitted[2].data.state, "approved");
		assert.equal(emitted[0].data.requestId, emitted[2].data.requestId);
		assert.notEqual(emitted[0].data.requestId, deniedRequestId);
		assert.deepEqual(emitted[3], {
			channel: "herdr:blocked",
			data: { active: false },
		});
		assert.deepEqual(sequence, ["event:waiting", "herdr:active", "confirm", "event:approved", "herdr:inactive"]);

		emitted.length = 0;
		sequence.length = 0;
		const confirmationError = new Error("confirmation unavailable");
		confirm = async () => { throw confirmationError; };
		await assert.rejects(
			toolCall!({ toolName: "bash", input: { command: "git rebase main" } }, ctx),
			(error) => error === confirmationError,
		);
		assert.equal(emitted.length, 4);
		assert.equal(emitted[0].data.state, "waiting");
		assert.deepEqual(emitted[1], {
			channel: "herdr:blocked",
			data: { active: true, label: "Guarded command confirmation" },
		});
		assert.equal(emitted[2].data.state, "denied");
		assert.equal(emitted[0].data.requestId, emitted[2].data.requestId);
		assert.deepEqual(emitted[3], {
			channel: "herdr:blocked",
			data: { active: false },
		});
		assert.deepEqual(sequence, ["event:waiting", "herdr:active", "confirm", "event:denied", "herdr:inactive"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("concurrent guarded confirmations coalesce the Herdr lifecycle per extension instance", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;
	type EmittedEvent = {
		channel: string;
		data: {
			requestId?: string;
			state?: "waiting" | "approved" | "denied";
			active?: boolean;
			label?: string;
		};
	};
	const createHarness = () => {
		const handlers = new Map<string, ToolCallHandler>();
		const emitted: EmittedEvent[] = [];
		const confirmations: Array<(approved: boolean) => void> = [];
		const pi = {
			on(name: string, handler: ToolCallHandler) {
				handlers.set(name, handler);
			},
			events: { emit(channel: string, data: EmittedEvent["data"]) { emitted.push({ channel, data }); } },
			registerCommand() {},
			registerTool() {},
		} as unknown as ExtensionAPI;
		createGentleAiExtension({ nativeReviewCli: null, subagentRuntime: null })(pi);
		return { handlers, emitted, confirmations };
	};
	const first = createHarness();
	const second = createHarness();
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-permission-concurrent-"));
	try {
		const context = (confirmations: Array<(approved: boolean) => void>) => ({
			cwd,
			hasUI: true,
			ui: {
				confirm: async () => new Promise<boolean>((resolve) => { confirmations.push(resolve); }),
			},
		} as ExtensionContext);
		const firstRequest = first.handlers.get("tool_call")!({ toolName: "bash", input: { command: "git rebase main" } }, context(first.confirmations));
		const secondRequest = first.handlers.get("tool_call")!({ toolName: "bash", input: { command: "git rebase main --another-command" } }, context(first.confirmations));
		await Promise.resolve();
		assert.deepEqual(first.emitted.map(({ channel, data }) => ({ channel, state: data.state, active: data.active })), [
			{ channel: "pi-permission-system:permission-request", state: "waiting", active: undefined },
			{ channel: "herdr:blocked", state: undefined, active: true },
			{ channel: "pi-permission-system:permission-request", state: "waiting", active: undefined },
		]);
		assert.equal(first.confirmations.length, 2);
		const waitingEvents = first.emitted.filter(({ channel, data }) => channel === "pi-permission-system:permission-request" && data.state === "waiting");
		assert.notEqual(waitingEvents[0]?.data.requestId, waitingEvents[1]?.data.requestId);

		first.confirmations[0]!(false);
		assert.deepEqual(await firstRequest, {
			block: true,
			reason: "Gentle AI safety policy blocked the command because it was not confirmed.",
		});
		assert.deepEqual(first.emitted.map(({ channel, data }) => ({ channel, state: data.state, active: data.active })), [
			{ channel: "pi-permission-system:permission-request", state: "waiting", active: undefined },
			{ channel: "herdr:blocked", state: undefined, active: true },
			{ channel: "pi-permission-system:permission-request", state: "waiting", active: undefined },
			{ channel: "pi-permission-system:permission-request", state: "denied", active: undefined },
		]);

		const independentRequest = second.handlers.get("tool_call")!({ toolName: "bash", input: { command: "git rebase main --independent-command" } }, context(second.confirmations));
		await Promise.resolve();
		assert.equal(second.emitted.filter(({ channel }) => channel === "herdr:blocked").length, 1);
		assert.equal(second.emitted.find(({ channel }) => channel === "herdr:blocked")?.data.active, true);
		assert.equal(second.confirmations.length, 1);

		first.confirmations[1]!(true);
		assert.equal(await secondRequest, undefined);
		assert.equal(first.emitted.filter(({ channel, data }) => channel === "herdr:blocked" && data.active === false).length, 1);
		second.confirmations[0]!(true);
		assert.equal(await independentRequest, undefined);
		assert.deepEqual(second.emitted.map(({ channel, data }) => ({ channel, state: data.state, active: data.active })), [
			{ channel: "pi-permission-system:permission-request", state: "waiting", active: undefined },
			{ channel: "herdr:blocked", state: undefined, active: true },
			{ channel: "pi-permission-system:permission-request", state: "approved", active: undefined },
			{ channel: "herdr:blocked", state: undefined, active: false },
		]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("closed choice blockers retain the visible choice label through guarded-confirmation overlap", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;
	type HerdrBlockedEvent = { active: boolean; label?: string };
	const handlers = new Map<string, ToolCallHandler>();
	const eventHandlers = new Map<string, (data: unknown) => void>();
	const herdrEvents: HerdrBlockedEvent[] = [];
	const choiceEvents: Array<{ active: boolean }> = [];
	const confirmations: Array<(approved: boolean) => void> = [];
	const pi = {
		on(name: string, handler: ToolCallHandler) {
			handlers.set(name, handler);
		},
		events: {
			emit(channel: string, data: unknown) {
				if (channel === "herdr:blocked") herdrEvents.push(data as HerdrBlockedEvent);
				if (channel === "gentle-pi:ask-user-choice:blocked") choiceEvents.push(data as { active: boolean });
				eventHandlers.get(channel)?.(data);
			},
			on(channel: string, handler: (data: unknown) => void) {
				eventHandlers.set(channel, handler);
				return () => eventHandlers.delete(channel);
			},
		},
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	assert.equal(eventHandlers.has("gentle-pi:ask-user-choice:blocked"), true);

	pi.events.emit("gentle-pi:ask-user-choice:blocked", { active: true });
	assert.deepEqual(choiceEvents, [{ active: true }]);
	assert.deepEqual(herdrEvents, [{ active: true, label: "Choice awaiting input" }]);

	const guardedRequest = handlers.get("tool_call")!(
		{ toolName: "bash", input: { command: "git rebase main" } },
		{
			cwd: process.cwd(),
			hasUI: true,
			ui: {
				confirm: async () => new Promise<boolean>((resolve) => { confirmations.push(resolve); }),
			},
		} as ExtensionContext,
	);
	await Promise.resolve();
	assert.equal(confirmations.length, 1);
	assert.deepEqual(herdrEvents, [{ active: true, label: "Choice awaiting input" }]);

	pi.events.emit("gentle-pi:ask-user-choice:blocked", { active: false });
	assert.deepEqual(choiceEvents, [{ active: true }, { active: false }]);
	assert.deepEqual(herdrEvents, [
		{ active: true, label: "Choice awaiting input" },
		{ active: true, label: "Guarded command confirmation" },
	]);
	assert.equal(herdrEvents.some((event) => event.active === false), false);

	confirmations[0]!(true);
	assert.equal(await guardedRequest, undefined);
	assert.deepEqual(herdrEvents, [
		{ active: true, label: "Choice awaiting input" },
		{ active: true, label: "Guarded command confirmation" },
		{ active: false },
	]);
});

test("permission lifecycle is inactive for unguarded and headless commands", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;
	const handlers = new Map<string, ToolCallHandler>();
	const emitted: unknown[] = [];
	let confirmations = 0;
	const pi = {
		on(name: string, handler: ToolCallHandler) {
			handlers.set(name, handler);
		},
		events: { emit(_channel: string, data: unknown) { emitted.push(data); } },
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	const toolCall = handlers.get("tool_call");
	assert.equal(typeof toolCall, "function");
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-permission-headless-"));
	try {
		const confirm = async () => {
			confirmations += 1;
			return true;
		};
		assert.equal(await toolCall!({ toolName: "bash", input: { command: "echo safe --secret-command-content" } }, {
			cwd,
			hasUI: false,
			ui: { confirm },
		} as ExtensionContext), undefined);
		assert.deepEqual(await toolCall!({ toolName: "bash", input: { command: "git rebase main" } }, {
			cwd,
			hasUI: false,
			ui: { confirm },
		} as ExtensionContext), {
			block: true,
			reason: "Gentle AI safety policy requires interactive confirmation before this command.",
		});
		assert.equal(confirmations, 0);
		assert.deepEqual(emitted, []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
