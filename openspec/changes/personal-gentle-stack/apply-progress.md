# Apply Progress: personal-gentle-stack

## Session and slice

- **Change:** `personal-gentle-stack`
- **Phase:** Phase 1 — Runtime/Guard
- **Slice:** PR1, based on `feature/tracker`
- **Worktree:** `/home/alex/Projects/forks/gentle-pi-worktrees/pr1-foundation`
- **Branch:** `codex/personal-gentle-stack-pr1-foundation`
- **Artifact store:** hybrid (OpenSpec files plus Engram mirror)
- **Strict TDD:** enabled
- **Exact full test command:** `pnpm test`
- **Native attempt authority:** not acquired or settled; the parent owns the single native attempt

## Cumulative status

Tasks 1.1–1.5 are implemented, tested, and checked off in `tasks.md`. This slice is deliberately limited to the runtime port, Nicobailon adapter/RPC lock, workspace guard, and injected extension delegation. Tasks 2.1–4.6 remain unchecked and were not implemented.

| Task | Status | Commit(s) | Scope |
|---|---|---|---|
| 1.1 | complete | `a688c5f7` | Provider-neutral runtime port, DTO validation, negotiation, lifecycle semantics |
| 1.2 | complete | `d37ac463`, `95313c00` | Nicobailon `npm:pi-subagents` adapter, exact RPC lock, payload/handle/completion validation |
| 1.3 | complete | `4ca68568`, `95313c00` | Correlated replies, protocol drift rejection, bounded completion, provider identity/evidence rejection |
| 1.4 | complete | `93cf6908`, `0fff7850` | Canonical worktree/repository binding, command/path guard, wrapped/selector/identity hardening |
| 1.5 | complete | `4672fb39`, `fb5000a1` | Injected/default runtime + guard extension delegation route; Pi bus wiring and legacy probe removal |
| 2.1–2.7 | not started | — | DAG/review work deferred to PR2 |
| 3.1–3.6 | not started | — | Surface migration deferred to PR3 |
| 4.1–4.6 | not started | — | Release/evidence work deferred to PR4 |

## TDD Cycle Evidence

Each task followed RED → GREEN → triangulate → refactor. The focused runs below are the final task-local GREEN evidence; the RED evidence records the observed pre-production failure or edge regression that drove the implementation.

### 1.1 — Runtime port

- **RED:** `node --experimental-strip-types --test tests/subagent-runtime.test.ts` failed before the implementation because `lib/subagent-runtime.ts` was missing (`ERR_MODULE_NOT_FOUND`).
- **GREEN:** `node --experimental-strip-types --test tests/subagent-runtime.test.ts` → **6 tests, 6 passed, 0 failed**.
- **Triangulate:** pre-audit PR1 focused run over runtime, adapter, guard, and extension tests → **42 tests, 42 passed, 0 failed**; the correction cycle below supersedes this with 86/86.
- **Refactor:** validation is centralized around exact portable task/result DTOs; negotiation is fail-closed for protocol and mandatory-capability drift; commit `a688c5f7`.

### 1.2 — Nicobailon adapter and RPC lock

- **RED:** `node --experimental-strip-types --test tests/nicobailon-subagent-adapter.test.ts` failed before the implementation because the adapter module and RPC lock were missing (`ERR_MODULE_NOT_FOUND`).
- **GREEN:** `node --experimental-strip-types --test tests/nicobailon-subagent-adapter.test.ts` → **7 tests, 7 passed, 0 failed**.
- **Triangulate:** adapter tests verify ready/ping negotiation, async-only spawn, status/stop, correlated replies, async completion, and the lock bytes; pre-audit combined PR1 run → **42/42 passed**.
- **Refactor:** the adapter is the sole Nicobailon boundary and never invents a result RPC; commit `d37ac463`.

### 1.3 — Correlation, drift, and completion bounds

- **RED:** `timeout 2s node --experimental-strip-types --test tests/subagent-runtime.test.ts` produced **5 passing tests with the event-backed completion test still pending and exit 124** before the controller timeout was implemented. The protocol-conflict regression also produced **1 failure / 6 passes** in the adapter file before its validation fix.
- **GREEN:** `node --experimental-strip-types --test tests/subagent-runtime.test.ts tests/nicobailon-subagent-adapter.test.ts` → **13 tests, 13 passed, 0 failed**.
- **Triangulate:** completion derives from status/events, replies are matched by request ID, and a valid envelope carrying a conflicting protocol marker is rejected; pre-audit PR1 run → **42/42 passed**.
- **Refactor:** controller-owned timeout aborts the provider wait and cleans listeners; commit `4ca68568`.

