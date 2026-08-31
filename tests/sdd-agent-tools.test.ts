import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const assetsAgentsDir = join(repoRoot, "assets", "agents");
const GENERIC_ROLE_TOOLS: Record<string, string[]> = {
	"gentle-ai-explore.md": ["read", "grep", "find", "codegraph"],
	"gentle-ai-worker.md": ["read", "grep", "find", "codegraph", "edit", "write", "bash", "mem_save"],
	"gentle-ai-verify.md": ["read", "grep", "find", "codegraph", "bash"],
};

function readFrontmatter(path: string): string {
	const text = readFileSync(path, "utf8");
	const match = text.match(/^---\n([\s\S]*?)\n---/);
	assert.ok(match, `${path} must have YAML frontmatter`);
	return match[1];
}

function readFrontmatterField(path: string, field: string): string | undefined {
	const line = readFrontmatter(path)
		.split("\n")
		.find((candidate) => candidate.startsWith(`${field}:`));
	return line?.slice(field.length + 1).trim();
}

function readTools(path: string): string[] {
	const frontmatter = readFrontmatter(path);
	const lines = frontmatter.split("\n");
	const toolsIndex = lines.findIndex((line) => line === "tools:");
	assert.notEqual(toolsIndex, -1, `${path} must declare tools as a YAML array`);

	const scalarTools = lines.find((line) => /^tools:\s+/.test(line));
	assert.equal(scalarTools, undefined, `${path} must not declare scalar comma-separated tools`);

	const tools: string[] = [];
	for (const line of lines.slice(toolsIndex + 1)) {
		if (!line.startsWith("  - ")) break;
		tools.push(line.slice(4).trim());
	}
	assert.ok(tools.length > 0, `${path} must declare at least one tool`);
	return tools;
}

function assertGenericRoleBody(fileName: string, source: string): void {
	assert.match(source, /generic non-SDD work/);
	assert.match(source, /Do not (?:fix findings, delegate to child agents|delegate to child agents, commit)/);
	assert.match(source, /Do not (?:edit, write|edit, write, or fix findings)/);
	assert.match(source, /compressed (?:handoff|evidence handoff)/);
	assert.match(source, /supporting (?:paths|evidence)/);
	assert.match(source, /Do not use SDD phase protocols or review lenses\./);

	if (fileName === "gentle-ai-explore.md") {
		assert.match(source, /sole permitted mutation/);
		assert.match(source, /all tracked files, source files, and other project content remain read-only/);
		assert.match(source, /CodeGraph reports that it is unavailable or fails/);
		assert.match(source, /Do not use that fallback before CodeGraph is unavailable or fails/);
	}

	if (fileName === "gentle-ai-verify.md") {
		assert.match(source, /execute only exact test, build, or lint commands explicitly authorized by the parent/);
		assert.match(source, /only outputs the parent explicitly identified as expected/);
		assert.match(source, /unexpected mutation as a blocker/);
		assert.match(source, /report it, but do not clean it up or fix it/);
	}
}

function assertCodeGraphGuidance(fileName: string, source: string): void {
	if (fileName === "gentle-ai-worker.md") {
		assert.match(source, /For structural questions, use the cwd-scoped `codegraph` tool before broad filesystem searches\./);
		assert.match(source, /CodeGraph read access may be broad/);
		assert.match(source, /writes remain strictly limited to the exact parent-provided `## Allowed edit surfaces`/);
		assert.match(source, /CodeGraph does not authorize scope expansion/);
		assert.match(source, /If CodeGraph reports that it is unavailable or fails, then use `read`, `grep`, and `find` as the fallback\./);
		assert.match(source, /Do not use that fallback before CodeGraph is unavailable or fails\./);
		assert.match(source, /If CodeGraph reports stale or pending files, read those files directly/);
	}

	if (fileName === "gentle-ai-verify.md") {
		assert.match(source, /For structural impact analysis, use the cwd-scoped `codegraph` tool before broad filesystem searches\./);
		assert.match(source, /product files remain read-only/);
		assert.match(source, /Only exact parent-authorized test, build, or lint commands may run\./);
		assert.match(source, /CodeGraph output alone is not verification evidence\./);
		assert.match(source, /inspect direct files and observed command results/i);
		assert.match(source, /If CodeGraph reports that it is unavailable or fails, then use `read`, `grep`, and `find` as the fallback\./);
		assert.match(source, /If CodeGraph reports stale or pending files, read those files directly/);
	}
}

