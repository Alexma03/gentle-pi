import { Text } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./terminal-theme.ts";

type GentleAiLifecycleColor = "warning" | "success" | "error" | "dim";

export interface GentleAiRenderTheme {
	bold(value: string): string;
	fg(color: GentleAiLifecycleColor, value: string): string;
}

export interface GentleAiRenderContext {
	executionStarted?: boolean;
	isPartial?: boolean;
	isError?: boolean;
	lastComponent?: unknown;
}

export function renderGentleAiLifecycleCall(
	operationPath: string,
	theme: GentleAiRenderTheme,
	context?: GentleAiRenderContext,
	auditInvocation?: string,
): Text {
	const status = context?.isError
		? "failed"
		: !context?.executionStarted || context.isPartial
			? "running"
			: "completed";
	const color = status === "running" ? "warning" : status === "completed" ? "success" : "error";
	const lines = [
		theme.fg(color, theme.bold(`🌹︎ Gentle AI · ${status} · ${operationPath}`)),
	];
	if (auditInvocation !== undefined) {
		lines.push(theme.fg("dim", `audit: ${sanitizeTerminalText(auditInvocation)}`));
	}
	const component = context?.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	component.setText(lines.join("\n"));
	return component;
}