### 1.4 — Workspace guard

- **RED:** `node --experimental-strip-types --test tests/workspace-guard.test.ts` failed before the implementation because `lib/workspace-guard.ts` was missing (`ERR_MODULE_NOT_FOUND`). Subsequent focused RED cases exposed force-with-lease refspec parsing, nested-repository detection, and symlinked-cwd binding gaps.
- **GREEN:** `node --experimental-strip-types --test tests/workspace-guard.test.ts` → **9 tests, 9 passed, 0 failed**.
- **Triangulate:** final guard coverage includes nested cwd canonicalization, symlink escape/binding rejection, sensitive paths, Git selectors, shell composition, safe tracking/first/refspec pushes, destructive/ambiguous pushes, and nested repositories; commit `93cf6908`.
- **Refactor:** path and command decisions are returned through one typed denial API with canonical binding identity; no shell execution is used.

### 1.5 — Extension delegation route

- **RED:** `node --experimental-strip-types --test tests/gentle-ai.test.ts` initially failed because the provider-neutral `gentle_subagent` tool was absent. The provider-specific field case then produced **1 failure / 19 passes** before parser rejection was added.
- **GREEN:** `node --experimental-strip-types --test tests/gentle-ai.test.ts` → **20 tests, 20 passed, 0 failed**.
- **Triangulate:** injected runtime calls are ordered `guard → negotiate → start → result`, guard denial happens before start, and provider-specific fields are rejected before crossing the port; commit `4672fb39`.
- **Refactor:** the new route has no inferred provider capability or fallback path. Existing review authority and its unrelated startup behavior remain untouched for later review/surface work; no review snapshot/DAG/surface/release migration was introduced.

## Correction cycle — independent PR1 audit

An independent audit reopened PR1 for eight correctness findings. Each finding first received a new RED regression before the minimal correction; no Phase 2/3/4 work was added and no replacement native attempt token was acquired.

### Finding evidence and GREEN results

1. **Default extension runtime wiring:** a fresh default-extension test initially found no `gentle_subagent` route because only injected runtimes were wired. `fb5000a1` constructs the sole Nicobailon adapter over the actual Pi event bus for the production default; the test now observes protocol-1 ping/spawn/status replies through that bus.
2. **Legacy delegation probes/interception:** fresh background and writer regressions established that package-name/filesystem probes and provider-specific `subagent_run` payload inspection must not determine ordinary delegation readiness. `fb5000a1` removes those probes and leaves `subagent_run` handling only for native review candidate-view injection; ordinary delegation uses `gentle_subagent`.
3. **Wrapped, bare, and attached-selector command escapes:** fresh guard regressions covered `cat .env`, wrapped destructive commands, wrapped outside-worktree selectors, attached `-C`, and wrapped ambiguous push. `0fff7850` unwraps only for inspection, rejects unsafe inner commands/selectors, and fail-closes otherwise-safe wrapped commands while retaining explicit direct tracking/first/refspec forms.
4. **Complete spawn payload:** a fresh adapter regression asserted `context`, `dependencies`, and `expectedOutcome`; `95313c00` forwards all portable task fields unchanged alongside the controller role and async marker.
5. **Echoed request ID:** a fresh spawn regression returned only the RPC `requestId`; `95313c00` rejects it and requires a distinct provider run handle.
6. **Status identity:** a fresh status regression returned another run's state; `95313c00` rejects status whose provider identity does not match the requested handle.
7. **Completion evidence:** fresh event regressions covered running, unknown, and missing-status payloads; `95313c00` rejects malformed/nonterminal completion evidence rather than coercing it to failed.
8. **Session guard binding and repository identity:** fresh extension/guard regressions covered repeated delegation binding and mismatched `repositoryId`/`commonDir`; `fb5000a1` caches the guard resolver for the extension session and `0fff7850` requires canonical repository identity while removing the tautological path check.

The fresh RED run reported **8 failing assertions (36 passing)** across the adapter/guard/extension regressions, plus the separate wrapped `env git push` ambiguity case. After the corrections, the focused PR1 suite is **86 tests, 86 passed, 0 failed, 0 skipped**.

