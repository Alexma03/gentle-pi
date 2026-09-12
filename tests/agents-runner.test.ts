import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_MODE, type AgentDefinition } from "../lib/agents-config.ts";
import { TASK_STATUS, TaskStore } from "../lib/agents-protocol.ts";
import { AgentRunner, childArguments, JsonLines, piCommand, type RunnerDeps, type RunnerHooks, type TaskRequest } from "../lib/agents-runner.ts";
import { fakeChild, type FakeChild } from "./agents-fake-child.ts";

// Gentle Agents runner: every subagent is a child `pi --mode rpc` process.
// The host only parses JSON lines, applies deltas to the store, answers
// dialogs, and enforces its inactivity watchdog. These tests drive a fake child.

const explorer: AgentDefinition = { name: "explore", description: "maps", filePath: "/a/explore.md", scope: "global", instructions: "You map things.", model: undefined, thinking: undefined, mode: undefined, tools: ["read", "grep"] };

function request(overrides: Partial<TaskRequest> = {}): TaskRequest {
	return { agent: explorer, prompt: "Map the repo", label: undefined, context: undefined, mode: AGENT_MODE.TASK, cwd: "/repo", parentSessionId: "s1", model: { provider: "openai-codex", id: "gpt-5.6-terra" }, thinking: "high", sessionDir: "/sessions", resumeSessionPath: undefined, env: {}, ...overrides };
}

interface Harness {
	store: TaskStore;
	runner: AgentRunner;
	children: FakeChild[];
	timers: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
	asks: Array<{ taskId: string; method: string }>;
	finishes: string[];
	spawnOptions: Array<{ env: NodeJS.ProcessEnv; stdio?: string[] }>;
}

function harness(options: { maxConcurrency?: number; answer?: Record<string, unknown>; exitOnKill?: boolean; state?: Record<string, unknown>; stateSuccess?: boolean; onNotification?: RunnerHooks["onNotification"]; onSuccessfulMutation?: RunnerHooks["onSuccessfulMutation"] } = {}): Harness {
	const children: FakeChild[] = [];
	const timers: Harness["timers"] = [];
	const asks: Harness["asks"] = [];
	const finishes: string[] = [];
	const spawnOptions: Harness["spawnOptions"] = [];
	let clock = 1000;
	const deps: RunnerDeps = {
		spawn: (_command, _args, launchOptions) => {
			spawnOptions.push({ env: launchOptions.env, stdio: launchOptions.stdio });
			const fake = fakeChild({ exitOnKill: options.exitOnKill });
			if (options.state !== undefined) {
				fake.child.stdin.removeAllListeners("data");
				fake.child.stdin.on("data", (chunk) => {
					const command = JSON.parse(String(chunk));
					fake.written.push(command);
					fake.emit({ type: "response", id: command.id, success: command.type !== "get_state" || options.stateSuccess !== false,
						data: command.type === "get_state" ? options.state : undefined });
				});
			}
			children.push(fake);
			return fake.child;
		},
		now: () => (clock += 1),
		schedule: (fn, ms) => {
			const timer = { fn, ms, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		pi: { command: "pi", args: [] },
	};
	const store = new TaskStore();
	const runner = new AgentRunner(store, { maxConcurrency: options.maxConcurrency ?? 2, stallTimeoutMs: 10_000 }, deps, {
		askUser: async (taskId, ask) => {
			asks.push({ taskId, method: ask.method });
			return options.answer ?? { value: "yes" };
		},
		onFinish: (task) => finishes.push(task.id),
		onNotification: options.onNotification,
		onSuccessfulMutation: options.onSuccessfulMutation,
	});
	return { store, runner, children, timers, asks, finishes, spawnOptions };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const ending of ["cancel", "failure", "hook-error", "hook-async-error"] as const) {
	test(`successful child mutations require paired RPC events and survive ${ending}`, async () => {
		const mutations: unknown[] = [];
		const h = harness({ onSuccessfulMutation: (task, tool) => {
			mutations.push({ taskId: task.id, parent: task.parentSessionId, ...tool });
			if (ending === "hook-error") throw new Error("receipt append unavailable");
			if (ending === "hook-async-error") return Promise.reject(new Error("async receipt append unavailable"));
		} });
		const task = h.runner.run(request());
		await tick();
		const child = h.children[0];
		const start = (id: string, toolName: string) => child.emit({ type: "tool_execution_start", toolCallId: id, toolName, args: { path: "src/file.ts" } });
		const end = (id: string, isError: unknown = false) => child.emit({ type: "tool_execution_end", toolCallId: id, isError, result: { content: [] } });
		assert.deepEqual(mutations, [], "spawn is not mutation evidence");
		end("missing");
		for (const name of ["read", "bash", "subagent_run"]) { start(name, name); end(name); }
		start("failed", "write"); end("failed", true);
		start("unknown", "edit"); end("unknown", null);
		child.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "I edited files" } });
		assert.deepEqual(mutations, []);
		for (const name of ["write", "edit"]) { start(name, name); end(name); end(name); }
		assert.deepEqual(mutations, ["write", "edit"].map((toolName) => ({ taskId: task.id, parent: "s1", toolName, toolCallId: toolName, path: "src/file.ts" })));
		start("unfinished", "write");
		if (ending === "failure") child.fail("later failure");
		else h.runner.cancel(task.id);
		await tick();
		end("unfinished"); start("late", "write"); end("late");
		assert.equal(mutations.length, 2, "terminal cleanup rejects late events without retracting successful writes");
	});
}

