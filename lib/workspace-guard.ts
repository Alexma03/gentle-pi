/**
 * Orca-bound workspace and command guard.
 *
 * The guard is deliberately independent from the provider runtime. It binds
 * one canonical Git worktree and rejects path/shell input that could escape
 * that binding. A caller may inspect a decision with checkPath/checkCommand or
 * fail closed with assertPath/assertCommand before crossing a runtime boundary.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	realpathSync,
	type Stats,
} from "node:fs";
import { homedir } from "node:os";
import {
	isAbsolute,
	join,
	parse,
	relative,
	resolve,
	sep,
} from "node:path";

export const WORKSPACE_GUARD_PROTOCOL_VERSION = 1 as const;

export type WorkspaceGuardCode =
	| "allowed"
	| "invalid-binding"
	| "invalid-path"
	| "invalid-command"
	| "outside-worktree"
	| "symlink"
	| "sensitive-path"
	| "ambiguous-command"
	| "destructive-command"
	| "ambiguous-push";

export interface WorkspaceBindingV1 {
	readonly cwd: string;
	readonly worktree: string;
	readonly commonDir: string;
	readonly repositoryId: string;
}

export interface WorkspaceGuardDecisionV1 {
	readonly allowed: boolean;
	readonly code: WorkspaceGuardCode;
	readonly reason?: string;
	readonly path?: string;
	readonly command?: string;
}

export interface WorkspaceGuardV1 {
	readonly binding: WorkspaceBindingV1;
	checkPath(path: string): WorkspaceGuardDecisionV1;
	assertPath(path: string): string;
	checkCommand(command: string): WorkspaceGuardDecisionV1;
	assertCommand(command: string): string;
}

export interface BindWorkspaceOptions {
	/** Allows focused tests to supply a read-only Git runner. */
	readonly runGit?: (cwd: string, args: readonly string[]) => string;
}

export class WorkspaceGuardError extends Error {
	readonly code: Exclude<WorkspaceGuardCode, "allowed">;
	readonly value?: string;

	constructor(code: Exclude<WorkspaceGuardCode, "allowed">, message: string, value?: string) {
		super(message);
		this.name = "WorkspaceGuardError";
		this.code = code;
		this.value = value;
	}
}

const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
	/(^|\/)\.ssh(?:\/|$)/i,
	/(^|\/)\.credentials?(?:\/|$)/i,
	/(^|\/)\.aws\/credentials$/i,
	/(^|\/)\.config\/gh\/hosts\.ya?ml$/i,
	/(^|\/)library\/keychains(?:\/|$)/i,
	/(^|\/)secrets?(?:\/|$)/i,
	/(^|\/)(?:credentials?|tokens?|passwords?)(?:\/|$)/i,
	/(^|\/)\.env(?:$|[.\/_-])/i,
	/(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys)$/i,
	/\.(?:pem|key|p12|pfx|kdbx)$/i,
];

const MAX_PATH_LENGTH = 16 * 1024;
const MAX_COMMAND_LENGTH = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePathText(value: string): string {
	return value
		.trim()
		.replaceAll("\\", "/")
		.replace(/^~(?=\/|$)/, homedir().replaceAll("\\", "/"))
		.replace(/\/+/g, "/");
}

