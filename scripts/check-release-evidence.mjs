#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RELEASE_EVIDENCE_SCHEMA = "gentle-pi.release-evidence/v1";
export const EXTERNAL_PROVIDER_ATTESTATION_SCHEMA = "gentle-pi.external-provider-attestation/v1";
export const RELEASE_EVIDENCE_PATH = "docs/release/release-evidence.json";
export const RELEASE_EVIDENCE_STATUS = Object.freeze({ PENDING: "pending", READY: "ready" });
export const EXTERNAL_VERIFICATION_STATUS = Object.freeze({ ABSENT: "absent", VERIFIED: "verified" });
export const RELEASE_MATRIX_RUNNERS = Object.freeze([
	"ubuntu-latest",
	"macos-latest",
	"windows-latest",
]);
export const RELEASE_MATRIX_COMMANDS = Object.freeze([
	"pnpm test",
	"pnpm run check:provider-contract",
	"pnpm run check:runtime-modules",
	"node scripts/verify-package-files.mjs",
	"pnpm run test:packed-package",
]);

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED_ROLLBACK = Object.freeze({
	boundary: "paired-release",
	gentlePi: "restore-prior-package-manifest-and-lockfile",
	gentleAi: "restore-prior-published-runtime-pin",
	legacyAdapter: "never-restore",
});
const EXTERNAL_VERIFICATION_SOURCE = "repository-attestation";
const EXTERNAL_ATTESTATION_SOURCE = "external-published-release";

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameArray(actual, expected) {
	return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function sameObject(actual, expected) {
	return isRecord(actual) && Object.keys(expected).every((key) => actual[key] === expected[key]);
}

function equalJson(left, right) {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return Array.isArray(left) && Array.isArray(right)
			&& left.length === right.length
			&& left.every((value, index) => equalJson(value, right[index]));
	}
	if (isRecord(left) || isRecord(right)) {
		if (!isRecord(left) || !isRecord(right)) return false;
		const leftKeys = Object.keys(left).sort();
		const rightKeys = Object.keys(right).sort();
		return equalJson(leftKeys, rightKeys) && leftKeys.every((key) => equalJson(left[key], right[key]));
	}
	return false;
}

function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

function safeAttestationPath(value) {
	return typeof value === "string"
		&& value.length > 0
		&& value.startsWith("docs/release/")
		&& !isAbsolute(value)
		&& !value.includes("\\")
		&& !value.split("/").includes("..")
		&& value !== RELEASE_EVIDENCE_PATH;
}

/**
 * Validate the repository-owned release record without treating it as
 * external provenance. A syntactically complete provider version/digest is
 * only a record; publication remains blocked until the separate attestation
 * contract is verified from repository bytes.
 */