test("launch registration waits for actual spawn, including queued launches, and ignores failed spawns", async () => {
	const launches: string[] = [];
	const spawns: Array<() => void> = [];
	const children: FakeChild[] = [];
	const cwds: string[] = [];
	const store = new TaskStore();
	const runner = new AgentRunner(store, { maxConcurrency: 1, stallTimeoutMs: 1000 }, {
		spawn: (_command, _args, options) => {
			cwds.push(options.cwd);
			if (options.cwd === "/throws") throw new Error("missing executable");
			const fake = fakeChild();
			const on = fake.child.on.bind(fake.child);
			fake.child.on = ((event: string, listener: () => void) => {
				if (event === "spawn") spawns.push(listener);
				else on(event as "exit", listener);
				return fake.child;
			}) as typeof fake.child.on;
			children.push(fake);
			return fake.child;
		},
		now: () => 1000, schedule: () => () => {}, pi: { command: "pi", args: [] },
	}, { askUser: async () => ({ cancelled: true }) });
	const first = runner.run(request({ cwd: "/child", onLaunch: () => launches.push("s1:/child") }));
	const second = runner.run(request({ cwd: "/queued", onLaunch: () => launches.push("s1:/queued") }));
	assert.deepEqual(launches, []);
	await tick();
	assert.deepEqual(launches, [], "returning a child handle is not successful spawn");
	assert.equal(typeof spawns[0], "function");
	spawns[0]();
	assert.deepEqual(launches, ["s1:/child"]);
	runner.cancel(first.id);
	await tick();
	assert.equal(store.get(second.id)?.cwd, "/queued");
	spawns[1]();
	assert.deepEqual(launches, ["s1:/child", "s1:/queued"]);
	runner.cancel(second.id);
	await tick();
	const failed = runner.run(request({ cwd: "/missing", onLaunch: () => launches.push("bad") }));
	await tick();
	children[2].fail("ENOENT");
	await tick();
	assert.equal(store.get(failed.id)?.status, TASK_STATUS.FAILED);
	const thrown = runner.run(request({ cwd: "/throws", onLaunch: () => launches.push("bad") }));
	await tick();
	assert.equal(store.get(thrown.id)?.status, TASK_STATUS.FAILED);
	assert.deepEqual(launches, ["s1:/child", "s1:/queued"]);
	assert.deepEqual(cwds, ["/child", "/queued", "/missing", "/throws"]);
});

test("runner captures resolved model and effort, retaining omitted launch values", async () => {
	for (const scenario of [
		{ state: { model: { provider: "anthropic", id: "resolved-model" }, thinkingLevel: "off" }, model: "anthropic/resolved-model", thinking: "off" },
		{ state: { thinkingLevel: "max" }, model: "openai-codex/gpt-5.6-terra", thinking: "max" },
		{ state: {}, model: "openai-codex/gpt-5.6-terra", thinking: "high" },
		{ state: { model: null }, model: "default", thinking: "high" },
		{ state: { model: { id: 7 }, thinkingLevel: 7 }, model: "openai-codex/gpt-5.6-terra", thinking: "high" },
	]) {
		const h = harness({ state: scenario.state });
		const task = h.runner.run(request());
		await tick();
		assert.equal(h.store.get(task.id)?.model, scenario.model);
		assert.equal(h.store.get(task.id)?.thinking, scenario.thinking);
		h.runner.cancel(task.id);
	}
	const h = harness({ state: { model: { provider: "wrong", id: "wrong" }, thinkingLevel: "low" }, stateSuccess: false });
	const task = h.runner.run(request({ model: undefined, thinking: undefined }));
	await tick();
	assert.equal(h.store.get(task.id)?.model, "default");
	assert.equal(h.store.get(task.id)?.thinking, undefined);
	h.runner.cancel(task.id);
});

test("childArguments builds an rpc launch with model, thinking, tools, session dir, and instructions", () => {
	const args = childArguments(request());
	assert.deepEqual(args.slice(0, 2), ["--mode", "rpc"]);
	assert.ok(args.includes("--session-dir") && args[args.indexOf("--session-dir") + 1] === "/sessions");
	assert.equal(args[args.indexOf("--model") + 1], "openai-codex/gpt-5.6-terra:high");
	assert.equal(args[args.indexOf("--tools") + 1], "read,grep,subagent_parent_message");
	assert.equal(args[args.indexOf("--append-system-prompt") + 1], "You map things.");
	assert.ok(!args.includes("--session"));
	const resumed = childArguments(request({ resumeSessionPath: "/sessions/old.jsonl", model: undefined, thinking: undefined, agent: { ...explorer, tools: [] } }));
	assert.equal(resumed[resumed.indexOf("--session") + 1], "/sessions/old.jsonl");
	assert.ok(!resumed.includes("--model") && !resumed.includes("--tools"));
});

