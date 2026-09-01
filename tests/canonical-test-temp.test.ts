import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalTestTempRoot } from "../scripts/canonical-test-temp.mjs";

test("test bootstrap canonicalizes Darwin temp-root aliases only", () => {
	const parent = mkdtempSync(join(tmpdir(), "gentle-pi-temp-alias-"));
	const target = join(parent, "target");
	const alias = join(parent, "alias");
	mkdirSync(target);
	symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");

	assert.equal(canonicalTestTempRoot("darwin", alias), realpathSync(target));
	assert.equal(canonicalTestTempRoot("linux", alias), alias);
	assert.equal(canonicalTestTempRoot("win32", alias), alias);
});