export function validateRepositoryRecord(evidence, expected) {
	const problems = [];
	if (!isRecord(evidence)) return ["release evidence is not a JSON object"];
	if (evidence.schema !== RELEASE_EVIDENCE_SCHEMA) problems.push(`release evidence schema must be ${RELEASE_EVIDENCE_SCHEMA}`);
	if (evidence.status !== RELEASE_EVIDENCE_STATUS.PENDING && evidence.status !== RELEASE_EVIDENCE_STATUS.READY) problems.push("release evidence status must be pending or ready");
	if (evidence.gentlePiVersion !== expected.packageVersion) problems.push(`release evidence gentlePiVersion ${JSON.stringify(evidence.gentlePiVersion)} does not match package.json ${JSON.stringify(expected.packageVersion)}`);
	if (evidence.gentleAiVersion !== expected.gentleAiVersion) problems.push(`release evidence gentleAiVersion ${JSON.stringify(evidence.gentleAiVersion)} does not match the pinned installer version ${JSON.stringify(expected.gentleAiVersion)}`);

	const provider = evidence.providerContract;
	if (!isRecord(provider)) {
		problems.push("release evidence providerContract must be an object");
	} else {
		if (provider.provider !== "nicobailon") problems.push("release evidence providerContract.provider must be nicobailon");
		if (provider.package !== "pi-subagents") problems.push("release evidence providerContract.package must be pi-subagents");
		if (provider.protocol !== 1) problems.push("release evidence providerContract.protocol must be 1");
		if (provider.lockPath !== "contracts/pi-subagents-rpc-v1.lock.json") problems.push("release evidence providerContract.lockPath must name the checked-in RPC lock");
		if (evidence.status === RELEASE_EVIDENCE_STATUS.PENDING) {
			if ((provider.publishedVersion === null) !== (provider.publishedDigestSha256 === null)) problems.push("provider publishedVersion and publishedDigestSha256 must be provided together or both remain null");
			if (provider.publishedVersion !== null) problems.push("pending release evidence must not claim a provider publishedVersion");
			if (provider.publishedDigestSha256 !== null) problems.push("pending release evidence must not claim a provider publishedDigestSha256");
			if (provider.pendingReason !== "published-provider-contract-required") problems.push("pending release evidence must state why the provider release evidence is absent");
		} else {
			if (typeof provider.publishedVersion !== "string" || !SEMVER.test(provider.publishedVersion)) problems.push("ready release evidence requires a valid provider publishedVersion");
			if (typeof provider.publishedDigestSha256 !== "string" || !SHA256.test(provider.publishedDigestSha256)) problems.push("ready release evidence requires a 64-character provider publishedDigestSha256");
			if (provider.pendingReason !== undefined) problems.push("ready release evidence must not retain pendingReason");
		}
	}

	const matrix = evidence.matrix;
	if (!isRecord(matrix)) {
		problems.push("release evidence matrix must be an object");
	} else {
		if (matrix.node !== "24") problems.push("release evidence matrix.node must be Node 24");
		if (!sameArray(matrix.runners, RELEASE_MATRIX_RUNNERS)) problems.push(`release evidence matrix.runners must be ${JSON.stringify(RELEASE_MATRIX_RUNNERS)}`);
		if (!sameArray(matrix.requiredCommands, RELEASE_MATRIX_COMMANDS)) problems.push("release evidence matrix.requiredCommands is incomplete or out of order");
	}

	if (!sameObject(evidence.rollback, REQUIRED_ROLLBACK)) problems.push("release evidence rollback must restore both prior releases and never restore a legacy adapter");
	return problems;
}

/** Validate the separate external-provenance declaration. */
export function validateExternalVerification(evidence) {
	if (!isRecord(evidence)) return ["external verification cannot be read from a non-object release record"];
	const provider = evidence.providerContract;
	if (!isRecord(provider)) return ["release evidence providerContract must declare externalVerification"];
	const verification = provider.externalVerification;
	if (!isRecord(verification)) return ["release evidence providerContract.externalVerification must be an object"];
	if (evidence.status === RELEASE_EVIDENCE_STATUS.PENDING) {
		if (!sameArray(Object.keys(verification).sort(), ["attestationPath", "attestationSha256", "reason", "status"])) {
			return ["pending externalVerification must contain only status, reason, attestationPath, and attestationSha256"];
		}
		const problems = [];
		if (verification.status !== EXTERNAL_VERIFICATION_STATUS.ABSENT) problems.push("pending externalVerification.status must be absent");
		if (verification.reason !== "published-provider-contract-required") problems.push("pending externalVerification must state why external provenance is absent");
		if (verification.attestationPath !== null) problems.push("pending externalVerification.attestationPath must remain null");
		if (verification.attestationSha256 !== null) problems.push("pending externalVerification.attestationSha256 must remain null");
		return problems;
	}
	if (evidence.status !== RELEASE_EVIDENCE_STATUS.READY) return ["external verification requires a valid release evidence status"];
	if (!sameArray(Object.keys(verification).sort(), ["attestationPath", "attestationSha256", "source", "status"])) {
		return ["ready externalVerification must contain only status, source, attestationPath, and attestationSha256"];
	}
	const problems = [];
	if (verification.status !== EXTERNAL_VERIFICATION_STATUS.VERIFIED) problems.push("ready release evidence requires externalVerification.status verified");
	if (verification.source !== EXTERNAL_VERIFICATION_SOURCE) problems.push("ready externalVerification.source must be repository-attestation");
	if (!safeAttestationPath(verification.attestationPath)) problems.push("ready externalVerification.attestationPath must name a safe docs/release attestation file");
	if (typeof verification.attestationSha256 !== "string" || !SHA256.test(verification.attestationSha256)) problems.push("ready externalVerification.attestationSha256 must be a 64-character SHA-256 digest");
	return problems;
}