test("childArguments grants every child the notification-only parent message tool", () => {
	const args = childArguments(request());
	assert.equal(args[args.indexOf("--tools") + 1], "read,grep,subagent_parent_message");
});

test("AgentRunner admits strict live notifications once and closes IPC before Stop", async () => {
	const notifications: string[] = [];
	const { runner, children, spawnOptions } = harness({ onNotification: (task, message) => task.parentSessionId === "s1" && (notifications.push(message), true) });
	const task = runner.run(request());
	await tick();
	children[0].message({ id: "n1", kind: "notification", message: "checkpoint" });
	children[0].message({ id: "n1", kind: "notification", message: "checkpoint" });
	children[0].message({ id: "n2", kind: "notification", message: "x".repeat(8 * 1024 + 1) });
	children[0].message({ id: "q3", kind: "query", message: "unsupported" });
	children[0].message({ id: "n4", kind: "notification", message: "\uD800" });
	children[0].message({ id: "n5", kind: "notification", message: "forged field", sender: "forged" });
	children[0].message({ id: "n0", kind: "notification", message: "invalid correlation" });
	children[0].message({ id: `n${"1".repeat(1_000)}`, kind: "notification", message: "invalid correlation" });
	await tick();
	assert.deepEqual(spawnOptions[0]?.stdio, ["pipe", "pipe", "pipe", "ipc"]);
	assert.deepEqual(notifications, ["checkpoint"]);
	assert.deepEqual(children[0].sent, [
		{ id: "n1", kind: "ack", accepted: true },
		{ id: "n2", kind: "ack", accepted: false, error: "invalid child IPC message" },
		{ id: "q3", kind: "reply", error: "task parent cannot accept queries" },
		{ id: "n4", kind: "ack", accepted: false, error: "invalid child IPC message" },
		{ id: "n5", kind: "ack", accepted: false, error: "invalid child IPC frame" },
	]);
	runner.cancel(task.id);
	children[0].message({ id: "after-stop", kind: "notification", message: "ignored" });
	await tick();
	assert.equal(children[0].sent.length, 5);
	assert.ok(children[0].disconnects > 0);
});

test("AgentRunner rejects notifications from an inactive parent session with a static acknowledgement", async () => {
	const { runner, children } = harness({ onNotification: () => false });
	runner.run(request());
	await tick();
	children[0].message({ id: "n1", kind: "notification", message: "not active" });
	await tick();
	assert.deepEqual(children[0].sent, [{ id: "n1", kind: "ack", accepted: false, error: "task parent is not the active host session" }]);
});

test("AgentRunner retains only a 64-notification duplicate window", async () => {
	const notifications: string[] = [];
	const { runner, children } = harness({ onNotification: (_task, message) => { notifications.push(message); } });
	runner.run(request());
	await tick();
	for (let index = 1; index <= 65; index += 1) children[0].message({ id: `n${index}`, kind: "notification", message: `message ${index}` });
	children[0].message({ id: "n1", kind: "notification", message: "message 1 again" });
	await tick();
	assert.equal(notifications.length, 66, "an ID evicted from the recent 64-ack window can be admitted again");
});

test("piCommand reuses the running pi entry point and honors the override", () => {
	assert.deepEqual(piCommand({ execPath: "/bin/node", argv: ["/bin/node", "/x/dist/cli.js"], env: {} }), { command: "/bin/node", args: ["/x/dist/cli.js"] });
	assert.deepEqual(piCommand({ execPath: "/bin/node", argv: ["/bin/node", "/x/other.js"], env: {} }), { command: "pi", args: [] });
	assert.deepEqual(piCommand({ execPath: "/bin/node", argv: [], env: { GENTLE_PI_AGENTS_PI: "/opt/pi --flag" } }), { command: "/opt/pi", args: ["--flag"] });
});

test("piCommand resolves an npm bin symlink instead of searching the workspace PATH", { skip: process.platform === "win32" }, (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle cli resolution ")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const bin = join(root, "bin");
	const bundle = join(root, "package", "dist", "bundle");
	mkdirSync(bin, { recursive: true });
	mkdirSync(bundle, { recursive: true });
	const cli = join(bundle, "cli.js");
	const alias = join(bin, "pi");
	writeFileSync(cli, "// Pi CLI fixture\n");
	symlinkSync(cli, alias);
	const proc = { execPath: "/workspace-node/bin/node", argv: ["node", alias], env: { PATH: "/workspace-node/bin:/mise/shims" } };
	assert.deepEqual(piCommand(proc), { command: proc.execPath, args: [cli] });
	assert.deepEqual(piCommand({ ...proc, env: { ...proc.env, GENTLE_PI_AGENTS_PI: "/custom/pi --flag" } }), { command: "/custom/pi", args: ["--flag"] }, "explicit user override still wins");
	symlinkSync(alias, join(bin, "pi-alias"));
	assert.deepEqual(piCommand({ ...proc, argv: ["node", join(bin, "pi-alias")] }), { command: proc.execPath, args: [cli] });
	writeFileSync(join(bundle, "other.js"), "// not Pi\n");
	symlinkSync(join(bundle, "other.js"), join(bin, "other"));
	assert.deepEqual(piCommand({ ...proc, argv: ["node", join(bin, "other")] }), { command: "pi", args: [] });
	symlinkSync(join(bundle, "missing.js"), join(bin, "broken"));
	assert.deepEqual(piCommand({ ...proc, argv: ["node", join(bin, "broken")] }), { command: "pi", args: [] });
});

