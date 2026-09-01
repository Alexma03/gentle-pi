import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CandidateViewError,
	CandidateViewRegistry,
	decorateReviewCandidateTask,
	type ReviewCandidateDecorationRequestV1,
} from "../lib/review-candidate-view.ts";

function git(cwd: string, ...arguments_: string[]): string {
	return execFileSync("git", arguments_, { cwd, encoding: "utf8" }).trim();
}

function repository(t: test.TestContext): string {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-candidate-decoration-"));
	git(cwd, "init", "-b", "main");
	writeFileSync(join(cwd, "tracked.txt"), "base\n");
	git(cwd, "add", "tracked.txt");
	git(cwd, "-c", "user.name=Candidate Test", "-c", "user.email=candidate@example.invalid", "commit", "-m", "base");
	return cwd;
}

function cleanupRoot(cwd: string): void {
	try { chmodSync(cwd, 0o755); } catch {}
	try { rmSync(cwd, { recursive: true, force: true }); } catch {}
}

test("provider-neutral review decoration returns a detached task bound to one immutable candidate", (t) => {
	const contributorRoot = repository(t);
	writeFileSync(join(contributorRoot, "tracked.txt"), "candidate\n");
	const candidateViews = new CandidateViewRegistry();
	t.after(() => {
		candidateViews.cleanupAll();
		cleanupRoot(contributorRoot);
	});
	const view = candidateViews.create({ contributorRoot });
	candidateViews.bindCurrent({ token: view.token, lineageId: "decoration-lineage", selectedLenses: ["review-risk"] });
	const request: ReviewCandidateDecorationRequestV1 = {
		role: "review-risk",
		candidateViews,
		workspaceRoot: contributorRoot,
		task: {
			task: "Inspect the candidate",
			context: "Return one bounded finding set",
			dependencies: ["scheduler"],
			expectedOutcome: "A portable review result",
		},
	};
	const original = structuredClone(request.task);
	const decorated = decorateReviewCandidateTask(request);
	assert.deepEqual(request.task, original);
	assert.deepEqual(decorated.dependencies, ["scheduler"]);
	assert.match(decorated.task, /Controller-owned candidate view/);
	assert.match(decorated.task, /Frozen candidate tree:/);
	assert.ok(decorated.task.includes(view.candidateTree));
	assert.match(decorated.task, /ambient contributor working directory is out of scope/i);
});

test("provider-neutral review decoration fails closed without the current bound candidate", (t) => {
	const contributorRoot = repository(t);
	t.after(() => cleanupRoot(contributorRoot));
	const task = {
		task: "Inspect the candidate",
		context: "",
		dependencies: [],
		expectedOutcome: "A result",
	};
	assert.throws(
		() => decorateReviewCandidateTask({ role: "review-risk", candidateViews: null, workspaceRoot: contributorRoot, task }),
		(error: unknown) => error instanceof CandidateViewError,
	);
});

test("provider-neutral review decoration rejects non-review roles and conflicting candidate text", (t) => {
	const contributorRoot = repository(t);
	const candidateViews = new CandidateViewRegistry();
	t.after(() => {
		candidateViews.cleanupAll();
		cleanupRoot(contributorRoot);
	});
	const view = candidateViews.create({ contributorRoot });
	candidateViews.bindCurrent({ token: view.token, lineageId: "decoration-lineage", selectedLenses: ["review-risk"] });
	const base = { task: "Inspect the candidate", context: "", dependencies: [], expectedOutcome: "A result" };
	assert.throws(() => decorateReviewCandidateTask({ role: "worker", candidateViews, workspaceRoot: contributorRoot, task: base }), CandidateViewError);
	assert.throws(() => decorateReviewCandidateTask({ role: "review-risk", candidateViews, workspaceRoot: contributorRoot, task: { ...base, task: `${base.task} ${view.root}` } }), CandidateViewError);
});
