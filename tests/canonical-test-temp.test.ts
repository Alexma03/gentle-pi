import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalTestTempRoot } from "../scripts/canonical-test-temp.mjs";

test("test bootstrap selects the platform canonicalizer without touching Linux paths", () => {
	const parent = mkdtempSync(join(tmpdir(), "gentle-pi-temp-alias-"));
	const target = join(parent, "target");
	const alias = join(parent, "alias");
	mkdirSync(target);
	symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");

	const calls: string[] = [];
	const portableRealpath = (value: string) => {
		calls.push(`portable:${value}`);
		return realpathSync(value);
	};
	const nativeRealpath = (value: string) => {
		calls.push(`native:${value}`);
		return "windows-canonical";
	};

	assert.equal(canonicalTestTempRoot("darwin", alias, portableRealpath, nativeRealpath), realpathSync(target));
	assert.equal(canonicalTestTempRoot("win32", alias, portableRealpath, nativeRealpath), "windows-canonical");
	assert.equal(canonicalTestTempRoot("linux", alias, portableRealpath, nativeRealpath), alias);
	assert.deepEqual(calls, [`portable:${alias}`, `native:${alias}`]);
});