test("JsonLines splits on LF only, tolerates CRLF, and skips lines that are not JSON", () => {
	const seen: unknown[] = [];
	const lines = new JsonLines((value) => seen.push(value));
	lines.push('{"a":1}\r\n{"b":"x y"}\nnot json\n{"c":');
	lines.push("3}\n");
	assert.deepEqual(seen, [{ a: 1 }, { b: "x y" }, { c: 3 }]);
});

test("AgentRunner runs a task end to end: prompt, deltas into the store, completion with the last answer", async () => {
	const { store, runner, children } = harness();
	const task = runner.run(request());
	assert.equal(task.status, TASK_STATUS.QUEUED);
	await tick();
	assert.equal(store.get(task.id)?.status, TASK_STATUS.RUNNING);
	const [child] = children;
	await tick();
	assert.deepEqual(children[0].written.map((command) => command.type), ["get_state", "prompt"]);
	assert.equal(children[0].written[1].message, "Map the repo");
	child.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "grep", args: {} });
	child.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Found it" } });
	child.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Found it" }] }] });
	await tick();
	assert.equal(store.get(task.id)?.status, TASK_STATUS.RUNNING, "agent_end retains the latest answer while queued follow-up may still run");
	assert.equal(children[0].killed.length, 0, "the child remains available until Pi reports settlement");
	child.emit({ type: "agent_settled" });
	await tick();
	const finished = store.get(task.id);
	assert.equal(finished?.status, TASK_STATUS.COMPLETED);
	assert.equal(finished?.result, "Found it");
	assert.equal(finished?.toolCalls, 1);
	assert.equal(finished?.sessionPath, "/sessions/child.jsonl");
	assert.equal(finished?.label, "Map the repo");
	assert.ok(children[0].killed.length > 0, "the child is stopped once the answer is in");
	assert.equal(store.thread(task.id).items.length, 2);
	assert.equal((await runner.waitFor(task.id)).status, TASK_STATUS.COMPLETED);
});

test("AgentRunner waits for child exit after settlement before releasing its queue slot or finishing twice", async () => {
	const { store, runner, children, finishes } = harness({ maxConcurrency: 1, exitOnKill: false });
	const first = runner.run(request());
	const second = runner.run(request({ prompt: "Second" }));
	await tick();
	assert.equal(children.length, 1);
	children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Answer" }] }] });
	await tick();
	assert.equal(store.get(first.id)?.status, TASK_STATUS.RUNNING, "agent_end ends one run, not the session");
	assert.equal(store.get(first.id)?.result, "Answer", "agent_end retains the final run output");
	assert.equal(store.get(second.id)?.status, TASK_STATUS.QUEUED, "the slot stays occupied until settlement");
	assert.deepEqual(finishes, []);
	children[0].emit({ type: "agent_settled" });
	await tick();
	assert.equal(store.get(first.id)?.status, TASK_STATUS.RUNNING, "terminal RPC state does not release a live process");
	assert.equal(store.get(second.id)?.status, TASK_STATUS.QUEUED);
	children[0].exit(0);
	await tick();
	await tick();
	assert.equal(store.get(first.id)?.status, TASK_STATUS.COMPLETED);
	assert.deepEqual(finishes, [first.id], "settlement delivers completion once");
	assert.equal(children.length, 2, "child exit releases the queue slot");
	children[0].emit({ type: "agent_settled" });
	await tick();
	assert.deepEqual(finishes, [first.id], "duplicate terminal events do not finalize twice");
});

test("AgentRunner queues beyond max concurrency and starts the next task when one finishes", async () => {
	const { store, runner, children } = harness({ maxConcurrency: 1 });
	const first = runner.run(request());
	const second = runner.run(request({ prompt: "Second" }));
	await tick();
	assert.equal(children.length, 1);
	assert.equal(store.get(second.id)?.status, TASK_STATUS.QUEUED);
	children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "First complete." }], stopReason: "stop" }] });
	await tick();
	assert.equal(store.get(first.id)?.status, TASK_STATUS.RUNNING, "the concurrency slot remains held through a queued follow-up");
	children[0].emit({ type: "agent_settled" });
	await tick();
	await tick();
	assert.equal(store.get(first.id)?.status, TASK_STATUS.COMPLETED);
	assert.equal(children.length, 2);
	assert.equal(store.get(second.id)?.status, TASK_STATUS.RUNNING);
});