/** Return true when a path names a conventional secret/key material location. */
export function isSensitiveWorkspacePath(value: string): boolean {
	if (typeof value !== "string") return true;
	const normalized = normalizePathText(value);
	return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export const isSensitivePath = isSensitiveWorkspacePath;

function pathInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function pathSegments(path: string): readonly string[] {
	const absolute = resolve(path);
	const root = parse(absolute).root;
	const rest = absolute.slice(root.length).split(sep).filter(Boolean);
	return [root, ...rest];
}

function assertNoSymlinkSegments(path: string, value = path): void {
	let current = pathSegments(path)[0] ?? parse(resolve(path)).root;
	for (const segment of pathSegments(path).slice(1)) {
		current = current === sep ? join(current, segment) : join(current, segment);
		let stats: Stats;
		try {
			stats = lstatSync(current);
		} catch (error) {
			const code = isRecord(error) ? error.code : undefined;
			if (code === "ENOENT" || code === "ENOTDIR") break;
			throw new WorkspaceGuardError("invalid-path", `Unable to inspect workspace path: ${value}.`, value);
		}
		if (stats.isSymbolicLink()) {
			throw new WorkspaceGuardError("symlink", `Workspace path contains a symlink or junction: ${value}.`, value);
		}
	}
}

function canonicalExistingPath(path: string, code: Exclude<WorkspaceGuardCode, "allowed">, value: string): string {
	try {
		return realpathSync(path);
	} catch {
		throw new WorkspaceGuardError(code, `Workspace path does not resolve: ${value}.`, value);
	}
}

function gitOutput(cwd: string, args: readonly string[]): string {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new WorkspaceGuardError("invalid-binding", `Git workspace binding failed: ${message}`);
	}
}

function resolveGitPath(cwd: string, value: string): string {
	const normalized = normalizePathText(value);
	return resolve(cwd, normalized);
}

function validateBinding(binding: WorkspaceBindingV1): WorkspaceBindingV1 {
	if (!binding || typeof binding !== "object") {
		throw new WorkspaceGuardError("invalid-binding", "Workspace binding must be an object.");
	}
	const bindingKeys = new Set(["cwd", "worktree", "commonDir", "repositoryId"]);
	if (Object.keys(binding).some((key) => !bindingKeys.has(key))) {
		throw new WorkspaceGuardError("invalid-binding", "Workspace binding contains unsupported fields.");
	}
	for (const name of bindingKeys) {
		const value = binding[name as keyof WorkspaceBindingV1];
		if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH || value.includes("\u0000")) {
			throw new WorkspaceGuardError("invalid-binding", `Workspace binding field '${name}' is malformed.`);
		}
	}
	assertNoSymlinkSegments(binding.cwd, binding.cwd);
	assertNoSymlinkSegments(binding.worktree, binding.worktree);
	assertNoSymlinkSegments(binding.commonDir, binding.commonDir);
	const cwd = canonicalExistingPath(binding.cwd, "invalid-binding", binding.cwd);
	const worktree = canonicalExistingPath(binding.worktree, "invalid-binding", binding.worktree);
	const commonDir = canonicalExistingPath(binding.commonDir, "invalid-binding", binding.commonDir);
	assertNoSymlinkSegments(cwd);
	assertNoSymlinkSegments(worktree);
	assertNoSymlinkSegments(commonDir);
	if (binding.repositoryId !== commonDir) throw new WorkspaceGuardError("invalid-binding", "Workspace repository identity must equal its canonical Git common directory.");
	if (!pathInside(worktree, cwd)) throw new WorkspaceGuardError("invalid-binding", "Workspace cwd is outside its bound worktree.");
	return Object.freeze({
		cwd,
		worktree,
		commonDir,
		repositoryId: binding.repositoryId,
	});
}

