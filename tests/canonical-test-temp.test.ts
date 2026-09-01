import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BOOTSTRAP = join(PACKAGE_ROOT, "scripts", "canonical-test-temp.mjs");

test("test bootstrap canonicalizes the platform temp-root alias", () => {
	const parent = mkdtempSync(join(tmpdir(), "gentle-pi-temp-alias-"));
	const target = join(parent, "target");
	const alias = join(parent, "alias");
	mkdirSync(target);
	symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");

	const result = spawnSync(process.execPath, [
		"--import",
		BOOTSTRAP,
		"--input-type=module",
		"--eval",
		"import { tmpdir } from 'node:os'; process.stdout.write(tmpdir());",
	], {
		encoding: "utf8",
		env: { ...process.env, TMPDIR: alias, TMP: alias, TEMP: alias },
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, realpathSync(target));
});