test("AgentRunner classifies terminal assistant outcomes only after settlement", async () => {
	const scenarios = [
		{ name: "error", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "WebSocket error: secret=never-copy" }], status: TASK_STATUS.FAILED, error: /assistant reported an error/ },
		{ name: "aborted", messages: [{ role: "assistant", content: [], stopReason: "aborted" }], status: TASK_STATUS.FAILED, error: /assistant aborted/ },
		{ name: "empty", messages: [{ role: "assistant", content: [], stopReason: "stop" }], status: TASK_STATUS.FAILED, error: /no final report/ },
		{ name: "success", messages: [{ role: "assistant", content: [{ type: "text", text: "final report" }], stopReason: "stop" }], status: TASK_STATUS.COMPLETED, error: null },
	] as const;
	for (const scenario of scenarios) {
		const { store, runner, children } = harness();
		const task = runner.run(request());
		await tick();
		children[0].emit({ type: "agent_end", messages: scenario.messages });
		assert.equal(store.get(task.id)?.status, TASK_STATUS.RUNNING, `${scenario.name} stays running until settlement`);
		children[0].emit({ type: "agent_settled" });
		const finished = await runner.waitFor(task.id);
		assert.equal(finished.status, scenario.status, scenario.name);
		if (scenario.error) assert.match(finished.error ?? "", scenario.error);
		else assert.equal(finished.result, "final report");
	}
});

test("AgentRunner clears an earlier answer after a later error, but permits a successful retry before settlement", async () => {
	const first = harness();
	const failedTask = first.runner.run(request());
	await tick();
	first.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "stale success" }], stopReason: "stop" }] });
	first.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "provider detail must not persist" }] });
	first.children[0].emit({ type: "agent_settled" });
	const failed = await first.runner.waitFor(failedTask.id);
	assert.equal(failed.status, TASK_STATUS.FAILED);
	assert.equal(failed.result, null, "a later error must not report stale successful text");

	const retry = harness();
	const retryTask = retry.runner.run(request());
	await tick();
	retry.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error" }] });
	retry.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "retry report" }], stopReason: "stop" }] });
	retry.children[0].emit({ type: "agent_settled" });
	const recovered = await retry.runner.waitFor(retryTask.id);
	assert.equal(recovered.status, TASK_STATUS.COMPLETED);
	assert.equal(recovered.result, "retry report");
});

test("AgentRunner fails if the child exits after agent_end but before agent_settled", async () => {
	const { store, runner, children } = harness();
	const task = runner.run(request());
	await tick();
	children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "partial answer" }] }] });
	await tick();
	children[0].exit(0);
	await tick();
	assert.equal(store.get(task.id)?.status, TASK_STATUS.FAILED);
	assert.match(store.get(task.id)?.error ?? "", /before agent_settled/);
	assert.equal(store.get(task.id)?.result, "partial answer", "the final observed answer remains available for diagnostics");
});

for (const [platform, detached] of [["win32", false], ["linux", true]] as const) test(`AgentRunner selects detached=${detached} for ${platform} without changing the launch contract`, async () => {
	const store = new TaskStore();
	const launches: Array<{ command: string; args: string[]; options: Parameters<RunnerDeps["spawn"]>[2] }> = [];
	const child = fakeChild();
	const runner = new AgentRunner(store, { maxConcurrency: 1, stallTimeoutMs: 1_000 }, {
		spawn: (command, args, options) => {
			launches.push({ command, args, options });
			return child.child;
		},
		now: () => 1,
		schedule: () => () => {},
		pi: { command: "pi-fixture", args: ["--from-host"] },
		process: { platform, kill: () => {} },
	}, { askUser: async () => ({ cancelled: true }) });
	const task = runner.run(request({ env: { PATH: "/fixture", KEEP: "yes" } }));
	await tick();
	const ownedIpc = launches[0]?.options.env.GENTLE_PI_AGENTS_OWNED_IPC;
	assert.match(ownedIpc ?? "", /^\d+-[a-z0-9]+$/, "the runner creates an opaque owned-IPC marker");
	assert.deepEqual(launches, [{
		command: "pi-fixture",
		args: ["--from-host", "--mode", "rpc", "--session-dir", "/sessions", "--model", "openai-codex/gpt-5.6-terra:high", "--tools", "read,grep,subagent_parent_message", "--append-system-prompt", "You map things."],
		options: { cwd: "/repo", env: { PATH: "/fixture", KEEP: "yes", GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_OWNED_IPC: ownedIpc }, detached, stdio: ["pipe", "pipe", "pipe", "ipc"] },
	}]);
	child.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "platform checked" }], stopReason: "stop" }] });
	child.emit({ type: "agent_settled" });
	assert.equal((await runner.waitFor(task.id)).status, TASK_STATUS.COMPLETED);
});

test("AgentRunner retains permission broker fd3 and assigns messaging IPC to fd4", async () => {
	const { runner, children, spawnOptions } = harness();
	const task = runner.run(request({ authorizeParentStandingReviewPermission: () => true }));
	await tick();
	const launch = spawnOptions[0];
	assert.match(launch?.env.GENTLE_PI_AGENTS_OWNED_IPC ?? "", /^\d+-[a-z0-9]+$/, "the owned-IPC marker has the runner's opaque shape");
	assert.deepEqual(launch?.env, { GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_OWNED_IPC: launch?.env.GENTLE_PI_AGENTS_OWNED_IPC, GENTLE_PI_AGENTS_PARENT_PERMISSION_FD: "3" });
	assert.deepEqual(launch?.stdio, ["pipe", "pipe", "pipe", "pipe", "ipc"]);
	assert.equal(launch?.stdio?.length, 5);
	children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "channel checked" }], stopReason: "stop" }] });
	children[0].emit({ type: "agent_settled" });
	assert.equal((await runner.waitFor(task.id)).status, TASK_STATUS.COMPLETED);
});