/**
 * Validate the full offline evidence contract without consulting a registry or
 * GitHub. Repository-record completeness and external verification remain
 * separate so a fabricated version/digest cannot be reported as provenance.
 */
export function validateReleaseEvidence(evidence, expected) {
	return [
		...validateRepositoryRecord(evidence, expected),
		...validateExternalVerification(evidence),
	];
}

function packageRootFromEvidencePath(packageRoot, evidencePath) {
	if (typeof evidencePath !== "string" || evidencePath.length === 0 || isAbsolute(evidencePath)) throw new Error("release evidence path must be a non-empty relative path");
	const resolvedRoot = resolve(packageRoot);
	const resolvedPath = resolve(resolvedRoot, evidencePath);
	const withinRoot = relative(resolvedRoot, resolvedPath);
	if (withinRoot === "" || withinRoot.startsWith("..") || isAbsolute(withinRoot)) throw new Error("release evidence path must remain inside the package root");
	return resolvedPath;
}

function readJson(path, label) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function verifyExternalProviderAttestation(packageRoot, evidence) {
	const provider = evidence.providerContract;
	const verification = isRecord(provider) && isRecord(provider.externalVerification)
		? provider.externalVerification
		: undefined;
	if (!isRecord(verification) || verification.status !== EXTERNAL_VERIFICATION_STATUS.VERIFIED) {
		return { status: verification?.status ?? "missing", verified: false, problems: [] };
	}
	const problems = [];
	let attestationPath;
	try {
		attestationPath = packageRootFromEvidencePath(packageRoot, verification.attestationPath);
	} catch (error) {
		return {
			status: verification.status,
			verified: false,
			problems: [error instanceof Error ? error.message : String(error)],
		};
	}
	let bytes;
	try {
		if (!lstatSync(attestationPath).isFile()) throw new Error("external provider attestation must be a regular repository file");
		bytes = readFileSync(attestationPath);
	} catch (error) {
		return {
			status: verification.status,
			verified: false,
			problems: [`external provider attestation cannot be read: ${error instanceof Error ? error.message : String(error)}`],
		};
	}
	if (digest(bytes) !== verification.attestationSha256) problems.push("external provider attestation digest does not match its repository record");
	let attestation;
	try {
		attestation = JSON.parse(bytes.toString("utf8"));
	} catch (error) {
		problems.push(`external provider attestation is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (isRecord(attestation)) {
		if (attestation.schema !== EXTERNAL_PROVIDER_ATTESTATION_SCHEMA) problems.push(`external provider attestation schema must be ${EXTERNAL_PROVIDER_ATTESTATION_SCHEMA}`);
		if (attestation.source !== EXTERNAL_ATTESTATION_SOURCE) problems.push("external provider attestation source must be external-published-release");
		if (attestation.provider !== provider.provider) problems.push("external provider attestation provider does not match the repository record");
		if (attestation.package !== provider.package) problems.push("external provider attestation package does not match the repository record");
		if (attestation.protocol !== provider.protocol) problems.push("external provider attestation protocol does not match the repository record");
		if (attestation.publishedVersion !== provider.publishedVersion) problems.push("external provider attestation version does not match the repository record");
		if (attestation.publishedDigestSha256 !== provider.publishedDigestSha256) problems.push("external provider attestation digest does not match the repository record");
	} else if (attestation !== undefined) {
		problems.push("external provider attestation must be a JSON object");
	}
	return { status: verification.status, verified: problems.length === 0, problems };
}

function workflowProblems(packageRoot) {
	const problems = [];
	const ciPath = join(packageRoot, ".github", "workflows", "ci.yml");
	const publishPath = join(packageRoot, ".github", "workflows", "publish.yml");
	if (!existsSync(ciPath)) problems.push(".github/workflows/ci.yml is missing");
	else {
		const ci = readFileSync(ciPath, "utf8");
		const packageJson = readJson(join(packageRoot, "package.json"), "package manifest");
		const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
		const aggregateTest = typeof scripts.test === "string" ? scripts.test : "";
		const contractTest = typeof scripts["test:contracts"] === "string" ? scripts["test:contracts"] : "";
		const releaseEvidenceCovered = ci.includes("pnpm run check:release-evidence")
			|| (ci.includes("pnpm test") && aggregateTest.includes("pnpm run test:contracts") && contractTest.includes("pnpm run check:release-evidence"));
		if (!/matrix:\s*\n\s+os:\s*\n/s.test(ci) || !/runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/.test(ci)) problems.push("CI must run one verification job per matrix.os runner");
		for (const runner of RELEASE_MATRIX_RUNNERS) if (!ci.includes(runner)) problems.push(`CI matrix is missing ${runner}`);
		if (!/node-version:\s*["']?24["']?/.test(ci)) problems.push("CI matrix must use Node 24");
		if (!releaseEvidenceCovered) problems.push("CI matrix must run the repository release-evidence check directly or through its aggregate test");
	}
	if (!existsSync(publishPath)) problems.push(".github/workflows/publish.yml is missing");
	else if (!/check-release-evidence\.mjs\s+--release/.test(readFileSync(publishPath, "utf8"))) problems.push("publish workflow must run the fail-closed release-evidence gate");
	return problems;
}

function packagePublicationProblems(packageJson) {
	const problems = [];
	const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
	const prepublishOnly = typeof scripts.prepublishOnly === "string" ? scripts.prepublishOnly : "";
	const releaseGate = "node scripts/check-release-evidence.mjs --release";
	const gateIndex = prepublishOnly.indexOf(releaseGate);
	if (gateIndex < 0) {
		problems.push("package.json prepublishOnly must run the release-evidence gate");
		return problems;
	}
	for (const operation of ["pnpm test", "node scripts/verify-package-files.mjs", "pnpm run test:packed-package"]) {
		const operationIndex = prepublishOnly.indexOf(operation);
		if (operationIndex >= 0 && operationIndex < gateIndex) problems.push(`package.json prepublishOnly must run the release-evidence gate before ${operation}`);
	}
	return problems;
}

function providerLockProblems(packageRoot) {
	const lockPath = join(packageRoot, "contracts", "pi-subagents-rpc-v1.lock.json");
	if (!existsSync(lockPath)) return ["contracts/pi-subagents-rpc-v1.lock.json is missing"];
	const lock = readJson(lockPath, "pi-subagents RPC lock");
	const expected = {
		version: 1,
		provider: "nicobailon",
		package: "pi-subagents",
		protocol: 1,
		requiredCapabilities: ["spawn", "status", "stop", "events.asyncComplete"],
		methods: { ping: "ping", spawn: "spawn", status: "status", stop: "stop" },
		events: {
			ready: "subagents:rpc:v1:ready",
			request: "subagents:rpc:v1:request",
			replyPrefix: "subagents:rpc:v1:reply:",
			asyncComplete: "subagent:async-complete",
		},
		spawn: { async: true },
		completion: "status-or-events.asyncComplete",
	};
	return equalJson(lock, expected)
		? []
		: ["contracts/pi-subagents-rpc-v1.lock.json does not match the closed Nicobailon RPC v1 contract"];
}

export function checkReleaseEvidence(packageRoot, options = {}) {
	const mode = options.mode ?? "repository";
	if (mode !== "repository" && mode !== "release") throw new Error("release-evidence mode must be repository or release");
	const packageJson = readJson(join(packageRoot, "package.json"), "package.json");
	const installer = join(packageRoot, "scripts", "gentle-ai-installer.mjs");
	const evidencePath = packageRootFromEvidencePath(packageRoot, options.evidencePath ?? RELEASE_EVIDENCE_PATH);
	const evidence = readJson(evidencePath, "release evidence");
	const installerSource = readFileSync(installer, "utf8");
	const installerVersion = installerSource.match(/export const INSTALLER_VERSION = "([^"]+)"/)?.[1];
	if (installerVersion === undefined) throw new Error("scripts/gentle-ai-installer.mjs does not expose INSTALLER_VERSION");
	const expected = {
		packageVersion: packageJson.version,
		gentleAiVersion: installerVersion,
	};
	const repositoryRecordProblems = [
		...validateRepositoryRecord(evidence, expected),
		...providerLockProblems(packageRoot),
		...workflowProblems(packageRoot),
		...packagePublicationProblems(packageJson),
	];
	const externalVerificationShapeProblems = validateExternalVerification(evidence);
	const externalVerificationResult = verifyExternalProviderAttestation(packageRoot, evidence);
	const externalVerificationProblems = [
		...externalVerificationShapeProblems,
		...externalVerificationResult.problems,
	];
	const problems = [...repositoryRecordProblems, ...externalVerificationProblems];
	const repositoryRecordComplete = repositoryRecordProblems.length === 0;
	const externalVerification = {
		status: externalVerificationResult.status,
		verified: evidence.status === RELEASE_EVIDENCE_STATUS.READY
			&& externalVerificationProblems.length === 0
			&& externalVerificationResult.verified,
	};
	const releaseReady = evidence.status === RELEASE_EVIDENCE_STATUS.READY
		&& repositoryRecordComplete
		&& externalVerification.verified;
	if (mode === "release" && !releaseReady) {
		problems.push(evidence.status === RELEASE_EVIDENCE_STATUS.PENDING
			? "release evidence is pending; publish is fail-closed until a maintainer records the published pi-subagents version and digest"
			: "release evidence is not complete; publish is fail-closed");
	}
	const finalReady = mode === "release" ? problems.length === 0 : releaseReady;
	return {
		status: evidence.status,
		releaseReady: finalReady,
		repositoryRecordComplete,
		externalVerification,
		problems,
		message: evidence.status === RELEASE_EVIDENCE_STATUS.PENDING
			? "repository release evidence is valid; provider publication is absent and release mode remains fail-closed"
			: releaseReady
				? "coordinated release evidence is complete"
				: "repository release evidence is incomplete; publication remains fail-closed",
		providerContractDigest: externalVerification.verified && typeof evidence.providerContract?.publishedDigestSha256 === "string"
			? evidence.providerContract.publishedDigestSha256
			: undefined,
		repositoryEvidenceDigest: digest(JSON.stringify(evidence)),
	};
}

function parseMode(arguments_) {
	if (arguments_.length === 0) return "repository";
	if (arguments_.length === 1 && arguments_[0] === "--release") return "release";
	if (arguments_.length === 1 && arguments_[0] === "--repository") return "repository";
	throw new Error("usage: check-release-evidence.mjs [--repository|--release]");
}

async function main() {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	try {
		const mode = parseMode(process.argv.slice(2));
		const result = checkReleaseEvidence(packageRoot, { mode });
		if (result.problems.length > 0) {
			console.error(`gentle-pi ${mode} release-evidence check failed:`);
			for (const problem of result.problems) console.error(`- ${problem}`);
			process.exitCode = 1;
			return;
		}
		console.log(`${result.message} (status ${result.status}; releaseReady ${result.releaseReady}; evidence ${result.repositoryEvidenceDigest})`);
	} catch (error) {
		console.error(`gentle-pi release-evidence check failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) await main();
