import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	checkReleaseEvidence,
	verifyExternalProviderAttestation,
	validateReleaseEvidence,
} from "../scripts/check-release-evidence.mjs";
import {
	validatePiSubagentsRpcLock,
} from "../scripts/check-provider-contract.mjs";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(relativePath: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(PACKAGE_ROOT, relativePath), "utf8")) as Record<string, unknown>;
}

test("repository release evidence is explicit and remains fail-closed before provider publication", () => {
	const result = checkReleaseEvidence(PACKAGE_ROOT);
	assert.deepEqual(result.problems, []);
	assert.equal(result.status, "pending");
	assert.equal(result.repositoryRecordComplete, true);
	assert.deepEqual(result.externalVerification, { status: "absent", verified: false });
	assert.equal(result.releaseReady, false);
	assert.match(result.message, /fail-closed/i);
});

test("release evidence rejects a fabricated provider version without a digest", () => {
	const evidence = readJson("docs/release/release-evidence.json");
	const provider = evidence.providerContract as Record<string, unknown>;
	const invalid = {
		...evidence,
		providerContract: {
			...provider,
			publishedVersion: "1.0.0",
			publishedDigestSha256: null,
		},
	};
	const problems = validateReleaseEvidence(invalid, {
		packageVersion: "2.3.0-rc.1",
		gentleAiVersion: "2.5.0-rc.3",
	});
	assert.ok(problems.some((problem) => /digest/i.test(problem)));
});

test("repository-record completeness does not imply external provenance verification", () => {
	const evidence = readJson("docs/release/release-evidence.json");
	const provider = evidence.providerContract as Record<string, unknown>;
	const ready = {
		...evidence,
		status: "ready",
		providerContract: {
			...provider,
			publishedVersion: "1.0.0",
			publishedDigestSha256: "a".repeat(64),
			pendingReason: undefined,
		},
	};
	const problems = validateReleaseEvidence(ready, {
		packageVersion: "2.3.0-rc.1",
		gentleAiVersion: "2.5.0-rc.3",
	});
	assert.ok(problems.some((problem) => /external verification|provenance|attestation/i.test(problem)));
});

test("a plausible provider version and digest stay unverified without attestation bytes", () => {
	const evidence = readJson("docs/release/release-evidence.json");
	const provider = evidence.providerContract as Record<string, unknown>;
	const ready = {
		...evidence,
		status: "ready",
		providerContract: {
			...provider,
			publishedVersion: "1.0.0",
			publishedDigestSha256: "a".repeat(64),
			pendingReason: undefined,
			externalVerification: {
				status: "verified",
				source: "repository-attestation",
				attestationPath: "docs/release/not-checked-in.json",
				attestationSha256: "b".repeat(64),
			},
		},
	};
	const verification = verifyExternalProviderAttestation(PACKAGE_ROOT, ready);
	assert.equal(verification.verified, false);
	assert.match(verification.problems.join("\n"), /cannot be read/i);
});

test("provider RPC lock remains a closed Nicobailon v1 contract", () => {
	const lock = readJson("contracts/pi-subagents-rpc-v1.lock.json");
	assert.deepEqual(validatePiSubagentsRpcLock(lock), []);
	const drifted = {
		...lock,
		provider: "other-provider",
	};
	assert.ok(validatePiSubagentsRpcLock(drifted).some((problem) => /provider/i.test(problem)));
});

test("CI and release procedures require the Node 24 cross-OS matrix and coordinated rollback evidence", () => {
	const ci = readFileSync(join(PACKAGE_ROOT, ".github/workflows/ci.yml"), "utf8");
	const publish = readFileSync(join(PACKAGE_ROOT, ".github/workflows/publish.yml"), "utf8");
	const release = readFileSync(join(PACKAGE_ROOT, "skills/release/SKILL.md"), "utf8");
	const rollback = readFileSync(join(PACKAGE_ROOT, "docs/release/paired-release.md"), "utf8");
	assert.match(ci, /matrix:/);
	assert.match(ci, /ubuntu-latest/);
	assert.match(ci, /macos-latest/);
	assert.match(ci, /windows-latest/);
	assert.match(ci, /node-version:\s*["']?24["']?/);
	assert.match(ci, /pnpm test/);
	assert.doesNotMatch(ci, /pnpm run check:release-evidence/, "CI must not repeat the release-evidence check already owned by pnpm test");
	const packageJson = readJson("package.json");
	assert.match(String((packageJson.scripts as Record<string, string>).test), /pnpm run test:contracts/);
	assert.match(String((packageJson.scripts as Record<string, string>)["test:contracts"]), /pnpm run check:release-evidence/);
	assert.match(publish, /check-release-evidence\.mjs\s+--release/);
	assert.match(release, /coordinated Gentle AI release/i);
	assert.match(release, /rollback.*both/i);
	assert.match(rollback, /Gentle Pi and Gentle AI/i);
	assert.match(rollback, /restore.*manifest.*lock/i);
});
