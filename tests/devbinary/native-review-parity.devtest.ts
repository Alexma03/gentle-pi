import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import {
	NATIVE_REVIEW_ERROR_CODE,
	NativeReviewCliError,
	NativeReviewCliV216,
	createNodeExecFileAdapter,
	type ExecFileAdapter,
} from "../../lib/native-review-cli.ts";
import { requireDevBinary } from "../support/native-binary-gate.ts";

// Organic RDD Parity: candidate-bound dev-binary journeys.
//
// This suite runs only via `pnpm run test:dev-binary` and only when
// GENTLE_AI_DEV_BINARY names a current, absolute candidate binary. Every START
// first obtains candidate-bound STATUS and executes the returned transition.
const DEV_BINARY = process.env.GENTLE_AI_DEV_BINARY;
const devBinaryGate = requireDevBinary({
	devBinaryPath: DEV_BINARY,
	exists: typeof DEV_BINARY === "string" && DEV_BINARY.length > 0 && isAbsolute(DEV_BINARY) && existsSync(DEV_BINARY),
	env: process.env,
});
if (!devBinaryGate.run) console.log(`tests/devbinary/native-review-parity.devtest.ts: ${devBinaryGate.reason}`);
const RUNNABLE = devBinaryGate.run;
const DEV_HOME = mkdtempSync(join(tmpdir(), "gentle-pi-dev-binary-home-"));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

type NativeCall = readonly string[];

function bridgeAdapter(binary: string, calls: NativeCall[]): ExecFileAdapter {
	const real = createNodeExecFileAdapter();
	return async (request) => {
		calls.push([...request.arguments]);
		return real({ ...request, file: binary });
	};
}

