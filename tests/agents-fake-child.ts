import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildLike } from "../lib/agents-runner.ts";

// A fake `pi --mode rpc` child: answers every command with a success
// response, records what the host wrote, and lets tests emit events.

export interface FakeChild {
	child: ChildLike;
	written: Array<Record<string, unknown>>;
	emit(event: Record<string, unknown>): void;
	exit(code: number | null, signal?: NodeJS.Signals): void;
	fail(message: string): void;
	killed: string[];
	sent: Array<Record<string, unknown>>;
	disconnects: number;
	message(event: Record<string, unknown>): void;
}

export function fakeChild(options: { exitOnKill?: boolean; pid?: number } = {}): FakeChild {
	const emitter = new EventEmitter();
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const written: Array<Record<string, unknown>> = [];
	const killed: string[] = [];
	const sent: Array<Record<string, unknown>> = [];
	let disconnects = 0;
	let buffer = "";
	stdin.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			const command = JSON.parse(line) as Record<string, unknown>;
			written.push(command);
			if (command.type === "extension_ui_response") continue;
			const data = command.type === "get_state" ? { sessionFile: "/sessions/child.jsonl" } : undefined;
			stdout.write(`${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data })}\n`);
		}
	});
	const stderr = new PassThrough();
	const exit = (code: number | null, signal: NodeJS.Signals | null = null) => {
		stderr.end();
		emitter.emit("exit", code, signal);
	};
	const child: ChildLike = {
		pid: options.pid,
		stdin,
		stdout,
		stderr,
		kill: (signal) => {
			killed.push(String(signal ?? "SIGTERM"));
			if (options.exitOnKill !== false) queueMicrotask(() => exit(null, signal ?? "SIGTERM"));
			return true;
		},
		send: (message, callback) => {
			sent.push(message);
			callback?.(null);
			return true;
		},
		disconnect: () => {
			disconnects += 1;
			emitter.emit("disconnect");
		},
		on: (event, listener) => {
			emitter.on(event, listener);
			return child;
		},
	};
	return { child, written, killed, sent, get disconnects() { return disconnects; }, message: (event) => emitter.emit("message", event), emit: (event) => stdout.write(`${JSON.stringify(event)}\n`), exit, fail: (message) => emitter.emit("error", new Error(message)) };
}
