import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

// Test fixtures must compare the same path identity that Git and realpath()
// expose. macOS reports /var/... from os.tmpdir() while canonical filesystem
// APIs report /private/var/..., so normalize the inherited temp environment
// before any test worker or child process creates a fixture.
const canonicalTempRoot = realpathSync(tmpdir());

process.env.TMPDIR = canonicalTempRoot;
process.env.TMP = canonicalTempRoot;
process.env.TEMP = canonicalTempRoot;