function journeyNative(binary: string): { native: NativeReviewCliV216; calls: NativeCall[] } {
	const calls: NativeCall[] = [];
	return { native: new NativeReviewCliV216(bridgeAdapter(binary, calls), binary), calls };
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository(t: test.TestContext): string {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-dev-binary-"));
	t.after(() => {
		try { execFileSync("chmod", ["-R", "u+w", cwd]); } catch { /* best effort */ }
		rmSync(cwd, { recursive: true, force: true });
	});
	git(cwd, "init", "-b", "main");
	git(cwd, "config", "user.email", "devbinary@example.com");
	git(cwd, "config", "user.name", "Dev Binary Journey");
	return cwd;
}

function enableGlobalReview(cwd: string): void {
	assert.ok(DEV_BINARY, "GENTLE_AI_DEV_BINARY is required for this devtest");
	const enabled = JSON.parse(execFileSync(DEV_BINARY, [
		"review", "mode", "enable", "--scope", "global", "--cwd", cwd, "--json",
	], { encoding: "utf8" })) as { status: { effective: string } };
	assert.equal(enabled.status.effective, "on");
	const status = JSON.parse(execFileSync(DEV_BINARY, [
		"review", "mode", "status", "--cwd", cwd, "--json",
	], { encoding: "utf8" })) as { status: { effective: string } };
	assert.equal(status.status.effective, "on");
}

async function enableReview(native: NativeReviewCliV216, cwd: string): Promise<void> {
	enableGlobalReview(cwd);
	const disabled = await native.reviewMode({ cwd, operation: "disable" });
	assert.equal(disabled.status.effective, "off");
	assert.equal(disabled.status.source, "clone_local");
	const enabled = await native.reviewMode({ cwd, operation: "enable" });
	assert.equal(enabled.status.effective, "on");
	assert.equal(enabled.status.source, "global");
}

// ---------------------------------------------------------------------------
// Kill switch round trip.
// ---------------------------------------------------------------------------

test("dev-binary: global opt-in then clone disable and enable clears only the local override", { skip: !RUNNABLE }, async (t) => {
	const cwd = repository(t);
	const { native } = journeyNative(DEV_BINARY!);
	enableGlobalReview(cwd);
	assert.equal((await native.reviewMode({ cwd, operation: "status" })).status.effective, "on");
	assert.equal((await native.reviewMode({ cwd, operation: "disable" })).status.effective, "off");
	assert.equal((await native.reviewMode({ cwd, operation: "status" })).status.source, "clone_local");
	assert.equal((await native.reviewMode({ cwd, operation: "enable" })).status.effective, "on");
	assert.equal((await native.reviewMode({ cwd, operation: "status" })).status.source, "global");
});

// ---------------------------------------------------------------------------
// Enabled RDD starts the candidate automatically.
// ---------------------------------------------------------------------------

test("dev-binary: enabled RDD executes one candidate-bound START without consent", { skip: !RUNNABLE }, async (t) => {
	const cwd = repository(t);
	const workflowDirectory = join(cwd, ".github", "workflows");
	execFileSync("mkdir", ["-p", workflowDirectory]);
	writeFileSync(join(workflowDirectory, "deploy.yml"), "name: x\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-qm", "initial");
	writeFileSync(join(workflowDirectory, "deploy.yml"), "name: x\non: push\njobs:\n  deploy:\n    steps:\n      - run: curl -s | bash\n");

	const { native, calls } = journeyNative(DEV_BINARY!);
	await enableReview(native, cwd);
	const status = await native.targetStatus({ cwd, agent: "pi" });
	const started = await native.start({ cwd, targetIdentity: status.targetIdentity });
	assert.equal(started.action, "created");
	assert.ok(started.lineageId.length > 0);
	assert.ok(started.selectedLenses.length > 0);
	assert.equal(started.raw?.repository_context !== undefined, true);
	const startCalls = calls.filter((arguments_) => arguments_.at(0) === "review" && arguments_.at(1) === "start");
	assert.equal(startCalls.length, 1, "enabled RDD must execute exactly one START");
	assert.equal(startCalls[0]!.some((argument) => argument.startsWith("--consent")), false);
});

// ---------------------------------------------------------------------------
// Truthful non-authority responses.
// ---------------------------------------------------------------------------

test("dev-binary: an empty candidate exposes the current STATUS refusal and never reconstructs START", { skip: !RUNNABLE }, async (t) => {
	const cwd = repository(t);
	writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-qm", "initial");

	const { native, calls } = journeyNative(DEV_BINARY!);
	await enableReview(native, cwd);
	const status = await native.targetStatus({ cwd, agent: "pi" });
	assert.equal(status.nextTransition?.kind, "collect");
	assert.equal(status.nextTransition?.reasonCode, "empty_candidate_base_ref_required");
	await assert.rejects(
		() => native.start({ cwd }),
		(error: unknown) => error instanceof NativeReviewCliError
			&& error.code === NATIVE_REVIEW_ERROR_CODE.SCHEMA_INCOMPATIBLE
			&& error.mutationOutcome === "none",
	);
	assert.equal(calls.filter((arguments_) => arguments_.at(0) === "review" && arguments_.at(1) === "start").length, 0);
});

test("dev-binary: a low-risk START closes the review with no receipt or follow-up capture", { skip: !RUNNABLE }, async (t) => {
	const cwd = repository(t);
	writeFileSync(join(cwd, "guide.md"), "# Guide\n\nBase\n");
	git(cwd, "add", "guide.md");
	git(cwd, "commit", "-qm", "docs: base guide");
	writeFileSync(join(cwd, "guide.md"), "# Guide\n\nBase\n\nPassive update\n");

	const { native } = journeyNative(DEV_BINARY!);
	await enableReview(native, cwd);
	const status = await native.targetStatus({ cwd, agent: "pi" });
	const started = await native.start({ cwd, targetIdentity: status.targetIdentity });
	assert.equal(started.action, "closed");
	assert.equal(started.state, "approved");
	assert.deepEqual(started.selectedLenses, []);
	assert.equal(started.lensesRequired, false);
});

test.before(() => {
	process.env.HOME = DEV_HOME;
	process.env.USERPROFILE = DEV_HOME;
});
test.after(() => {
	if (ORIGINAL_HOME === undefined) delete process.env.HOME;
	else process.env.HOME = ORIGINAL_HOME;
	if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = ORIGINAL_USERPROFILE;
	rmSync(DEV_HOME, { recursive: true, force: true });
});