## Work Unit Evidence

### Focused PR1 proof

```text
node --experimental-strip-types --test tests/subagent-runtime.test.ts tests/nicobailon-subagent-adapter.test.ts tests/workspace-guard.test.ts tests/gentle-ai.test.ts tests/background-subagents.test.ts tests/writer-edit-surface-scope.test.ts
ℹ tests 86
ℹ pass 86
ℹ fail 0
ℹ skipped 0
```

The final per-file focused totals are 6/6 runtime, 11/11 adapter, 11/11 guard, 22/22 extension, 34/34 background-subagents, and 2/2 legacy-boundary tests.

### Full repository proof

```text
pnpm test
ℹ tests 1176
ℹ pass 1175
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1

$ node scripts/check-provider-contract.mjs
... provider contract mirror check passed (contract 1.1.0, 8 bundle entries, 2 generated baselines, acquisition field-test-local).

$ node --experimental-strip-types tests/runtime-harness.mjs
exit 0
```

The exact full command exited **0**. The harness was also rerun directly with `pnpm run test:harness` and exited **0**. `pnpm run check:runtime-modules` also exited **0** with `runtime matches TypeScript sources (4 modules)`.

### Git/evidence checks

- `git diff --check` passed.
- Worktree was clean before this apply-progress artifact was written.
- No push, PR, merge, or release operation was performed.
- The pre-acquired native SDD attempt token was settled once with outcome `passed`; the provider returned `state: complete`.

### Native attempt settlement

- Token: `sha256:7444ea15d8d79bdf9a2acaecbaac4ac0d9e8b68fffaf3478cc07f452c2d94095`
- Request ID: `codex-pr1-settle-20260901t130324z-8306`
- Evidence revision: `sha256:767ffb966a2206a53ef1b60d7025874441cf944ac18344894a602c07908b99ac`
- Outcome: `passed`
- Result: `state: complete`

## Rollback boundary

PR1 can be reverted in reverse order without touching later phases:

1. `fb5000a1` — default Pi event-bus wiring, negotiated capability rendering, legacy delegation-probe removal, and harness/tests
2. `0fff7850` — wrapped-command, selector, and repository-identity guard corrections with tests
3. `95313c00` — provider handle/status/completion/payload corrections with tests
4. `4672fb39` — extension delegation route and tests
5. `93cf6908` — workspace guard and tests
6. `4ca68568` — runtime/adapter hardening and tests
7. `d37ac463` — Nicobailon adapter, RPC lock, and tests
8. `a688c5f7` — runtime port and tests

The boundary includes only `lib/subagent-runtime.ts`, `lib/nicobailon-subagent-adapter.ts`, `lib/workspace-guard.ts`, `contracts/pi-subagents-rpc-v1.lock.json`, the paired tests, `extensions/gentle-ai.ts`, and the PR1 task checkboxes. Phase 2/3/4 behavior and artifacts remain outside this rollback boundary.

## Blockers and next steps

- **PR1 blockers:** none observed; the complete test command, provider-contract check, runtime-module check, and harness pass.
- **Deferred work:** tasks 2.1–4.6 remain unchecked by design.
- **Next recommended:** parent consumes this completed PR1 handoff and proceeds to the next chained slice only after its own routing checks.

## PR2 / Phase 2 — DAG/Review

This section is appended to the complete PR1 record above. It preserves all PR1 evidence and records the completed PR2 child slice only.

- **Change:** `personal-gentle-stack`
- **Phase:** Phase 2 — DAG/Review
- **Slice:** PR2, `feature-branch-chain` child of PR1, with `delivery_strategy: ask-on-risk`; the workload decision was already resolved as `Decision needed before apply: No`.
- **Worktree:** `/home/alex/Projects/forks/gentle-pi-worktrees/pr2-dag-review`
- **Branch:** `codex/personal-gentle-stack-pr2-dag-review`
- **Base:** `0ee6ae07`
- **Artifact store:** hybrid (OpenSpec plus Engram mirror owned by the parent orchestrator)
- **Strict TDD:** enabled; exact full command is `pnpm test`.
- **Native attempt authority:** the parent orchestrator supplied the pre-acquired native attempt; this writer did not acquire, settle, reset, or create Pi-owned attempt state.