test("AgentRunner answers dialogs through askUser in task mode and cancels them in background mode", async () => {
	const { store, runner, children, asks } = harness({ answer: { confirmed: true } });
	const task = runner.run(request());
	const background = runner.run(request({ mode: AGENT_MODE.BACKGROUND }));
	await tick();
	children[0].emit({ type: "extension_ui_request", id: "u1", method: "confirm", title: "Delete?" });
	children[1].emit({ type: "extension_ui_request", id: "u2", method: "select", title: "Pick", options: ["a"] });
	children[1].emit({ type: "extension_ui_request", id: "u3", method: "notify", message: "hi" });
	await tick();
	await tick();
	assert.deepEqual(asks, [{ taskId: task.id, method: "confirm" }]);
	assert.deepEqual(children[0].written.at(-1), { type: "extension_ui_response", id: "u1", confirmed: true });
	assert.deepEqual(children[1].written.at(-1), { type: "extension_ui_response", id: "u2", cancelled: true });
	assert.equal(store.get(background.id)?.status, TASK_STATUS.RUNNING);
	assert.equal(store.get(task.id)?.status, TASK_STATUS.RUNNING, "answered questions do not leave the task waiting");
});

test("AgentRunner cancels and fails when the child exits early", async () => {
	const { store, runner, children } = harness({ maxConcurrency: 3 });
	const cancelled = runner.run(request());
	const crashed = runner.run(request());
	await tick();
	runner.cancel(cancelled.id);
	await tick();
	assert.equal(store.get(cancelled.id)?.status, TASK_STATUS.CANCELLED);
	assert.ok(children[0].written.some((command) => command.type === "abort"));
	children[1].exit(1);
	await tick();
	assert.equal(store.get(crashed.id)?.status, TASK_STATUS.FAILED);
	assert.match(store.get(crashed.id)?.error ?? "", /exited with code 1/);
	assert.ok(runner.steer(cancelled.id, "x") === false, "a finished task cannot be steered");
});

test("AgentRunner has no total-duration watchdog but keeps active work alive and times out true silence", async () => {
	const { store, runner, children, timers } = harness();
	const task = runner.run(request({ mode: AGENT_MODE.BACKGROUND }));
	await tick();
	assert.deepEqual(timers.filter((timer) => !timer.cancelled).map((timer) => timer.ms), [10_000], "only the inactivity watchdog is scheduled");
	const initialStall = timers[0];
	children[0].emit({ type: "response", id: "r1", success: true });
	await tick();
	assert.equal(initialStall.cancelled, true, "every child RPC event, including a response, re-arms the inactivity watchdog");
	children[0].emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "still working" } });
	await tick();
	assert.equal(store.get(task.id)?.status, TASK_STATUS.RUNNING, "ongoing RPC activity keeps a long-running task active");
	const stall = timers.filter((timer) => timer.ms === 10_000 && !timer.cancelled).at(-1);
	assert.ok(stall);
	stall.fn();
	await tick();
	assert.equal(store.get(task.id)?.status, TASK_STATUS.TIMED_OUT);
	assert.match(store.get(task.id)?.error ?? "", /stalled/);
});

test("AgentRunner.cancelAll stops every queued and running task", async () => {
	const { store, runner, children } = harness({ maxConcurrency: 1 });
	const running = runner.run(request());
	const queued = runner.run(request());
	await tick();
	assert.equal(runner.cancelAll(), 2);
	await tick();
	assert.equal(store.get(running.id)?.status, TASK_STATUS.CANCELLED);
	assert.equal(store.get(queued.id)?.status, TASK_STATUS.CANCELLED);
	assert.deepEqual(children[0].killed, ["SIGTERM"]);
	assert.equal(children.length, 1, "nothing else starts after cancelAll");
});

test("AgentRunner fails only the task when the child cannot start, and the queue moves on", async () => {
	const { store, runner, children, timers } = harness({ maxConcurrency: 1 });
	const broken = runner.run(request());
	const next = runner.run(request({ prompt: "After" }));
	await tick();
	children[0].fail("spawn pi ENOENT");
	await tick();
	assert.equal(store.get(broken.id)?.status, TASK_STATUS.FAILED);
	assert.match(store.get(broken.id)?.error ?? "", /could not start pi: spawn pi ENOENT/);
	assert.equal((await runner.waitFor(broken.id)).status, TASK_STATUS.FAILED, "waiters settle");
	await tick();
	assert.equal(children.length, 2, "the next queued task starts");
	assert.equal(store.get(next.id)?.status, TASK_STATUS.RUNNING);
	assert.ok(timers.filter((timer) => timer.ms === 10_000).some((timer) => timer.cancelled), "the failed task's inactivity watchdog is cancelled");
});

