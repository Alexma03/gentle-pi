import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	COMMIT_TRANSACTION_STATE,
	assertNoUnresolvedCommitTransaction,
	abandonCommitTransaction,
	inspectCommitTransaction,
	prepareCommitTransactionInvocation,
	reconcileCommitTransaction,
	runGitCommitTransaction,
	verifyCommitTransactionResult,
} from "../lib/git-commit-transaction.ts";
import type { CommitTransactionInvocation } from "../lib/git-commit-transaction.ts";
import type { NativeReviewCli, NativeValidateResult } from "../lib/native-review-cli.ts";

function git(cwd: string, ...arguments_: string[]): string {
	return execFileSync("git", arguments_, { cwd, encoding: "utf8" }).trim();
}

function repository(t: test.TestContext): string {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-commit-transaction-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	git(cwd, "init", "-b", "main");
	git(cwd, "config", "user.name", "Commit Transaction Test");
	git(cwd, "config", "user.email", "commit-transaction@example.invalid");
	writeFileSync(join(cwd, "tracked.txt"), "base\n");
	git(cwd, "add", "tracked.txt");
	git(cwd, "commit", "-m", "base");
	return cwd;
}

function installHook(cwd: string, name: string, body: string): void {
	const hooks = git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "hooks");
	mkdirSync(hooks, { recursive: true });
	const path = join(hooks, name);
	writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
	chmodSync(path, 0o700);
}

function stage(cwd: string, content = "candidate\n"): string {
	writeFileSync(join(cwd, "tracked.txt"), content);
	git(cwd, "add", "tracked.txt");
	return git(cwd, "write-tree");
}

function invocation(cwd: string, lineageId: string, arguments_: readonly string[] = ["-m", "candidate"]) {
	const intendedTree = git(cwd, "write-tree");
	const command = `git commit ${arguments_.map((value) => JSON.stringify(value)).join(" ")}`;
	return prepareCommitTransactionInvocation({
		command,
		cwd,
		arguments: arguments_,
		authorization: {
			lineageId,
			storeRevision: "sha256:" + "a".repeat(64),
			fingerprint: "sha256:" + "b".repeat(64),
			intendedTree,
		},
	});
}

function native(cwd: string, lineageId: string, result: NativeValidateResult["result"] = "allow"): NativeReviewCli {
	return {
		async validate(request) {
			const tree = git(cwd, "write-tree");
			return {
				allowed: result === "allow",
				result,
				action: result === "allow" ? "continue" : result === "scope-changed" ? "create-new-lineage" : "explicit-maintainer-action",
				reason: result === "allow" ? "receipt allows exact tree" : "post-hook tree differs from receipt",
				gateContext: {
					lineageId,
					storeRevision: "sha256:" + "c".repeat(64),
					raw: { gate: request.gate, lineage_id: lineageId, candidate_tree: tree },
				},
			};
		},
	} as NativeReviewCli;
}

test("a non-mutating pre-commit hook runs once and HEAD proves the native-authorized tree", async (t) => {
	const cwd = repository(t);
	stage(cwd);
	const count = join(cwd, ".git", "hook-count");
	installHook(cwd, "pre-commit", `printf '1\\n' >> ${JSON.stringify(count)}`);
	const before = git(cwd, "rev-parse", "HEAD");
	const result = await runGitCommitTransaction(invocation(cwd, "non-mutating"), { nativeReviewCli: native(cwd, "non-mutating") });
	assert.notEqual(result.head, before);
	assert.equal(result.tree, git(cwd, "rev-parse", "HEAD^{tree}"));
	assert.equal(readFileSync(count, "utf8"), "1\n");
	assert.deepEqual(inspectCommitTransaction(cwd), { status: "clean" });
});