const requiredToolsByAgent: Record<string, string[]> = {
	"sdd-apply.md": ["read", "grep", "find", "edit", "write", "bash", "mem_search", "mem_get_observation", "mem_save", "mem_update"],
	"sdd-archive.md": ["read", "grep", "find", "edit", "write", "bash", "mem_search", "mem_get_observation", "mem_save"],
	"sdd-design.md": ["read", "grep", "find", "edit", "write", "mem_search", "mem_get_observation", "mem_save"],
	"sdd-explore.md": ["read", "grep", "find", "edit", "write", "mem_save"],
	"sdd-init.md": ["read", "grep", "find", "edit", "write", "bash", "mem_search", "mem_get_observation", "mem_save", "mem_update"],
	"sdd-onboard.md": ["read", "grep", "find", "edit", "write", "bash", "mem_search", "mem_get_observation", "mem_save", "mem_update"],
	"sdd-proposal.md": ["read", "grep", "find", "edit", "write", "mem_search", "mem_get_observation", "mem_save"],
	"sdd-research.md": ["read", "grep", "find", "edit", "write", "mem_search", "mem_get_observation", "mem_save"],
	"sdd-spec.md": ["read", "grep", "find", "edit", "write", "mem_search", "mem_get_observation", "mem_save"],
	"sdd-status.md": ["read", "grep", "find", "bash", "mem_search", "mem_get_observation"],
	"sdd-sync.md": ["read", "grep", "find", "edit", "write", "bash", "mem_search", "mem_get_observation", "mem_save", "mem_update"],
	"sdd-tasks.md": ["read", "grep", "find", "edit", "write", "mem_search", "mem_get_observation", "mem_save"],
	"sdd-verify.md": ["read", "grep", "find", "edit", "write", "bash", "mem_search", "mem_get_observation", "mem_save"],
};

test("SDD package agents declare role-appropriate tools as YAML arrays", () => {
	for (const [fileName, requiredTools] of Object.entries(requiredToolsByAgent)) {
		const path = join(assetsAgentsDir, fileName);
		assert.ok(existsSync(path), `${fileName} must exist`);
		const tools = readTools(path);
		for (const tool of requiredTools) {
			assert.ok(tools.includes(tool), `${fileName} must include ${tool}`);
		}
		for (const tool of tools) {
			assert.ok(!tool.startsWith("subagent_"), `${fileName} must not allow child subagent tool ${tool}`);
		}
	}
});

test("artifact-producing SDD agents can persist OpenSpec files while status remains read-only", () => {
	for (const fileName of Object.keys(requiredToolsByAgent).filter(
		(fileName) => fileName !== "sdd-status.md",
	)) {
		const tools = readTools(join(assetsAgentsDir, fileName));
		assert.ok(tools.includes("edit"), `${fileName} must include edit`);
		assert.ok(tools.includes("write"), `${fileName} must include write`);
	}

	const statusTools = readTools(join(assetsAgentsDir, "sdd-status.md"));
	assert.ok(!statusTools.includes("edit"), "sdd-status.md must remain read-only");
	assert.ok(!statusTools.includes("write"), "sdd-status.md must remain read-only");
});

test("project does not ship local SDD agent overrides", () => {
	for (const relativeDir of [join(".pi", "agents"), join(".pi", "subagents")]) {
		const dir = join(repoRoot, relativeDir);
		if (!existsSync(dir)) continue;
		const overrides = readdirSync(dir).filter((entry) => /^sdd-.*\.md$/i.test(entry));
		assert.deepEqual(overrides, [], `${relativeDir} must not shadow package SDD agents`);
	}
});

test("generic non-SDD agents declare exact role tool allowlists", () => {
	for (const [fileName, expectedTools] of Object.entries(GENERIC_ROLE_TOOLS)) {
		const path = join(assetsAgentsDir, fileName);
		assert.ok(existsSync(path), `${fileName} must exist`);
		assert.deepEqual(readTools(path), expectedTools);
		const source = readFileSync(path, "utf8");
		if (fileName !== "gentle-ai-worker.md") {
			assertGenericRoleBody(fileName, source);
		}
		assertCodeGraphGuidance(fileName, source);
	}
});