### Cumulative status

PR1 tasks 1.1–1.5 remain complete with all prior evidence retained above. PR2 tasks 2.1–2.7 are complete in this slice. Phase 3 and Phase 4 tasks remain unchecked and were not implemented.

| Task | Status | Commit(s) | Scope |
| --- | --- | --- | --- |
| 2.1 | complete | `737450b0`, `b85b67c9` | Dependency-safe DAG graph validation, deterministic readiness, completed-layer exclusion, and readiness-before-native-acquire checks. |
| 2.2 | complete | `737450b0`, `b85b67c9` | Work-unit leases, read/verify parallelism, writer/worktree serialization, idempotent leases and settlement, failure/cancel release, and final-verification evidence. |
| 2.3 | complete | `820f7f36`, `ffe901ba` | Provider-neutral pre-start candidate decoration, immutable registry binding, detached task/context projection, and fail-closed missing-registry/conflict handling. |
| 2.4 | complete | `672b4d87` | Finding- and repository-path-bounded one-correction lifecycle with ordinary/Judgment Day semantics, no changed-line budget, lens rerun, or refuter discovery. |
| 2.5 | complete | `c678d8f0`, `53316851` | Provider-neutral orchestrator DAG/lease contract and gatekeeper rerun routing subordinate to native acquire. |
| 2.6 | complete | `a25e75d5` | `sdd-tasks`, `sdd-apply`, and `sdd-verify` work-unit ownership, cumulative handoff, and provider-attempt authority assets. |
| 2.7 | complete | final PR2 commit below | `sdd-full`/`sdd-verify` chain assets and artifact-only, RDD-independent structured status routing. |

### Implementation evidence

- `lib/work-unit-scheduler.ts` and `tests/work-unit-scheduler.test.ts` define and exercise unknown/duplicate/cyclic dependency rejection, deterministic ready selection, readiness-before-acquire, safe read/verify parallelism, writer serialization, isolated worktrees, duplicate/idempotent leases, settlement release, conflicting settlement rejection, and final-verification idempotency.
- `lib/review-candidate-view.ts`, `extensions/gentle-ai.ts`, and `tests/review-candidate-decoration.test.ts` add the provider-neutral pre-start decoration seam. Review tasks resolve the current immutable registry candidate before the runtime starts; missing registry, drift, conflicting candidate text, invalid roles, and unsafe task shapes fail closed. The legacy native `subagent_run` injection hook is retained only for compatibility and is not the new orchestration seam.
- `lib/review-correction-lifecycle.ts` and `tests/review-correction-scope.test.ts` require the exact corroborated finding set, safe repository-relative path subset, and positive forecast before creating a detached bounded plan. The plan keeps ordinary and Judgment Day correction/validation semantics while explicitly disabling lens/refuter reruns and changed-line quotas.
- `lib/sdd-status.ts` and `tests/sdd-status-routing.test.ts` add a separate structured work-unit readiness projection. It is artifact-only and RDD-independent, rejects duplicate/malformed units, deterministically sorts detached state, and never carries attempt tokens, lease tokens, counters, or reset operations.
- `assets/orchestrator-delegation.md`, `assets/sdd-orchestrator-workflow.md`, `assets/agents/{sdd-tasks,sdd-apply,sdd-verify}.md`, `assets/chains/{sdd-full,sdd-verify}.chain.md`, and `assets/support/sdd-status-contract.md` document the same contracts for provider-neutral orchestration, handoff, chaining, and status routing.

### TDD cycle evidence

Each PR2 behavior followed RED → GREEN → TRIANGULATE → REFACTOR. The RED evidence below records the first failing condition rather than a fabricated count when the initial failure was an import/export or contract absence.

