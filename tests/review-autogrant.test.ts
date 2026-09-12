import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// FORK-DIVERGENCE (Alexma03/gentle-pi, upstream issue #944): standing review
// auto-grant config. Mirrors the runtime-guardrails loading contract.

const { loadReviewAutograntConfig, parseReviewAutograntConfigFile } = __testing;

function makeTmpDir(): string {
	return mkdtempSync(join(tmpdir(), "gentle-pi-autogrant-"));
}

function writeConfig(dir: string, relPath: string, content: unknown): void {
	const full = join(dir, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, JSON.stringify(content, null, 2));
}

test("parseReviewAutograntConfigFile: autoGrant true enables", () => {
	assert.deepEqual(parseReviewAutograntConfigFile('{"autoGrant": true}'), { autoGrant: true });
});

test("parseReviewAutograntConfigFile: missing flag stays off", () => {
	assert.deepEqual(parseReviewAutograntConfigFile("{}"), { autoGrant: false });
});

test("parseReviewAutograntConfigFile: invalid JSON fails safe", () => {
	assert.equal(parseReviewAutograntConfigFile("not-json"), undefined);
});

test("loadReviewAutograntConfig: returns off config when no file exists", () => {
	const dir = makeTmpDir();
	try {
		const config = loadReviewAutograntConfig(dir, {
			gentlePiConfigHome: join(dir, "global"),
		});
		assert.deepEqual(config, { autoGrant: false });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadReviewAutograntConfig: global config file enables auto-grant", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global");
		writeConfig(globalConfigDir, "review-autogrant.json", { autoGrant: true });
		const config = loadReviewAutograntConfig(join(dir, "project"), {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.deepEqual(config, { autoGrant: true });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadReviewAutograntConfig: project config overrides global config", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global");
		const projectDir = join(dir, "project");
		writeConfig(globalConfigDir, "review-autogrant.json", { autoGrant: true });
		writeConfig(projectDir, join(".pi", "gentle-ai", "review-autogrant.json"), { autoGrant: false });
		const config = loadReviewAutograntConfig(projectDir, {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.deepEqual(config, { autoGrant: false });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadReviewAutograntConfig: invalid global JSON fails safe (autoGrant=false)", () => {
	const dir = makeTmpDir();
	try {
		const globalConfigDir = join(dir, "global");
		mkdirSync(globalConfigDir, { recursive: true });
		writeFileSync(join(globalConfigDir, "review-autogrant.json"), "broken");
		const config = loadReviewAutograntConfig(join(dir, "project"), {
			gentlePiConfigHome: globalConfigDir,
		});
		assert.deepEqual(config, { autoGrant: false });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