test("AgentRunner retains sanitized stderr and exit evidence after an early IPC error", async () => {
	const h = harness({ exitOnKill: false, maxConcurrency: 1 });
	const task = h.runner.run(request());
	const next = h.runner.run(request());
	await tick();
	const fake = h.children[0];
	fake.child.pid = 123;
	fake.child.stderr!.emit("data", "\u001b[31mBootstrap failed\u001b[0m\nAuthor");
	fake.child.stderr!.emit("data", "ization: Bearer private-credential\n{\"api_key\":\"private-api-key\"}\n");
	fake.child.stderr!.emit("data", "https://user:private-password@example.test/?token=private-query\n");
	fake.fail("IPC channel is already disconnected");
	assert.equal(h.store.get(task.id)?.status, TASK_STATUS.RUNNING);
	assert.equal(h.store.get(next.id)?.status, TASK_STATUS.QUEUED);
	fake.child.stderr!.emit("data", "Cannot load extension\u0007");
	fake.exit(1);
	fake.child.stderr!.emit("data", "\nFinal pipe diagnostic\n");
	const finished = await h.runner.waitFor(task.id);
	assert.equal(finished.status, TASK_STATUS.FAILED);
	assert.match(finished.error ?? "", /IPC channel is already disconnected/);
	assert.match(finished.error ?? "", /exit code: 1/);
	assert.match(finished.error ?? "", /stderr tail:[\s\S]*Bootstrap failed[\s\S]*Cannot load extension/);
	assert.match(finished.error ?? "", /Final pipe diagnostic/);
	assert.doesNotMatch(finished.error ?? "", /private-|\u001b|\u0007/);
	await tick();
	assert.deepEqual(h.finishes, [task.id]);
	assert.equal(h.store.get(next.id)?.status, TASK_STATUS.RUNNING);
	h.runner.cancel(next.id);
	h.children[1].exit(0);
});

test("AgentRunner bounds stderr without leaking fragments of an oversized secret line", async () => {
	const h = harness();
	const task = h.runner.run(request());
	await tick();
	const fake = h.children[0];
	fake.child.stderr!.emit("data", "OLD-DIAGNOSTIC\n");
	for (let i = 0; i < 1000; i += 1) fake.child.stderr!.emit("data", "startup warning\n");
	fake.child.stderr!.emit("data", "token=");
	for (let i = 0; i < 100; i += 1) fake.child.stderr!.emit("data", "private-fragment".repeat(100));
	fake.child.stderr!.emit("data", "\nLast startup error\n");
	fake.exit(2);
	const error = (await h.runner.waitFor(task.id)).error ?? "";
	assert.match(error, /Last startup error/);
	assert.doesNotMatch(error, /OLD-DIAGNOSTIC|private-fragment/);
	assert.ok(error.length < 4600, "persisted stderr tail stays bounded");
});

test("AgentRunner redacts multiline keys and credential lines even across single-character chunks", async () => {
	const h = harness();
	const task = h.runner.run(request());
	await tick();
	const fake = h.children[0];
	const input = [
		"-----BEGIN PRIVATE KEY-----", "private-material", "-----END PRIVATE KEY-----",
		"Cookie: private-cookie", "password=private-password", '"access_token": "private-token"',
		"sk-private-api", "Bearer private-bearer", "https://example.test/?anything=private-query",
		"Last readable error: café",
	].join("\n");
	for (const char of input) fake.child.stderr!.emit("data", char);
	fake.exit(1);
	const error = (await h.runner.waitFor(task.id)).error ?? "";
	assert.match(error, /Last readable error: café/);
	assert.match(error, /\[REDACTED\]/);
	assert.doesNotMatch(error, /private-/);
});

test("AgentRunner bounds the stderr drain and ignores output after finalization", async () => {
	const h = harness();
	const task = h.runner.run(request());
	await tick();
	const fake = h.children[0];
	fake.child.stderr!.emit("data", "before drain deadline");
	fake.exit(1);
	assert.equal(h.store.get(task.id)?.status, TASK_STATUS.RUNNING);
	const drain = h.timers.find((timer) => timer.ms === 100 && !timer.cancelled);
	assert.ok(drain, "a failed exit must not wait indefinitely for an inherited stderr pipe");
	drain.fn();
	const finished = await h.runner.waitFor(task.id);
	assert.match(finished.error ?? "", /before drain deadline/);
	const snapshot = structuredClone(finished);
	fake.child.stderr!.emit("data", "too late");
	await tick();
	assert.deepEqual(h.store.get(task.id), snapshot);
	assert.deepEqual(h.finishes, [task.id]);
});

test("AgentRunner reports a signal exit without inventing an exit code", async () => {
	const h = harness();
	const task = h.runner.run(request());
	await tick();
	h.children[0].exit(null, "SIGKILL");
	const error = (await h.runner.waitFor(task.id)).error ?? "";
	assert.match(error, /signal: SIGKILL/);
	assert.match(error, /exit code: unknown/);
	assert.doesNotMatch(error, /stderr tail/);
});