| Work unit | RED | GREEN | TRIANGULATE / REFACTOR |
| --- | --- | --- | --- |
| 2.1 | `node --experimental-strip-types --test tests/work-unit-scheduler.test.ts` first failed with `ERR_MODULE_NOT_FOUND` for the new scheduler module. | Final scheduler run: **11 tests, 11 passed, 0 failed**. | Readiness, dependency, lease, and integration cases remained deterministic and pure; completed IDs are excluded from later ready layers. |
| 2.2 | The same initial scheduler RED exposed the absent lease/settlement implementation before lease behavior could run. | Final scheduler run: **11 tests, 11 passed, 0 failed**. | Existing runtime/guard/policy coverage plus the scheduler suite verified provider-owned attempts, safe parallelism, writer serialization, release, and idempotency. |
| 2.3 | `tests/review-candidate-decoration.test.ts` first failed because `decorateReviewCandidateTask` was not exported. | Candidate decoration plus selected extension integration: **26 tests, 26 passed, 0 failed**. | Candidate/status/controller/policy suite: **185 tests, 185 passed, 0 failed**; immutable projection has no live/provider fallback. |
| 2.4 | Scope tests first failed because `CorrectionScopeError` and the positive-forecast contract were absent; the forecast RED was **1 failed / 5 passed**. | Correction scope plus existing lifecycle: **20 tests, 20 passed, 0 failed**. | Ordinary and Judgment Day policy suites passed in the combined 185-test triangulation; one detached plan is bounded to corroborated findings and paths. |
| 2.5 | The new orchestration contract test initially had **0 passing assertions** because the required DAG/lease asset markers were absent. | Asset/orchestration contract: **4 tests, 4 passed, 0 failed**. | Native attempt-authority regression: **17 tests, 17 passed, 0 failed** after the gatekeeper rerun sentence was bound to fresh native acquire. |
| 2.6 | The same contract RED covered the missing phase-agent handoff markers. | Asset/orchestration contract: **4 tests, 4 passed, 0 failed** with agent handoffs present. | Full package tests and generated-asset/language checks passed; handoffs preserve cumulative apply-progress and forbid Pi-owned attempt state. |
| 2.7 | Status-routing tests first failed on the missing structured routing export and the contract marker was absent. | Status-routing plus orchestration contract: **7 tests, 7 passed, 0 failed**. | Existing SDD status tests and the full package run verified artifact-only routing, no attempt fields, and no Phase 3/4 drift. |

### Verification evidence

Focused checks:

```text
node --experimental-strip-types --test tests/work-unit-scheduler.test.ts
ℹ tests 11
ℹ pass 11
ℹ fail 0

node --experimental-strip-types --test tests/review-candidate-decoration.test.ts tests/gentle-ai.test.ts --test-name-pattern='review delegation decorates|provider-neutral review decoration'
ℹ tests 26
ℹ pass 26
ℹ fail 0

node --experimental-strip-types --test tests/review-correction-scope.test.ts tests/review-correction-lifecycle.test.ts
ℹ tests 20
ℹ pass 20
ℹ fail 0

node --experimental-strip-types --test tests/work-unit-orchestration-contract.test.ts tests/sdd-status-routing.test.ts
ℹ tests 7
ℹ pass 7
ℹ fail 0

node --experimental-strip-types --test tests/native-sdd-attempt-authority.test.ts
ℹ tests 17
ℹ pass 17
ℹ fail 0
```

The combined candidate/status/controller/correction/policy check passed **185 tests, 185 passed, 0 failed**. The final full repository command exited **0**:

```text
pnpm test
ℹ tests 1204
ℹ pass 1203
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
```

The companion checks also exited **0**:

- `pnpm run check:provider-contract` — provider contract mirror passed (contract 1.1.0, 8 bundle entries, 2 generated baselines, acquisition `field-test-local`).
- `pnpm run check:runtime-modules` — runtime matches TypeScript sources (4 modules).
- `pnpm run test:harness` — exit 0.
- `git diff --check` — clean.

### Rollback boundary

PR2 can be reverted in reverse order without touching Phase 3/4 or the PR1 foundation:

1. final PR2 commit — chain/status assets, `lib/sdd-status.ts`, routing/contract tests, and Phase 2 task/progress records;
2. `a25e75d5` — phase-agent handoffs;
3. `53316851` — native-acquire gatekeeper rerun binding;
4. `c678d8f0` — orchestrator DAG/lease assets;
5. `672b4d87` — bounded correction scope;
6. `ffe901ba` — fail-closed candidate registry;
7. `820f7f36` — provider-neutral candidate decoration;
8. `b85b67c9` — completed-layer/final-verification scheduler correction;
9. `737450b0` — scheduler graph and leases.

No push, PR, merge, or release operation was performed. The parent orchestrator retains native attempt settlement authority.

### Remaining unchecked tasks

The following tasks remain unchecked and intentionally outside this PR2 slice: **3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 4.5, and 4.6**.