test("a mutating hook creates no commit until the post-hook tree is reviewed, then exact retry skips the hook", async (t) => {
	const cwd = repository(t);
	stage(cwd, "unformatted\n");
	const count = join(cwd, ".git", "hook-count");
	installHook(cwd, "pre-commit", `printf 'formatted\\n' > tracked.txt\ngit add tracked.txt\nprintf '1\\n' >> ${JSON.stringify(count)}`);
	const before = git(cwd, "rev-parse", "HEAD");
	await assert.rejects(
		runGitCommitTransaction(invocation(cwd, "before-format"), { nativeReviewCli: native(cwd, "before-format", "scope-changed") }),
		/not the authorized tree/,
	);
	assert.equal(git(cwd, "rev-parse", "HEAD"), before);
	assert.equal(inspectCommitTransaction(cwd).record?.state, COMMIT_TRANSACTION_STATE.AWAITING_REVIEW);
	assert.throws(() => assertNoUnresolvedCommitTransaction(cwd), /publication is blocked/);
	const result = await runGitCommitTransaction(invocation(cwd, "after-format"), { nativeReviewCli: native(cwd, "after-format") });
	assert.equal(result.tree, git(cwd, "rev-parse", "HEAD^{tree}"));
	assert.equal(readFileSync(count, "utf8"), "1\n");
});

test("a failing pre-commit hook creates no commit and leaves explicit recovery state", async (t) => {
	const cwd = repository(t);
	stage(cwd);
	installHook(cwd, "pre-commit", "exit 23");
	const before = git(cwd, "rev-parse", "HEAD");
	await assert.rejects(runGitCommitTransaction(invocation(cwd, "hook-failure"), { nativeReviewCli: native(cwd, "hook-failure") }), /hook failed/);
	assert.equal(git(cwd, "rev-parse", "HEAD"), before);
	assert.equal(inspectCommitTransaction(cwd).record?.state, COMMIT_TRANSACTION_STATE.HOOK_FAILED);
	assert.match(inspectCommitTransaction(cwd).record?.error ?? "", /exit 23/);
});

test("a native scope-changed denial on the unmutated authorized tree awaits explicit review", async (t) => {
	const cwd = repository(t);
	const authorizedTree = stage(cwd);
	const before = git(cwd, "rev-parse", "HEAD");
	let validations = 0;
	const denying = native(cwd, "scope-changed-denial", "scope-changed");
	const counting = {
		async validate(request) {
			validations += 1;
			return denying.validate(request);
		},
	} as NativeReviewCli;
	await assert.rejects(
		runGitCommitTransaction(invocation(cwd, "scope-changed-denial"), { nativeReviewCli: counting }),
		/native pre-commit validation denied the post-hook tree: scope-changed/,
	);
	assert.equal(validations, 1, "the unmutated tree must pass the mutation guard and reach native validation");
	assert.equal(git(cwd, "rev-parse", "HEAD"), before);
	assert.equal(git(cwd, "write-tree"), authorizedTree, "the denied index stays exactly as authorized");
	const inspection = inspectCommitTransaction(cwd);
	assert.equal(inspection.record?.state, COMMIT_TRANSACTION_STATE.AWAITING_REVIEW);
	assert.equal(inspection.record?.error, "post-hook tree differs from receipt");
	assert.equal(typeof inspection.record?.native_result, "object", "the native denial must be recorded on the transaction");
});

test("a non-scope-changed native denial fails validation and requires explicit recovery", async (t) => {
	const cwd = repository(t);
	stage(cwd);
	const before = git(cwd, "rev-parse", "HEAD");
	await assert.rejects(
		runGitCommitTransaction(invocation(cwd, "invalidated-denial"), { nativeReviewCli: native(cwd, "invalidated-denial", "invalidated") }),
		/native pre-commit validation denied the post-hook tree: invalidated/,
	);
	assert.equal(git(cwd, "rev-parse", "HEAD"), before);
	assert.equal(inspectCommitTransaction(cwd).record?.state, COMMIT_TRANSACTION_STATE.VALIDATION_FAILED);
	await assert.rejects(
		runGitCommitTransaction(invocation(cwd, "invalidated-denial"), { nativeReviewCli: native(cwd, "invalidated-denial") }),
		/requires explicit recovery from state validation-failed/,
	);
});

