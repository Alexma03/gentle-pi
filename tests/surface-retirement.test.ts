import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	FORBIDDEN_PACKAGE_SURFACES,
	REQUIRED_PACKAGE_SURFACES,
	scanRetiredSurfaceReferences,
} from "../scripts/verify-package-files.mjs";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const retired = (...parts: string[]) => parts.join("");
const oldAgentPackage = retired("pi-subagents", "-j0", "k3r");
const prettyDependency = retired("@heyhuynhgiabuu", "/pi-", "pretty");
const oldChoicePackage = retired("@juicesharp", "/rpi", "v-ask-user-question");

function packageJson(): Record<string, any> {
	return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
}

test("PR3 package inventory removes retired presentation and community surfaces", () => {
	const manifest = packageJson();
	const serialized = JSON.stringify(manifest);
	assert.equal(manifest.pi?.image, undefined);
	assert.equal(manifest.pi?.themes, undefined);
	assert.equal(manifest.dependencies?.[prettyDependency], undefined);
	assert.equal(manifest.dependencies?.["@shikijs/themes"], "4.2.0");
	assert.equal(manifest.files?.includes("themes/"), false);
	assert.doesNotMatch(serialized, new RegExp(oldAgentPackage));
	assert.doesNotMatch(serialized, new RegExp(oldChoicePackage));
	assert.ok(!FORBIDDEN_PACKAGE_SURFACES.some((path) => manifest.files?.includes(path)));
});

test("PR3 removes retired files while preserving package-owned runtime surfaces", () => {
	for (const relativePath of FORBIDDEN_PACKAGE_SURFACES) {
		assert.equal(existsSync(join(PACKAGE_ROOT, relativePath)), false, relativePath);
	}
	for (const relativePath of REQUIRED_PACKAGE_SURFACES) {
		assert.equal(existsSync(join(PACKAGE_ROOT, relativePath)), true, relativePath);
	}
	for (const relativePath of [
		"extensions/ask-user-choice.ts",
		"extensions/codegraph-tools.ts",
		"extensions/quiet-tools.ts",
		"lib/nicobailon-subagent-adapter.ts",
		"lib/subagent-runtime.ts",
		"lib/sdd-preflight.ts",
		"assets/migrations/managed-assets-v0.10.7.json",
		"assets/migrations/managed-assets-v0.13.json",
		"assets/migrations/managed-assets-v0.14.json",
	]) {
		assert.equal(existsSync(join(PACKAGE_ROOT, relativePath)), true, relativePath);
	}
});

test("retired-surface scan is explicit and excludes only approved history/control trees", () => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-retired-surface-"));
	try {
		const retiredText = oldAgentPackage;
		mkdirSync(join(root, "src"), { recursive: true });
		mkdirSync(join(root, ".git"), { recursive: true });
		mkdirSync(join(root, ".codegraph"), { recursive: true });
		mkdirSync(join(root, "openspec"), { recursive: true });
		mkdirSync(join(root, "tests", "fixtures"), { recursive: true });
		writeFileSync(join(root, "src", "retired.txt"), retiredText);
		writeFileSync(join(root, ".git", "retired.txt"), retiredText);
		writeFileSync(join(root, ".codegraph", "retired.txt"), retiredText);
		writeFileSync(join(root, "openspec", "retired.txt"), retiredText);
		writeFileSync(join(root, "tests", "fixtures", "orchestrator.pre-diet.md"), retiredText);
		const findings = scanRetiredSurfaceReferences(root);
		assert.deepEqual(findings, [{ relativePath: "src/retired.txt", surface: retiredText }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("retired-surface scan is clean for the checked-in production tree", () => {
	assert.deepEqual(scanRetiredSurfaceReferences(PACKAGE_ROOT), []);
});
