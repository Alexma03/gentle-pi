import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { acquireTaskLock, historyDir, loadHistory, loadStoredTask, pruneHistory, saveTask, taskLockPath } from "../lib/agents-history.ts";
import { applyTaskEvent, emptyThread, TASK_EVENT, TASK_STATUS, TaskStore, type TaskRecord } from "../lib/agents-protocol.ts";

// Gentle Agents history: JSON per task, async, lazy, pruned by count.

const root = mkdtempSync(join(tmpdir(), "gentle-agents-history-"));
after(() => rmSync(root, { recursive: true, force: true }));
const dir = join(root, "tasks");

function orphanLock(lockDir: string, id: string): void {
	const moduleUrl = new URL("../lib/agents-history.ts", import.meta.url).href;
	const source = `import { acquireTaskLock } from ${JSON.stringify(moduleUrl)}; const [dir, id] = process.argv.slice(-2); acquireTaskLock(dir, id);`;
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source, lockDir, id], { encoding: "utf8" });
	assert.equal(child.status, 0, child.stderr || child.stdout);
}

function task(id: string, createdAt: number): TaskRecord {
	return { id, agent: "explore", mode: "task", prompt: "p", label: "p", cwd: "/r", parentSessionId: "s", status: TASK_STATUS.COMPLETED, createdAt, startedAt: createdAt, endedAt: createdAt + 5, model: "m", thinking: undefined, sessionPath: null, error: null, result: "ok", lastStep: "done", lastActivityAt: createdAt, turns: 1, toolCalls: 0, tokens: 10, cost: 0.01 };
}

test("historyDir follows an isolated agent profile while explicit homes retain the default fallback", () => {
	assert.equal(historyDir("/home/x", "/profiles/pi-principal/agent"), join("/profiles/pi-principal/agent", "gentle-agents", "tasks"));
	assert.equal(historyDir("/home/x", "/profiles/pi-lab/agent"), join("/profiles/pi-lab/agent", "gentle-agents", "tasks"));
	assert.equal(historyDir("/home/x"), join("/home/x", ".pi", "agent", "gentle-agents", "tasks"));
});

test("saveTask writes a task with its thread and loadStoredTask reads it back", async () => {
	const thread = applyTaskEvent(emptyThread(), { type: TASK_EVENT.TEXT, text: "hello" });
	await saveTask(dir, task("a1", 1000), thread);
	const stored = await loadStoredTask(dir, "a1");
	assert.equal(stored?.task.result, "ok");
	assert.deepEqual(stored?.thread.items, [{ kind: "text", text: "hello" }]);
	assert.equal(await loadStoredTask(dir, "missing"), undefined);
	assert.equal(await loadStoredTask(dir, "../etc/passwd"), undefined);
	assert.deepEqual(readdirSync(dir), ["a1.json"], "no temp file is left behind");
});

test("task reconciliation locks are busy, reclaim only a dead owner, and fail closed for malformed or foreign state", () => {
	const lockDir = join(root, "task-locks");
	const held = acquireTaskLock(lockDir, "busy");
	assert.throws(() => acquireTaskLock(lockDir, "busy"), /busy|active|ambiguous/i);
	held.release();
	orphanLock(lockDir, "dead"); const fence = `${taskLockPath(lockDir, "dead")}.reclaim`; writeFileSync(fence, "foreign");
	assert.throws(() => acquireTaskLock(lockDir, "dead"), /reclaim fence is present/); rmSync(fence);
	const reclaimed = acquireTaskLock(lockDir, "dead"); reclaimed.release();
	const malformed = taskLockPath(lockDir, "malformed");
	writeFileSync(malformed, "not-json");
	assert.throws(() => acquireTaskLock(lockDir, "malformed"), /busy|active|ambiguous|malformed/i);
	orphanLock(lockDir, "foreign");
	const foreign = taskLockPath(lockDir, "foreign");
	const owner = JSON.parse(readFileSync(foreign, "utf8")) as Record<string, unknown>;
	writeFileSync(foreign, JSON.stringify({ ...owner, host: "foreign-host" }));
	assert.throws(() => acquireTaskLock(lockDir, "foreign"), /busy|active|ambiguous|foreign/i);
});
test("loadHistory skips broken files, sorts newest first, and pruneHistory keeps the newest N", async () => {
	await saveTask(dir, task("b2", 3000), emptyThread());
	await saveTask(dir, task("c3", 2000), emptyThread());
	writeFileSync(join(dir, "junk.json"), "{not json");
	writeFileSync(join(dir, "shape.json"), JSON.stringify({ task: { id: 1 } }));
	assert.deepEqual((await loadHistory(dir)).map((entry) => entry.task.id), ["b2", "c3", "a1"]);
	assert.equal(await pruneHistory(dir, 2), 1);
	assert.deepEqual((await loadHistory(dir)).map((entry) => entry.task.id), ["b2", "c3"]);
	assert.deepEqual(await loadHistory(join(root, "nowhere")), []);
});

test("TaskStore.restore adds a stored task without clobbering a live one", () => {
	const store = new TaskStore();
	const thread = applyTaskEvent(emptyThread(), { type: TASK_EVENT.NOTE, text: "restored" });
	assert.equal(store.restore(task("r1", 1000), thread), true);
	assert.equal(store.thread("r1").items.length, 1);
	assert.equal(store.restore({ ...task("r1", 1000), result: "other" }, emptyThread()), false);
	assert.equal(store.get("r1")?.result, "ok");
});