for (const outcome of ["success", "cancel"] as const) test(`AgentRunner does not attach stderr to ${outcome}`, async () => {
	const h = harness();
	const task = h.runner.run(request());
	await tick();
	const fake = h.children[0];
	fake.child.stderr!.emit("data", "nonfatal warning\n");
	if (outcome === "cancel") h.runner.cancel(task.id);
	else {
		fake.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] });
		fake.emit({ type: "agent_settled" });
	}
	const finished = await h.runner.waitFor(task.id);
	assert.equal(finished.status, outcome === "cancel" ? TASK_STATUS.CANCELLED : TASK_STATUS.COMPLETED);
	assert.equal(finished.error, outcome === "cancel" ? "cancelled" : null);
});

test("AgentRunner turns a synchronous spawn exception into a failed task", async () => {
	const store = new TaskStore();
	const runner = new AgentRunner(store, { maxConcurrency: 1, stallTimeoutMs: 1000 }, {
		spawn: () => {
			throw new Error("ENOENT: pi not found");
		},
		now: () => 1,
		schedule: () => () => {},
		pi: { command: "missing-pi", args: [] },
	}, { askUser: async () => ({ cancelled: true }) });
	const task = runner.run(request());
	const finished = await runner.waitFor(task.id);
	assert.equal(finished.status, TASK_STATUS.FAILED);
	assert.match(finished.error ?? "", /could not start pi: ENOENT/);
});

for (const lateEvents of [false, true]) test(`AgentRunner releases quarantined capacity only on proven exit (late events: ${lateEvents})`, async () => {
	const store = new TaskStore();
	const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	let now = 0;
	let groupGone = false;
	let launches = 0;
	let asks = 0;
	const finishes: string[] = [];
	let resolveAnswer!: (answer: { value: string }) => void;
	const answer = new Promise<{ value: string }>((resolve) => { resolveAnswer = resolve; });
	const child = fakeChild({ exitOnKill: false, pid: 71 });
	const runner = new AgentRunner(store, { maxConcurrency: 1, stallTimeoutMs: 10_000 }, {
		spawn: () => { launches += 1; return launches === 1 ? child.child : fakeChild().child; },
		now: () => now,
		schedule: (fn, ms) => {
			const timer = { fn, ms, cancelled: false };
			timers.push(timer);
			return () => { timer.cancelled = true; };
		},
		pi: { command: "pi", args: [] },
		process: { platform: "linux", kill: (_pid, signal) => {
			if (signal === 0) throw Object.assign(new Error("group probe"), { code: groupGone ? "ESRCH" : "EPERM" });
		} },
	}, { askUser: async () => { asks += 1; return answer; }, onFinish: (task) => finishes.push(task.id) });
	const first = runner.run(request());
	const second = runner.run(request({ prompt: "queued" }));
	await tick();
	const waiter = runner.waitFor(first.id);
	if (lateEvents) child.emit({ type: "extension_ui_request", id: "early", method: "input", title: "Pending?" });
	runner.cancel(first.id);
	const grace = timers.find((timer) => timer.ms === 250);
	assert.ok(grace);
	grace.fn();
	now = 2_000;
	const check = timers.filter((timer) => timer.ms === 25).at(-1);
	assert.ok(check);
	check.fn();
	await tick();
	assert.equal(store.get(first.id)?.status, TASK_STATUS.FAILED);
	assert.equal((await waiter).status, TASK_STATUS.FAILED);
	assert.match(store.get(first.id)?.error ?? "", /cleanup unconfirmed/);
	assert.equal(store.get(second.id)?.status, TASK_STATUS.QUEUED, "the unconfirmed group retains its capacity");
	assert.equal(timers.filter((timer) => timer.ms === 25 && !timer.cancelled).length, 0, "confirmation polling stops at its deadline");
	const finished = structuredClone(store.get(first.id));
	if (lateEvents) {
		const thread = structuredClone(store.thread(first.id));
		const timerCount = timers.length;
		const writes = child.written.length;
		resolveAnswer({ value: "too late" });
		await tick();
		child.emit({ type: "extension_ui_request", id: "late", method: "input", title: "Reopen?" });
		child.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "late result" }] }] });
		child.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "late" } });
		child.emit({ type: "agent_settled" });
		await tick();
		assert.equal(asks, 1, "late dialogs must not reopen");
		assert.equal(child.written.length, writes, "pending answers must not reach a terminal child");
		assert.equal(timers.length, timerCount, "late activity must not rearm the stall watchdog");
		assert.deepEqual(store.get(first.id), finished);
		assert.deepEqual(store.thread(first.id), thread);
		assert.equal(launches, 1, "late events are not process-exit proof");
	}
	groupGone = true;
	child.exit(0);
	await tick();
	assert.equal(launches, 2, "proven late exit must pump queued work");
	assert.equal(store.get(second.id)?.status, TASK_STATUS.RUNNING);
	child.exit(0);
	await tick();
	assert.deepEqual(finishes, [first.id], "cleanup must not finish the quarantined task twice");
	assert.deepEqual(store.get(first.id), finished);
});
