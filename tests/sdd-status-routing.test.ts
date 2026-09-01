import assert from "node:assert/strict";
import test from "node:test";
import {
	SddStatusRoutingError,
	resolveSddStatusRouting,
	type SddStatus,
	type SddWorkUnitReadinessV1,
} from "../lib/sdd-status.ts";

function status(nextRecommended: string, blockedReasons: string[] = []): SddStatus {
	return {
		schemaName: "gentle-pi.sdd-status",
		schemaVersion: 1,
		changeName: "change",
		artifactStore: "hybrid",
		planningHome: { root: "/repo", changesDir: "/repo/openspec/changes" },
		changeRoot: "/repo/openspec/changes/change",
		artifactPaths: { proposal: [], specs: [], design: [], tasks: [], applyProgress: [], verifyReport: [], syncReport: [] },
		contextFiles: { proposal: [], specs: [], design: [], tasks: [], applyProgress: [], verifyReport: [], syncReport: [] },
		artifacts: { proposal: "done", specs: "done", design: "done", tasks: "done", applyProgress: "done", verifyReport: "missing", syncReport: "missing" },
		taskProgress: { total: 1, complete: 1, remaining: 0, unchecked: [] },
		deferredParentActions: { total: 0, complete: 0, remaining: 0, unchecked: [] },
		taskArtifactErrors: [],
		applyState: "all_done",
		dependencies: { apply: "all_done", verify: "ready", sync: "blocked", archive: "blocked" },
		actionContext: { mode: "repo-local", workspaceRoot: "/repo", allowedEditRoots: ["/repo"], warnings: [] },
		relationships: { dependsOn: [], supersedes: [], amends: [], conflictsWith: [], sameDomainActiveChanges: [] },
		collisions: [],
		nextRecommended,
		blockedReasons,
		isNonAuthoritative: false,
	};
}

const workUnits: readonly SddWorkUnitReadinessV1[] = [
	{ id: "apply-core", state: "ready", dependencies: [], incompleteDependencies: [], conflict: false, providerReady: true },
	{ id: "verify-core", state: "blocked", dependencies: ["apply-core"], incompleteDependencies: ["apply-core"], conflict: false, providerReady: false },
];

test("status routing projects deterministic work-unit readiness without runtime authority", () => {
	const routing = resolveSddStatusRouting(status("sdd-apply"), workUnits);
	assert.equal(routing.nextPhase, "sdd-apply");
	assert.equal(routing.artifactOnly, true);
	assert.deepEqual(routing.workUnits, workUnits);
	assert.equal("token" in routing, false);
	assert.equal("attempts" in routing, false);
});

test("blocked status routes to resolve-blockers while preserving work-unit state", () => {
	const routing = resolveSddStatusRouting(status("proposal.md is missing.", ["proposal.md is missing."]));
	assert.equal(routing.nextPhase, "resolve-blockers");
	assert.deepEqual(routing.blockedReasons, ["proposal.md is missing."]);
});

test("status routing rejects duplicate work-unit identities and does not mutate input", () => {
	assert.throws(
		() => resolveSddStatusRouting(status("sdd-verify"), [workUnits[0]!, workUnits[0]!]),
		SddStatusRoutingError,
	);
	assert.deepEqual(workUnits[0], { id: "apply-core", state: "ready", dependencies: [], incompleteDependencies: [], conflict: false, providerReady: true });
});