test("a mutating pre-commit hook fails closed even when native validation would allow the post-hook tree", async (t) => {
	const cwd = repository(t);
	const authorizedTree = stage(cwd, "unformatted\n");
	const count = join(cwd, ".git", "hook-count");
	installHook(cwd, "pre-commit", `printf 'formatted\\n' > tracked.txt\ngit add tracked.txt\nprintf '1\\n' >> ${JSON.stringify(count)}`);
	const before = git(cwd, "rev-parse", "HEAD");
	// The fake native CLI allows whatever tree the index holds, so the only
	// defense against committing the hook-mutated tree is the transaction's
	// own binding to the invocation's authorized tree.
	await assert.rejects(
		runGitCommitTransaction(invocation(cwd, "permissive-native"), { nativeReviewCli: native(cwd, "permissive-native") }),
		/pre-commit hook mutated the staged candidate/,
	);
	assert.equal(git(cwd, "rev-parse", "HEAD"), before, "no commit object may be created from the mutated index");
	assert.equal(readFileSync(count, "utf8"), "1\n", "the mutating hook must have run exactly once");
	assert.notEqual(git(cwd, "write-tree"), authorizedTree, "the mutated index is preserved for inspection");
	const inspection = inspectCommitTransaction(cwd);
	assert.equal(inspection.record?.state, COMMIT_TRANSACTION_STATE.AWAITING_REVIEW);
	assert.match(inspection.record?.error ?? "", /normalize sources and re-run review explicitly, or make the hook convergent/);
	assert.throws(() => assertNoUnresolvedCommitTransaction(cwd), /publication is blocked/);
});

test("a convergent pre-commit hook runs exactly once and commits the exact authorized tree", async (t) => {
	const cwd = repository(t);
	const authorizedTree = stage(cwd, "formatted\n");
	const count = join(cwd, ".git", "hook-count");
	installHook(cwd, "pre-commit", `printf 'formatted\\n' > tracked.txt\ngit add tracked.txt\nprintf '1\\n' >> ${JSON.stringify(count)}`);
	const before = git(cwd, "rev-parse", "HEAD");
	const result = await runGitCommitTransaction(invocation(cwd, "convergent"), { nativeReviewCli: native(cwd, "convergent") });
	assert.notEqual(result.head, before);
	assert.equal(result.tree, authorizedTree);
	assert.equal(git(cwd, "rev-parse", "HEAD^{tree}"), authorizedTree);
	assert.equal(readFileSync(count, "utf8"), "1\n", "the convergent hook must have run exactly once");
	assert.deepEqual(inspectCommitTransaction(cwd), { status: "clean" });
});

test("a repository with no hooks commits the authorized tree unchanged", async (t) => {
	const cwd = repository(t);
	const authorizedTree = stage(cwd);
	const before = git(cwd, "rev-parse", "HEAD");
	const result = await runGitCommitTransaction(invocation(cwd, "no-hooks"), { nativeReviewCli: native(cwd, "no-hooks") });
	assert.notEqual(result.head, before);
	assert.equal(result.tree, authorizedTree);
	assert.equal(git(cwd, "rev-parse", "HEAD^{tree}"), authorizedTree);
	assert.deepEqual(inspectCommitTransaction(cwd), { status: "clean" });
});

test("the Git-created HEAD tree is proven equal to the authorized tree on success", async (t) => {
	const cwd = repository(t);
	const authorizedTree = stage(cwd);
	const result = await runGitCommitTransaction(invocation(cwd, "head-proof"), { nativeReviewCli: native(cwd, "head-proof") });
	assert.equal(result.tree, authorizedTree);
	assert.equal(git(cwd, "rev-parse", "HEAD^{tree}"), authorizedTree);
	const verified = verifyCommitTransactionResult(cwd, result.transactionId);
	assert.deepEqual(verified, { transactionId: result.transactionId, status: "committed", head: result.head, tree: authorizedTree });
});