test("only generic exploration opts into packaged background mode", () => {
	const explorer = join(assetsAgentsDir, "gentle-ai-explore.md");
	assert.equal(readFrontmatterField(explorer, "subagent_mode"), "background");

	for (const fileName of ["gentle-ai-worker.md", "gentle-ai-verify.md"]) {
		assert.notEqual(
			readFrontmatterField(join(assetsAgentsDir, fileName), "subagent_mode"),
			"background",
			`${fileName} must not default to background mode`,
		);
	}
});

const RESEARCH_EVIDENCE_TOOLS = ["web_search", "source_check", "fetch_content", "get_search_content"];
const RESEARCH_WORKFLOW = "sdd-orchestrator-workflow.md";

test("sdd-research declares native evidence tools, exact grants, and default-deny audit guidance", () => {
	const path = join(assetsAgentsDir, "sdd-research.md");
	const source = readFileSync(path, "utf8");

	// Exact native Pi evidence toolset (Gentle AI a27ba4d0 contract).
	for (const tool of RESEARCH_EVIDENCE_TOOLS) {
		assert.ok(readTools(path).includes(tool), `sdd-research.md must declare native evidence tool ${tool}`);
	}

	// Auditable evidence grants, verbatim.
	assert.match(source, /documentation=\[fetch_content,get_search_content\]/);
	assert.match(source, /open-web=\[web_search,source_check,fetch_content,get_search_content\]/);

	// Retired deny-all wording is gone: research no longer blocks outright.
	assert.doesNotMatch(source, /documentation=\[\);\s*open-web=\[\)/);
	assert.doesNotMatch(source, /declares no evidence grants/);
	assert.doesNotMatch(source, /persist a `blocked` outcome with no claims, and stop/);

	// Default-deny audit guidance stays: evidence authority is never inferred.
	assert.match(source, /Never infer evidence authority/i);
	assert.match(source, /Bash, MCP, memory, inherited tools/i);
	assert.match(source, /Unsupported or undeclared classes deny admission and emit no claims/);

	// Positive research behavior: documentation URLs, varied web queries, claim
	// verification, claim-to-source mapping, observed-vs-inference, honest outcomes.
	assert.match(source, /supplied as URLs/i);
	assert.match(source, /varied `web_search` queries/i);
	assert.match(source, /Verify material claims/i);
	assert.match(source, /claim-to-source mapping/i);
	assert.match(source, /distinguish observed evidence from inference/i);
	assert.match(source, /`done \| partial \| blocked`/);

	// Unchanged contracts: no child subagents, persistence honesty.
	assert.match(source, /Do NOT launch child subagents/i);
	assert.match(source, /Never claim persistence you did not perform/i);
});

test("sdd-orchestrator-workflow declares the same exact research grants and no deny-all runtime note", () => {
	const source = readFileSync(join(assetsAgentsDir, "..", RESEARCH_WORKFLOW), "utf8");

	// The orchestrator workflow must surface the same auditable Pi grants.
	assert.match(source, /documentation=\[fetch_content,get_search_content\]/);
	assert.match(source, /open-web=\[web_search,source_check,fetch_content,get_search_content\]/);

	// Selected research must be admitted against exact grants and fail closed for
	// unsupported classes, then finish honestly before proposal readiness.
	assert.match(source, /admitted against the exact grants/i);
	assert.match(source, /unsupported classes fail closed/i);
	assert.match(source, /selected lane must finish honestly[^.]*before proposal readiness/i);

	// Retired deny-all runtime note is gone.
	assert.doesNotMatch(source, /declares no evidence grants/i);
	assert.doesNotMatch(source, /documentation=\[\);\s*open-web=\[\)/);
	assert.doesNotMatch(source, /fail-closes to a `blocked` outcome/i);
	assert.doesNotMatch(source, /treat research as unselected/i);
});

