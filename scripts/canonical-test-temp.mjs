import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

// macOS reports /var/... from os.tmpdir() while canonical filesystem APIs
// report /private/var/.... Normalize that platform alias before any test
// worker creates a fixture, but retain native temp-path identity elsewhere
// (notably Windows, where realpath can return an 8.3 short path).
export function canonicalTestTempRoot(platform, tempRoot) {
	return platform === "darwin" ? realpathSync(tempRoot) : tempRoot;
}

if (process.platform === "darwin") {
	const canonicalTempRoot = canonicalTestTempRoot(process.platform, tmpdir());
	process.env.TMPDIR = canonicalTempRoot;
	process.env.TMP = canonicalTempRoot;
	process.env.TEMP = canonicalTempRoot;
}