test("message hooks cannot change the index after native authorization", async (t) => {
	const cwd = repository(t);
	stage(cwd);
	installHook(cwd, "prepare-commit-msg", "printf 'late mutation\\n' > tracked.txt\ngit add tracked.txt");
	const before = git(cwd, "rev-parse", "HEAD");
	await assert.rejects(runGitCommitTransaction(invocation(cwd, "late-mutation"), { nativeReviewCli: native(cwd, "late-mutation") }), /Git commit failed/);
	assert.equal(git(cwd, "rev-parse", "HEAD"), before);
	assert.equal(inspectCommitTransaction(cwd).record?.state, COMMIT_TRANSACTION_STATE.COMMIT_FAILED);
});

test("amend and post-commit crash reconciliation preserve the exact authorized tree", async (t) => {
	const cwd = repository(t);
	const authorizedTree = stage(cwd, "amended\n");
	const amended = await runGitCommitTransaction(invocation(cwd, "amend", ["--amend", "--no-edit"]), { nativeReviewCli: native(cwd, "amend") });
	assert.equal(amended.tree, authorizedTree);
	stage(cwd, "after-crash\n");
	await assert.rejects(
		runGitCommitTransaction(invocation(cwd, "crash"), { nativeReviewCli: native(cwd, "crash"), failpoint: "after-commit-before-proof" }),
		/test interruption/,
	);
	assert.equal(inspectCommitTransaction(cwd).record?.state, COMMIT_TRANSACTION_STATE.COMMIT_RUNNING);
	assert.deepEqual(reconcileCommitTransaction(cwd), { status: "clean" });
	assert.deepEqual(inspectCommitTransaction(cwd), { status: "clean" });
});

test("a post-commit hook cannot replace the exact commit created by Git", async (t) => {
	const cwd = repository(t);
	stage(cwd, "intermediate\n");
	git(cwd, "commit", "-m", "intermediate");
	stage(cwd);
	installHook(cwd, "post-commit", [
		"original=$(git rev-parse HEAD)",
		"tree=$(git rev-parse HEAD^{tree})",
		"alternate_parent=$(git rev-parse HEAD~2)",
		"replacement=$(printf 'replacement\\n' | git commit-tree \"$tree\" -p \"$alternate_parent\")",
		"git update-ref HEAD \"$replacement\" \"$original\"",
	].join("\n"));
	await assert.rejects(
		runGitCommitTransaction(invocation(cwd, "post-commit-replacement"), { nativeReviewCli: native(cwd, "post-commit-replacement") }),
		/different commit|identity changed/,
	);
	assert.equal(inspectCommitTransaction(cwd).record?.state, COMMIT_TRANSACTION_STATE.INCIDENT);
});

test("cancellation cannot strand a commit after HEAD advances", async (t) => {
	const cwd = repository(t);
	stage(cwd);
	// Deterministic cancellation ordering (issue #178): a wall-clock
	// AbortSignal.timeout raced Git's own progress on loaded CI runners and
	// could abort before HEAD advanced. Git only runs the post-commit hook
	// after the commit object exists and HEAD has advanced, so the hook
	// reports that it started and then blocks until the test releases it.
	// Aborting between those two events guarantees the cancellation lands
	// while the commit process is still running and strictly after HEAD
	// advanced, on every runner.
	const started = join(cwd, ".git", "post-commit-started");
	const release = join(cwd, ".git", "post-commit-release");
	installHook(cwd, "post-commit", [
		`printf '1\\n' > ${JSON.stringify(started)}`,
		`while [ ! -e ${JSON.stringify(release)} ]; do sleep 0.02; done`,
	].join("\n"));
	const before = git(cwd, "rev-parse", "HEAD");
	const abort = new AbortController();
	const pending = runGitCommitTransaction(invocation(cwd, "commit-cancellation"), {
		nativeReviewCli: native(cwd, "commit-cancellation"),
		signal: abort.signal,
	});
	let settled = false;
	void pending.then(() => { settled = true; }, () => { settled = true; });
	while (!existsSync(started) && !settled) await delay(10);
	assert.equal(settled, false, "commit transaction finished before the post-commit hook confirmed HEAD advanced");
	abort.abort();
	writeFileSync(release, "release\n");
	const result = await pending;
	assert.equal(abort.signal.aborted, true);
	assert.notEqual(result.head, before);
	assert.equal(result.status, "committed");
	assert.deepEqual(inspectCommitTransaction(cwd), { status: "clean" });
});