test("sdd-verify phase text carries the verify-result envelope and validate-before-persist rule", () => {
	// gentle-pi#535 row 5: the phase must produce a natively admissible report
	// on its first persistence attempt without hunting the format elsewhere.
	const envelopeFields = [
		"schema: gentle-ai.verify-result/v1",
		"evidence_revision: sha256:",
		"verdict:",
		"blockers:",
		"critical_findings:",
		"requirements:",
		"scenarios:",
		"test_command:",
		"test_exit_code:",
		"test_output_hash: sha256:",
		"build_command:",
		"build_exit_code:",
		"build_output_hash: sha256:",
	];

	const agentSource = readFileSync(join(assetsAgentsDir, "sdd-verify.md"), "utf8");
	assert.match(agentSource, /```yaml\nschema: gentle-ai\.verify-result\/v1\n/);
	for (const field of envelopeFields) {
		assert.ok(agentSource.includes(field), `sdd-verify.md envelope must carry \`${field}\``);
	}
	assert.match(agentSource, /first non-empty content/);
	assert.match(
		agentSource,
		/gentle-ai sdd-verify-validate --input <path\|-> --requirements <n> --scenarios <n>/,
	);

	const chainSource = readFileSync(join(repoRoot, "assets", "chains", "sdd-verify.chain.md"), "utf8");
	assert.match(chainSource, /gentle-ai\.verify-result\/v1/);
	assert.match(chainSource, /sdd-verify-validate/);
});

test("the retired Pi adversarial role agents are not packaged", () => {
	// gentle-pi#311 P5: the refuter and targeted validator verdicts execute
	// through Go-owned pi processes via provider-rendered self-contained
	// vectors; no Pi agent definition may reintroduce a Pi-authored verdict.
	for (const retired of ["review-refuter.md", "review-validator.md"]) {
		assert.ok(!existsSync(join(assetsAgentsDir, retired)), `${retired} must stay deleted`);
	}
});

const QUALITATIVE_WORKFLOW = "sdd-orchestrator-workflow.md";
const NUMERIC_CHANGED_LINE_POLICY = /(?:\b\d[\d_,]*\b[^\n]*(?:changed|authored)[- ]lines?|(?:changed|authored)[- ]lines?[^\n]*\b\d[\d_,]*\b|review[- ]budget[^\n]*\b\d[\d_,]*\b)/i;

// Pins the qualitative review-workload language across the active SDD
// forecast/apply/verify agents, the orchestrator workflow, and the Judgment Day
// judges. Numeric changed-line estimates/thresholds and size-exception or
// exception-ok routing must not reappear; research tests and the explore-only
// packaged background policy are preserved elsewhere in this file.
test("qualitative review workload language replaces numeric changed-line estimates and size-exception routing", () => {
	for (const fileName of ["sdd-tasks.md", "sdd-apply.md", "sdd-verify.md"]) {
		const source = readFileSync(join(assetsAgentsDir, fileName), "utf8");
		assert.match(source, /Review Workload Forecast/i, `${fileName} must keep the forecast`);
		assert.doesNotMatch(
			source,
			NUMERIC_CHANGED_LINE_POLICY,
			`${fileName} must not estimate or gate on changed lines`,
		);
		assert.doesNotMatch(source, /size:exception|exception-ok/i, `${fileName} must not route via size exceptions`);
		assert.match(
			source,
			/qualitative|cohesion|complexity|verification burden/i,
			`${fileName} must use qualitative workload language`,
		);
	}

	const workflow = readFileSync(join(assetsAgentsDir, "..", QUALITATIVE_WORKFLOW), "utf8");
	assert.match(workflow, /Review Workload Guard/i);
	assert.doesNotMatch(workflow, NUMERIC_CHANGED_LINE_POLICY);
	assert.doesNotMatch(workflow, /size:exception|exception-ok/i);
	assert.match(workflow, /qualitative/i);
	assert.match(workflow, /cohesion|cohesive/i);
	assert.doesNotMatch(workflow, /review budget `400`|review budget 400/i);

	for (const judge of ["jd-judge-a.md", "jd-judge-b.md"]) {
		const source = readFileSync(join(assetsAgentsDir, judge), "utf8");
		assert.doesNotMatch(
			source,
			NUMERIC_CHANGED_LINE_POLICY,
			`${judge} must not gate sweeps on changed lines`,
		);
		assert.match(source, /qualitatively full-4R-scale target/i, `${judge} must use qualitative sweep scale`);
		assert.match(source, /verification burden/i, `${judge} must weigh verification burden`);
		assert.notEqual(
			readFrontmatterField(join(assetsAgentsDir, judge), "subagent_mode"),
			"background",
			`${judge} must remain a foreground review role`,
		);
	}
});