/** Bind exactly one existing, non-symlink Git worktree and its common dir. */
export function bindWorkspace(cwd: string, options: BindWorkspaceOptions = {}): WorkspaceBindingV1 {
	if (typeof cwd !== "string" || cwd.trim().length === 0 || cwd.length > MAX_PATH_LENGTH || cwd.includes("\u0000")) {
		throw new WorkspaceGuardError("invalid-binding", "Workspace cwd must be a bounded non-empty path.", cwd);
	}
	const requested = resolve(cwd);
	assertNoSymlinkSegments(requested, cwd);
	const canonicalCwd = canonicalExistingPath(requested, "invalid-binding", cwd);
	const runGit = options.runGit ?? gitOutput;
	const insideWorkTree = runGit(canonicalCwd, ["rev-parse", "--is-inside-work-tree"]);
	if (insideWorkTree !== "true") throw new WorkspaceGuardError("invalid-binding", "Workspace cwd is not inside a Git worktree.", cwd);
	const worktree = canonicalExistingPath(resolveGitPath(canonicalCwd, runGit(canonicalCwd, ["rev-parse", "--show-toplevel"])), "invalid-binding", cwd);
	const commonDir = canonicalExistingPath(resolveGitPath(canonicalCwd, runGit(canonicalCwd, ["rev-parse", "--git-common-dir"])), "invalid-binding", cwd);
	assertNoSymlinkSegments(worktree, worktree);
	assertNoSymlinkSegments(commonDir, commonDir);
	if (!pathInside(worktree, canonicalCwd)) throw new WorkspaceGuardError("invalid-binding", "Git resolved cwd outside the worktree.", cwd);
	return validateBinding({ cwd: canonicalCwd, worktree, commonDir, repositoryId: commonDir });
}

function decision(allowed: boolean, code: WorkspaceGuardCode, reason: string, extras: { path?: string; command?: string } = {}): WorkspaceGuardDecisionV1 {
	return {
		allowed,
		code,
		reason,
		...(extras.path === undefined ? {} : { path: extras.path }),
		...(extras.command === undefined ? {} : { command: extras.command }),
	};
}

function tokensForCommand(command: string): string[] | undefined {
	if (typeof command !== "string" || command.trim().length === 0 || command.length > MAX_COMMAND_LENGTH || command.includes("\u0000")) return undefined;
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	const push = () => {
		if (current.length > 0) {
			tokens.push(current);
			current = "";
		}
	};
	for (const char of command.trim()) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (quote === "'") {
			if (char === "'") quote = undefined;
			else current += char;
			continue;
		}
		if (quote === '"') {
			if (char === '"') quote = undefined;
			else if (char === "\\") escaped = true;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === ";" || char === "|" || char === "&" || char === "<" || char === ">" || char === "`" || char === "\n" || char === "\r" || char === "\t") {
			if (char === "\t") {
				push();
				continue;
			}
			return undefined;
		}
		if (char === "$" || char === "(") return undefined;
		if (/\s/.test(char)) push();
		else current += char;
	}
	if (quote !== undefined || escaped) return undefined;
	push();
	return tokens.length > 0 ? tokens : undefined;
}

function commandName(token: string): string {
	return token.replaceAll("\\", "/").split("/").pop() ?? token;
}

function looksLikePath(value: string): boolean {
	return isAbsolute(value) || value.startsWith("~") || value === "." || value === ".." || value.startsWith(`.${sep}`) || value.startsWith("./") || value.startsWith("../") || value.includes("/") || value.includes("\\");
}

function refNameValid(value: string): boolean {
	return value.length > 0
		&& value.length <= 512
		&& !/[\s\u0000*?]/.test(value)
		&& !value.includes("..")
		&& !value.includes("@{")
		&& !value.startsWith("/")
		&& !value.endsWith("/")
		&& !value.startsWith(".")
		&& !value.endsWith(".");
}

function refspecValid(value: string): boolean {
	if (!refNameValid(value) || value.startsWith("+")) return false;
	const pieces = value.split(":");
	if (pieces.length > 2 || pieces.some((piece) => piece.length === 0)) return false;
	return pieces.every((piece) => refNameValid(piece));
}

