import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

// Ordinary delegation uses the provider-neutral gentle_subagent tool. The
// legacy provider-specific subagent_run hook remains reserved for native
// review candidate-view injection and must not inspect or mutate writer
// payloads. This regression test keeps that boundary explicit.

type ToolCallHandler = (
	event: { toolName: string; input: unknown },
	ctx: ExtensionContext,
) => Promise<{ block: true; reason: string } | undefined>;

const scratchRoots: string[] = [];

after(() => {
	for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

async function dispatchLegacyDelegation(input: Record<string, unknown>): Promise<unknown> {
	const handlers = new Map<string, ToolCallHandler>();
	const pi = {
		on(name: string, handler: ToolCallHandler) {
			handlers.set(name, handler);
		},
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, subagentRuntime: null })(pi);
	const toolCall = handlers.get("tool_call");
	assert.equal(typeof toolCall, "function");
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-writer-surfaces-"));
	scratchRoots.push(cwd);
	return toolCall!({ toolName: "subagent_run", input }, {
		cwd,
		hasUI: false,
		ui: { confirm: async () => true },
	} as ExtensionContext);
}

test("legacy writer delegation is not intercepted or payload-mutated", async () => {
	const inputs = [
		{
			agent: "gentle-ai-worker",
			mode: "task",
			task: "Fix the decoder.",
		},
		{
			agent: "worker",
			mode: "task",
			task: [
				"## Allowed edit surfaces",
				"- `/etc/passwd`",
				"- `../other-repo/lib/a.ts`",
			].join("\n"),
		},
		{
			agent: "gentle-ai-worker",
			mode: "task",
			task: "Fix the decoder.",
			context: "## Allowed edit surfaces\n- `lib/sdd-status.ts`",
		},
	];
	for (const input of inputs) {
		assert.equal(await dispatchLegacyDelegation(input), undefined);
	}
});

test("non-review subagent_run inputs remain outside the review boundary", async () => {
	const result = await dispatchLegacyDelegation({
		agent: "gentle-ai-explore",
		mode: "task",
		task: "Map the decoder call sites.",
	});
	assert.equal(result, undefined);
});
