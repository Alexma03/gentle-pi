import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	WorkspaceGuardError,
	bindWorkspace,
	createWorkspaceGuard,
	isSensitiveWorkspacePath,
} from "../lib/workspace-guard.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function fixture(): { root: string; nested: string; outside: string } {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-guard-"));
	mkdirSync(join(root, "packages", "app"), { recursive: true });
	writeFileSync(join(root, "README.md"), "fixture\n");
	git(root, "init", "--quiet");
	const outside = mkdtempSync(join(tmpdir(), "gentle-pi-outside-"));
	return { root, nested: join(root, "packages", "app"), outside };
}

test("workspace binding canonicalizes nested cwd and confines local paths", () => {
	const { root, nested } = fixture();
	const binding = bindWorkspace(nested);
	assert.equal(binding.cwd, resolve(nested));
	assert.equal(binding.worktree, resolve(root));
	assert.equal(binding.commonDir, resolve(root, ".git"));
	assert.equal(binding.repositoryId, binding.commonDir);

	const guard = createWorkspaceGuard(binding);
	assert.equal(guard.checkPath("src/index.ts").allowed, true);
	assert.equal(guard.checkPath("../../../../outside.txt").allowed, false);
	assert.throws(() => guard.assertPath("../../../../outside.txt"), WorkspaceGuardError);
});

test("workspace guard rejects symlink escapes without rebinding", () => {
	const { root, nested, outside } = fixture();
	writeFileSync(join(outside, "secret.txt"), "secret\n");
	symlinkSync(outside, join(root, "linked-outside"), "dir");
	const binding = bindWorkspace(nested);
	const guard = createWorkspaceGuard(binding);
	const result = guard.checkPath("../../linked-outside/secret.txt");
	assert.equal(result.allowed, false);
	assert.equal(result.code, "symlink");
	assert.equal(guard.binding.worktree, resolve(root));
});

test("workspace guard rejects sensitive paths", () => {
	const { nested } = fixture();
	const guard = createWorkspaceGuard(bindWorkspace(nested));
	for (const path of [".env", ".ssh/id_rsa", "config/client.pem", ".aws/credentials", "secrets/token"]) {
		assert.equal(isSensitiveWorkspacePath(path), true, path);
		assert.equal(guard.checkPath(path).code, "sensitive-path", path);
	}
});

test("workspace guard validates git selectors and denies shell composition", () => {
	const { root, nested, outside } = fixture();
	const guard = createWorkspaceGuard(bindWorkspace(nested));
	assert.equal(guard.checkCommand(`git -C ${root} status --short`).allowed, true);
	assert.equal(guard.checkCommand(`git -C ${outside} status --short`).code, "outside-worktree");
	assert.equal(guard.checkCommand(`git -c core.pager=cat -C ${outside} status --short`).code, "outside-worktree");
	assert.equal(guard.checkCommand(`cat ${outside}/secret.txt`).code, "outside-worktree");
	assert.equal(guard.checkCommand("git status; cat ~/.ssh/id_rsa").code, "ambiguous-command");
});

test("workspace guard allows tracking, first-push, and explicit refspec forms", () => {
	const { nested } = fixture();
	const guard = createWorkspaceGuard(bindWorkspace(nested));
	for (const command of [
		"git push",
		"git push origin feature/runtime",
		"git push --set-upstream origin feature/runtime",
		"git push origin HEAD:refs/heads/feature/runtime",
		"git push origin refs/heads/feature/runtime:refs/heads/feature/runtime",
	]) {
		assert.equal(guard.checkCommand(command).allowed, true, command);
	}
});

test("workspace guard denies destructive and ambiguous push forms", () => {
	const { nested } = fixture();
	const guard = createWorkspaceGuard(bindWorkspace(nested));
	for (const [command, code] of [
		["git push --force origin feature/runtime", "destructive-command"],
		["git push --force-with-lease origin feature/runtime", "destructive-command"],
		["git push --force-with-lease=feature/runtime origin feature/other", "destructive-command"],
		["git push --delete origin feature/runtime", "destructive-command"],
		["git push --all origin", "destructive-command"],
		["git push origin", "ambiguous-push"],
		["git push origin feature/runtime feature/other", "ambiguous-push"],
		["git push origin +HEAD:refs/heads/feature/runtime", "destructive-command"],
	] as const) {
		assert.equal(guard.checkCommand(command).allowed, false, command);
		assert.equal(guard.checkCommand(command).code, code, command);
	}
});

test("workspace guard fails closed for wrapped commands, bare sensitive files, and attached selectors", () => {
	const { nested, outside } = fixture();
	const guard = createWorkspaceGuard(bindWorkspace(nested));
	for (const [command, code] of [
		["cat .env", "sensitive-path"],
		["env rm -rf ./src", "destructive-command"],
		["sudo git reset --hard", "destructive-command"],
		[`env git --work-tree=${outside} status`, "outside-worktree"],
		[`git -C${outside} status`, "outside-worktree"],
		["env git push", "ambiguous-command"],
	] as const) {
		const result = guard.checkCommand(command);
		assert.equal(result.allowed, false, command);
		assert.equal(result.code, code, command);
	}
});

test("workspace guard rejects a nested repository instead of treating it as the bound worktree", () => {
	const { root, nested } = fixture();
	const nestedRepo = join(root, "nested-repo");
	mkdirSync(nestedRepo, { recursive: true });
	git(nestedRepo, "init", "--quiet");
	const guard = createWorkspaceGuard(bindWorkspace(nested));
	assert.equal(guard.checkPath("../../nested-repo/file.ts").allowed, false);
	assert.equal(guard.checkPath("../../nested-repo/file.ts").code, "outside-worktree");
});

test("workspace binding rejects a symlinked cwd before Git identity is read", () => {
	const { root, outside } = fixture();
	const symlinkedCwd = join(outside, "repo-link");
	symlinkSync(root, symlinkedCwd, "dir");
	assert.throws(() => bindWorkspace(symlinkedCwd), WorkspaceGuardError);
});

test("workspace guard rejects a binding whose declared cwd is symlinked", () => {
	const { root, nested, outside } = fixture();
	const symlinkedCwd = join(outside, "nested-link");
	symlinkSync(nested, symlinkedCwd, "dir");
	assert.throws(() => createWorkspaceGuard({
		cwd: symlinkedCwd,
		worktree: root,
		commonDir: join(root, ".git"),
		repositoryId: join(root, ".git"),
	}), WorkspaceGuardError);
});

test("workspace guard rejects a binding with a mismatched repository identity", () => {
	const { root, nested } = fixture();
	assert.throws(() => createWorkspaceGuard({
		cwd: nested,
		worktree: root,
		commonDir: join(root, ".git"),
		repositoryId: join(root, "other.git"),
	}), WorkspaceGuardError);
});