function gitSelectors(tokens: readonly string[], guardPath: (value: string) => WorkspaceGuardDecisionV1): WorkspaceGuardDecisionV1 | undefined {
	for (let index = 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token === "--") break;
		if (token === "-c") {
			const value = tokens[index + 1];
			if (!value) return decision(false, "ambiguous-command", "Git configuration selector is missing a value.");
			const equals = value.indexOf("=");
			const key = equals === -1 ? value : value.slice(0, equals);
			const configuredPath = equals === -1 ? undefined : value.slice(equals + 1);
			if ((key === "core.worktree" || key === "core.gitdir") && configuredPath !== undefined) {
				const checked = guardPath(configuredPath);
				if (!checked.allowed) return checked;
			}
			index += 1;
			continue;
		}
		if (token === "-C" || token === "--git-dir" || token === "--work-tree") {
			const value = tokens[index + 1];
			if (!value) return decision(false, "ambiguous-command", `Git selector ${token} is missing a path.`);
			const checked = guardPath(value);
			if (!checked.allowed) return checked;
			index += 1;
			continue;
		}
		if (token.startsWith("-C") && token.length > 2) {
			const checked = guardPath(token.slice(2));
			if (!checked.allowed) return checked;
			continue;
		}
		if (token.startsWith("-c") && token.length > 2) {
			const value = token.slice(2);
			const equals = value.indexOf("=");
			const key = equals === -1 ? value : value.slice(0, equals);
			const configuredPath = equals === -1 ? undefined : value.slice(equals + 1);
			if ((key === "core.worktree" || key === "core.gitdir") && configuredPath !== undefined) {
				const checked = guardPath(configuredPath);
				if (!checked.allowed) return checked;
			}
			continue;
		}
		for (const prefix of ["--git-dir=", "--work-tree="]) {
			if (token.startsWith(prefix)) {
				const checked = guardPath(token.slice(prefix.length));
				if (!checked.allowed) return checked;
			}
		}
	}
	return undefined;
}

function gitSubcommandIndex(tokens: readonly string[]): number {
	let index = 1;
	while (index < tokens.length) {
		const token = tokens[index];
		if (token === "--") return index + 1;
		if (token === "-C" || token === "--git-dir" || token === "--work-tree" || token === "-c") {
			index += 2;
			continue;
		}
		if (token.startsWith("-C") && token.length > 2) {
			index += 1;
			continue;
		}
		if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=") || token.startsWith("-c")) {
			index += 1;
			continue;
		}
		break;
	}
	return index;
}

const COMMAND_WRAPPERS = new Set(["env", "sudo", "command", "nice", "timeout", "nohup"]);

function unwrapCommand(tokens: readonly string[]): { tokens: readonly string[]; wrapped: boolean } {
	let index = 0;
	let wrapped = false;
	while (index < tokens.length && COMMAND_WRAPPERS.has(commandName(tokens[index] ?? ""))) {
		wrapped = true;
		const wrapper = commandName(tokens[index] ?? "");
		index += 1;
		if (wrapper === "env") {
			while (index < tokens.length) {
				const token = tokens[index];
				if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
					index += 1;
					continue;
				}
				if (token === "-i" || token === "--ignore-environment") {
					index += 1;
					continue;
				}
				if (token === "-u" || token === "--unset") {
					index += 2;
					continue;
				}
				if (token.startsWith("--unset=")) {
					index += 1;
					continue;
				}
				break;
			}
			continue;
		}
		if (wrapper === "sudo") {
			while (index < tokens.length && tokens[index]?.startsWith("-")) index += 1;
			continue;
		}
		if (wrapper === "command") {
			while (index < tokens.length && (tokens[index] === "-p" || tokens[index] === "-v" || tokens[index] === "-V")) index += 1;
			continue;
		}
		if (wrapper === "nice") {
			if (tokens[index] === "-n") index += 2;
			continue;
		}
		if (wrapper === "timeout") {
			while (index < tokens.length && tokens[index]?.startsWith("-")) index += 1;
			if (index < tokens.length) index += 1;
			continue;
		}
		// nohup has no wrapper-specific operands.
	}
	return { tokens: tokens.slice(index), wrapped };
}

