import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const REPO_ROOT = join(import.meta.dirname, "..");
const delegation = readFileSync(join(REPO_ROOT, "assets", "orchestrator-delegation.md"), "utf8");

const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf8");

test("provider defects never trigger an automatic GitHub issue workflow", () => {
	assert.match(delegation, /GitHub issue operations are opt-in/);
	assert.match(delegation, /Use GitHub issues only when the user explicitly requests that exact issue operation/);
	for (const forbidden of [
		"Gentle AI Provider Defect Handoff (MANDATORY)",
		"report_and_continue",
		"complete a definitive lookup across open and closed issues",
		"for explicit consent to report the apparent defect",
	]) {
		assert.equal(delegation.includes(forbidden), false, `obsolete provider-defect issue gate remains: ${forbidden}`);
	}
});

test("PR and RDD skills make issue tracking optional", () => {
	for (const relative of ["skills/branch-pr/SKILL.md", "skills/rdd-defect-workflow/SKILL.md"]) {
		const content = read(relative);
		assert.match(content, /GitHub issues are optional|Issues are optional/);
		assert.match(content, /explicitly ask|explicitly requests/);
		for (const forbidden of ["Every PR MUST link", "Require an approved issue", "status:approved", "issue-first"]) {
			assert.equal(content.includes(forbidden), false, `${relative} retains issue gate: ${forbidden}`);
		}
	}
});

test("enabled RDD is documented as automatic rather than candidate-scoped consent", () => {
	const rdd = read("skills/rdd-defect-workflow/SKILL.md");
	assert.match(rdd, /review applicable candidates automatically/);
	assert.match(rdd, /Do not ask for a second candidate-scoped consent/);
	assert.match(rdd, /disable command is the user-owned kill switch/);
});