function unbornRepository(t: test.TestContext): string {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-commit-transaction-unborn-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	git(cwd, "init", "-b", "main");
	git(cwd, "config", "user.name", "Commit Transaction Test");
	git(cwd, "config", "user.email", "commit-transaction@example.invalid");
	writeFileSync(join(cwd, "initial.txt"), "first commit\n");
	git(cwd, "add", "initial.txt");
	return cwd;
}

test("an unborn repository creates its first reviewed commit without a prior HEAD", async (t) => {
	const cwd = unbornRepository(t);
	const intendedTree = git(cwd, "write-tree");
	const command = `git commit ${JSON.stringify("-m")} ${JSON.stringify("initial")}`;
	const invocation = prepareCommitTransactionInvocation({
		command,
		cwd,
		arguments: ["-m", "initial"],
		authorization: {
			lineageId: "unborn-first",
			storeRevision: "sha256:" + "a".repeat(64),
			fingerprint: "sha256:" + "b".repeat(64),
			intendedTree,
		},
	});
	const result = await runGitCommitTransaction(invocation, { nativeReviewCli: native(cwd, "unborn-first") });
	assert.equal(result.status, "committed");
	assert.equal(result.tree, intendedTree);
	assert.equal(result.head, git(cwd, "rev-parse", "HEAD"));
	assert.equal(git(cwd, "rev-parse", "HEAD^{tree}"), intendedTree);
	assert.deepEqual(inspectCommitTransaction(cwd), { status: "clean" });
	const verified = verifyCommitTransactionResult(cwd, result.transactionId);
	assert.equal(verified.tree, intendedTree);
});

test("an unborn repository that fails to commit leaves no HEAD and allows exact retry", async (t) => {
	const cwd = unbornRepository(t);
	const intendedTree = git(cwd, "write-tree");
	const command = `git commit ${JSON.stringify("-m")} ${JSON.stringify("initial")}`;
	const invocation = prepareCommitTransactionInvocation({
		command,
		cwd,
		arguments: ["-m", "initial"],
		authorization: {
			lineageId: "unborn-retry",
			storeRevision: "sha256:" + "a".repeat(64),
			fingerprint: "sha256:" + "b".repeat(64),
			intendedTree,
		},
	});
	await assert.rejects(
		runGitCommitTransaction(invocation, { nativeReviewCli: native(cwd, "unborn-retry", "invalidated") }),
		/native pre-commit validation denied/,
	);
	assert.throws(() => git(cwd, "rev-parse", "--verify", "HEAD"), /fatal|Needed/i);
	assert.equal(inspectCommitTransaction(cwd).record?.state, COMMIT_TRANSACTION_STATE.VALIDATION_FAILED);
	// A denied attempt leaves the index intact and HEAD unborn, so the exact
	// commit command can be retried. The failed transaction requires explicit
	// recovery: abandon archives it (HEAD never moved, so abandon is allowed),
	// then a fresh invocation authorizes the same tree and commits successfully.
	abandonCommitTransaction(cwd);
	assert.equal(inspectCommitTransaction(cwd).status, "clean");
	const retry = prepareCommitTransactionInvocation({
		command,
		cwd,
		arguments: ["-m", "initial"],
		authorization: {
			lineageId: "unborn-retry",
			storeRevision: "sha256:" + "a".repeat(64),
			fingerprint: "sha256:" + "b".repeat(64),
			intendedTree,
		},
	});
	const result = await runGitCommitTransaction(retry, { nativeReviewCli: native(cwd, "unborn-retry") });
	assert.equal(result.status, "committed");
	assert.equal(result.tree, intendedTree);
	assert.equal(result.head, git(cwd, "rev-parse", "HEAD"));
	assert.equal(git(cwd, "rev-parse", "HEAD^{tree}"), intendedTree);
	assert.deepEqual(inspectCommitTransaction(cwd), { status: "clean" });
	const verified = verifyCommitTransactionResult(cwd, result.transactionId);
	assert.equal(verified.tree, intendedTree);
});