function pushDecision(tokens: readonly string[], pushIndex: number): WorkspaceGuardDecisionV1 {
	const args = tokens.slice(pushIndex + 1);
	if (args.length === 0) return decision(true, "allowed", "Tracking push uses the bound repository.");
	const positionals: string[] = [];
	for (const arg of args) {
		if (arg === "-u" || arg === "--set-upstream") continue;
		if (arg === "--force" || arg === "--force-with-lease" || arg.startsWith("--force=") || arg.startsWith("--force-with-lease=") || arg === "--mirror" || arg === "--all" || arg === "--tags" || arg === "--delete" || arg.startsWith("--delete=") || arg === "-d" || arg === "--prune" || /^-[^-]*f/.test(arg)) {
			return decision(false, "destructive-command", `Destructive or force push form is denied: ${arg}.`);
		}
		if (arg.startsWith("-")) return decision(false, "ambiguous-push", `Unsupported push option is denied: ${arg}.`);
		positionals.push(arg);
	}
	if (positionals.length !== 2) return decision(false, "ambiguous-push", "Push requires an explicit remote and one refspec.");
	const [remote, refspec] = positionals;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(remote) || remote === ".") return decision(false, "ambiguous-push", "Push remote is ambiguous.");
	if (refspec.startsWith("+") || refspec.endsWith(":") || !refspecValid(refspec)) return decision(false, "destructive-command", "Force, wildcard, or deletion refspecs are denied.");
	return decision(true, "allowed", "Explicit guarded push refspec.");
}

function destructiveCommand(tokens: readonly string[]): WorkspaceGuardDecisionV1 | undefined {
	const name = commandName(tokens[0] ?? "");
	const args = tokens.slice(1);
	if (name === "rm") {
		return decision(false, "destructive-command", "File deletion is denied.");
	}
	if (name === "chmod" || name === "chown" || name === "dd" || name === "mkfs" || name === "shred") return decision(false, "destructive-command", `Destructive command '${name}' is denied.`);
	if (name === "git") {
		const commandIndex = gitSubcommandIndex(tokens);
		const subcommand = tokens[commandIndex];
		if (subcommand === "reset" && tokens.slice(commandIndex + 1).includes("--hard")) return decision(false, "destructive-command", "git reset --hard is denied.");
		if (subcommand === "clean" && tokens.slice(commandIndex + 1).some((arg) => arg === "-f" || arg === "--force" || arg.includes("f") || arg === "-d" || arg === "--directories")) return decision(false, "destructive-command", "Forced git clean is denied.");
	}
	return undefined;
}

export class WorkspaceGuard implements WorkspaceGuardV1 {
	readonly binding: WorkspaceBindingV1;

	constructor(binding: WorkspaceBindingV1) {
		this.binding = validateBinding(binding);
	}

	private isNestedRepository(candidate: string): boolean {
		let current = candidate;
		while (pathInside(this.binding.worktree, current) && current !== this.binding.worktree) {
			try {
				const marker = lstatSync(join(current, ".git"));
				if (marker.isDirectory() || marker.isFile()) return true;
			} catch {
				// A missing marker is ordinary while walking a path toward the root.
			}
			const parent = resolve(current, "..");
			if (parent === current) break;
			current = parent;
		}
		return false;
	}

