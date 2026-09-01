import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

// macOS reports /var/... from os.tmpdir() while canonical filesystem APIs
// report /private/var/.... Normalize that platform alias before any test
// worker creates a fixture. Windows runners expose an 8.3 temp path through
// the environment, so use the native resolver there to recover the filesystem
// identity that Git and spawned processes report.
export function canonicalTestTempRoot(platform, tempRoot, portableRealpath = realpathSync, nativeRealpath = realpathSync.native) {
	if (platform === "darwin") return portableRealpath(tempRoot);
	if (platform === "win32") return nativeRealpath(tempRoot);
	return tempRoot;
}

if (process.platform === "darwin" || process.platform === "win32") {
	const canonicalTempRoot = canonicalTestTempRoot(process.platform, tmpdir());
	process.env.TMPDIR = canonicalTempRoot;
	process.env.TMP = canonicalTempRoot;
	process.env.TEMP = canonicalTempRoot;
}