function unbornInvocation(cwd: string, lineageId: string): CommitTransactionInvocation {
	return prepareCommitTransactionInvocation({
		command: "git commit -m initial",
		cwd,
		arguments: ["-m", "initial"],
		authorization: {
			lineageId,
			storeRevision: "sha256:" + "a".repeat(64),
			fingerprint: "sha256:" + "b".repeat(64),
			intendedTree: git(cwd, "write-tree"),
		},
	});
}

// Mirrors lib/git-commit-transaction.ts canonicalJson + sha256 so tests can
// prove the durable repository identity is byte-for-byte compatible with the
// previous formula `sha256(canonicalJson({ common_directory: commonDir, roots }))`.
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
function identitySha256(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

test("a born repository keeps the durable transaction identity formula with sorted root commits across the unborn-handling upgrade", async (t) => {
	const cwd = repository(t);
	stage(cwd);
	installHook(cwd, "pre-commit", "exit 23");
	const commonDir = realpathSync(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
	const roots = git(cwd, "rev-list", "--max-parents=0", "HEAD").split(/\r?\n/).filter(Boolean).sort();
	const expected = identitySha256(canonicalJson({ common_directory: commonDir, roots }));
	await assert.rejects(
		runGitCommitTransaction(invocation(cwd, "born-identity"), { nativeReviewCli: native(cwd, "born-identity") }),
		/pre-commit hook failed/,
	);
	const record = inspectCommitTransaction(cwd).record;
	assert.ok(record, "a failing hook leaves an active transaction record carrying the repository identity");
	assert.equal(record!.repository_id, expected);
	assert.equal(record!.common_directory, commonDir);
	abandonCommitTransaction(cwd);
	assert.equal(inspectCommitTransaction(cwd).status, "clean");
});

test("an unborn repository derives a deterministic repository identity without rev-list HEAD and without masking errors", async (t) => {
	const cwd = unbornRepository(t);
	const commonDir = realpathSync(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
	// Unborn has no root commits reachable from HEAD; the identity uses the
	// empty roots set, which is deterministic and avoids `rev-list HEAD`.
	const expected = identitySha256(canonicalJson({ common_directory: commonDir, roots: [] }));
	const intendedTree = git(cwd, "write-tree");
	const command = `git commit ${JSON.stringify("-m")} ${JSON.stringify("initial")}`;
	const invocation = prepareCommitTransactionInvocation({
		command,
		cwd,
		arguments: ["-m", "initial"],
		authorization: {
			lineageId: "unborn-identity",
			storeRevision: "sha256:" + "a".repeat(64),
			fingerprint: "sha256:" + "b".repeat(64),
			intendedTree,
		},
	});
	await assert.rejects(
		runGitCommitTransaction(invocation, { nativeReviewCli: native(cwd, "unborn-identity", "invalidated") }),
		/native pre-commit validation denied/,
	);
	const record = inspectCommitTransaction(cwd).record;
	assert.ok(record, "a denied unborn attempt leaves an active transaction record carrying the repository identity");
	assert.equal(record!.repository_id, expected);
	assert.equal(record!.common_directory, commonDir);
	abandonCommitTransaction(cwd);
	assert.equal(inspectCommitTransaction(cwd).status, "clean");
});

// Resolves the canonical absolute git common directory for asserting the
// absence of the transaction state root without assuming a literal `.git`.
function transactionStateRoot(cwd: string): string {
	const commonDir = realpathSync(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
	return join(commonDir, "gentle-pi", "commit-transactions");
}

test("preparation fails closed for a corrupt HEAD ref without writing transaction state and reports corruption", (t) => {
	const cwd = unbornRepository(t);
	// A garbage ref (not a valid SHA) makes HEAD unresolvable. Resolving root
	// commits during repository binding rethrows, so preparation must throw,
	// no transaction state may be written, and inspection reports corruption
	// (repository identity itself cannot be resolved while HEAD is corrupt).
	mkdirSync(join(cwd, ".git", "refs", "heads"), { recursive: true });
	writeFileSync(join(cwd, ".git", "refs", "heads", "main"), "z".repeat(40));
	assert.throws(() => unbornInvocation(cwd, "corrupt-head"));
	assert.equal(existsSync(transactionStateRoot(cwd)), false, "no transaction state root is written for a corrupt HEAD");
	const inspection = inspectCommitTransaction(cwd);
	assert.equal(inspection.status, "corrupted", "repository corruption makes inspection corrupted even with no transaction state written");
	assert.ok(typeof inspection.reason === "string" && inspection.reason.length > 0, "inspection reason is present and actionable");
});

test("preparation fails closed for a symbolic HEAD pointing at a missing object instead of classifying it as unborn", (t) => {
	const cwd = unbornRepository(t);
	// A valid-format SHA with no object: rev-parse --verify HEAD succeeds, so
	// resolveHead returns a commit id rather than classifying HEAD as unborn.
	// Resolving root commits then fails on the missing object, so preparation
	// must throw, no transaction state may be written, and inspection reports
	// corruption. This must never be classified as an unborn empty-roots repo.
	mkdirSync(join(cwd, ".git", "refs", "heads"), { recursive: true });
	writeFileSync(join(cwd, ".git", "refs", "heads", "main"), "0123456789abcdef0123456789abcdef01234567\n");
	assert.throws(() => unbornInvocation(cwd, "missing-object-head"));
	assert.equal(existsSync(transactionStateRoot(cwd)), false, "no transaction state root is written for a missing-object HEAD");
	const inspection = inspectCommitTransaction(cwd);
	assert.equal(inspection.status, "corrupted", "a missing-object HEAD is repository corruption, not a clean or unborn repo");
	assert.ok(typeof inspection.reason === "string" && inspection.reason.length > 0, "inspection reason is present and actionable");
});

test("resolveHead propagates a probe timeout instead of masking it as an unborn HEAD", (t) => {
	const cwd = unbornRepository(t);
	const wrapperDir = mkdtempSync(join(tmpdir(), "gentle-pi-commit-transaction-timeout-"));
	t.after(() => rmSync(wrapperDir, { recursive: true, force: true }));
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	writeFileSync(join(wrapperDir, "git"), `#!/bin/sh\nif [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ] && [ "$3" = "HEAD" ] && [ $# -eq 3 ]; then\nsleep 30\nelse\nexec ${realGit} "$@"\nfi\n`);
	chmodSync(join(wrapperDir, "git"), 0o755);
	const originalPath = process.env.PATH;
	process.env.PATH = `${wrapperDir}:${originalPath}`;
	try {
		// The probe wrapper sleeps past GIT_TIMEOUT_MS (10s), so execFileSync
		// kills the process and resolveHead rethrows the raw timeout error
		// rather than classifying it as an unborn HEAD. Accept only a failure
		// that genuinely represents a timeout, not any arbitrary error.
		assert.throws(
			() => unbornInvocation(cwd, "timeout-head"),
			(error: unknown) => error !== null && typeof error === "object"
				&& ((error as { code?: unknown }).code === "ETIMEDOUT" || (error as { killed?: unknown }).killed === true),
			"resolveHead must propagate a probe timeout instead of masking it as an unborn HEAD",
		);
	} finally {
		process.env.PATH = originalPath;
	}
	assert.equal(inspectCommitTransaction(cwd).status, "clean");
});