	private resolveCandidatePath(value: string): string {
		if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH || value.includes("\u0000")) throw new WorkspaceGuardError("invalid-path", "Workspace path is malformed.", value);
		return resolve(this.binding.cwd, normalizePathText(value));
	}

	checkPath(value: string): WorkspaceGuardDecisionV1 {
		let candidate: string;
		try {
			candidate = this.resolveCandidatePath(value);
		} catch (error) {
			if (error instanceof WorkspaceGuardError) return decision(false, error.code, error.message, { path: value });
			return decision(false, "invalid-path", "Workspace path is malformed.", { path: value });
		}
		if (isSensitiveWorkspacePath(value)) return decision(false, "sensitive-path", `Sensitive workspace path is denied: ${value}.`, { path: candidate });
		try {
			assertNoSymlinkSegments(candidate, value);
		} catch (error) {
			if (error instanceof WorkspaceGuardError) return decision(false, error.code, error.message, { path: value });
			return decision(false, "symlink", `Workspace path contains a symlink: ${value}.`, { path: value });
		}
		if (!pathInside(this.binding.worktree, candidate)) return decision(false, "outside-worktree", `Workspace path escapes the bound worktree: ${value}.`, { path: candidate });
		if (this.isNestedRepository(candidate)) return decision(false, "outside-worktree", `Workspace path enters another repository or worktree: ${value}.`, { path: candidate });
		if (existsSync(candidate)) {
			try {
				const canonical = realpathSync(candidate);
				if (!pathInside(this.binding.worktree, canonical)) return decision(false, "outside-worktree", `Workspace path resolves outside the bound worktree: ${value}.`, { path: canonical });
			} catch {
				return decision(false, "invalid-path", `Workspace path does not resolve: ${value}.`, { path: candidate });
			}
		}
		return decision(true, "allowed", "Path is inside the bound worktree.", { path: candidate });
	}

	assertPath(value: string): string {
		const checked = this.checkPath(value);
		if (!checked.allowed || checked.path === undefined) throw new WorkspaceGuardError(checked.code as Exclude<WorkspaceGuardCode, "allowed">, checked.reason ?? "Workspace path denied.", value);
		return checked.path;
	}

	guardPath(value: string): string {
		return this.assertPath(value);
	}

	resolvePath(value: string): string {
		return this.assertPath(value);
	}

	checkCommand(command: string): WorkspaceGuardDecisionV1 {
		const tokens = tokensForCommand(command);
		if (!tokens) return decision(false, "ambiguous-command", "Shell composition, expansion, or malformed quoting is denied.", { command });
		const unwrapped = unwrapCommand(tokens);
		const inspectedTokens = unwrapped.tokens.length > 0 ? unwrapped.tokens : tokens;
		const destructive = destructiveCommand(inspectedTokens);
		if (destructive) return { ...destructive, command };
		const name = commandName(inspectedTokens[0] ?? "");
		const guardPath = (value: string) => this.checkPath(value);
		if (name === "git") {
			const selector = gitSelectors(inspectedTokens, guardPath);
			if (selector && !selector.allowed) return { ...selector, command };
			const commandIndex = gitSubcommandIndex(inspectedTokens);
			if (inspectedTokens[commandIndex] === "push") {
				const push = pushDecision(inspectedTokens, commandIndex);
				return unwrapped.wrapped && push.allowed
					? decision(false, "ambiguous-command", "Wrapped pushes are denied; invoke an explicitly guarded push directly.", { command })
					: { ...push, command };
			}
		}
		for (const token of inspectedTokens.slice(1)) {
			if (isSensitiveWorkspacePath(token)) return { ...decision(false, "sensitive-path", `Sensitive workspace path is denied: ${token}.`, { path: token }), command };
			if (!looksLikePath(token) || token.startsWith("-")) continue;
			const checked = this.checkPath(token);
			if (!checked.allowed) return { ...checked, command };
		}
		if (unwrapped.wrapped) return decision(false, "ambiguous-command", "Wrapped commands are denied; invoke an explicitly guarded command directly.", { command });
		return decision(true, "allowed", "Command stays within the bound workspace.", { command });
	}

	assertCommand(command: string): string {
		const checked = this.checkCommand(command);
		if (!checked.allowed) throw new WorkspaceGuardError(checked.code as Exclude<WorkspaceGuardCode, "allowed">, checked.reason ?? "Command denied.", command);
		return command;
	}

	guardCommand(command: string): string {
		return this.assertCommand(command);
	}
}

export function createWorkspaceGuard(binding: WorkspaceBindingV1): WorkspaceGuard {
	return new WorkspaceGuard(binding);
}

export const WorkspaceGuardV1Impl = WorkspaceGuard;
export type WorkspaceBinding = WorkspaceBindingV1;
export type WorkspaceGuardDecision = WorkspaceGuardDecisionV1;
