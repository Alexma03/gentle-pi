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

| Task | Status | Commit | Scope |
|---|---|---|---|
| 1.1 | complete | `a688c5f7` | Provider-neutral runtime port, DTO validation, negotiation, lifecycle semantics |
| 1.2 | complete | `d37ac463` | Nicobailon `npm:pi-subagents` adapter and exact RPC lock |
| 1.3 | complete | `4ca68568` | Correlated replies, protocol drift rejection, bounded completion |
| 1.4 | complete | `93cf6908` | Canonical worktree/repository binding and command/path guard |
| 1.5 | complete | `4672fb39` | Injected runtime + guard extension delegation route |
| 2.1–2.7 | not started | — | DAG/review work deferred to PR2 |
| 3.1–3.6 | not started | — | Surface migration deferred to PR3 |
| 4.1–4.6 | not started | — | Release/evidence work deferred to PR4 |

## TDD Cycle Evidence

Each task followed RED → GREEN → triangulate → refactor. The focused runs below are the final task-local GREEN evidence; the RED evidence records the observed pre-production failure or edge regression that drove the implementation.

### 1.1 — Runtime port

- **RED:** `node --experimental-strip-types --test tests/subagent-runtime.test.ts` failed before the implementation because `lib/subagent-runtime.ts` was missing (`ERR_MODULE_NOT_FOUND`).
- **GREEN:** `node --experimental-strip-types --test tests/subagent-runtime.test.ts` → **6 tests, 6 passed, 0 failed**.
- **Triangulate:** final PR1 focused run over runtime, adapter, guard, and extension tests → **42 tests, 42 passed, 0 failed**.
- **Refactor:** validation is centralized around exact portable task/result DTOs; negotiation is fail-closed for protocol and mandatory-capability drift; commit `a688c5f7`.

### 1.2 — Nicobailon adapter and RPC lock

- **RED:** `node --experimental-strip-types --test tests/nicobailon-subagent-adapter.test.ts` failed before the implementation because the adapter module and RPC lock were missing (`ERR_MODULE_NOT_FOUND`).
- **GREEN:** `node --experimental-strip-types --test tests/nicobailon-subagent-adapter.test.ts` → **7 tests, 7 passed, 0 failed**.
- **Triangulate:** adapter tests verify ready/ping negotiation, async-only spawn, status/stop, correlated replies, async completion, and the lock bytes; combined PR1 run → **42/42 passed**.
- **Refactor:** the adapter is the sole Nicobailon boundary and never invents a result RPC; commit `d37ac463`.

### 1.3 — Correlation, drift, and completion bounds

- **RED:** `timeout 2s node --experimental-strip-types --test tests/subagent-runtime.test.ts` produced **5 passing tests with the event-backed completion test still pending and exit 124** before the controller timeout was implemented. The protocol-conflict regression also produced **1 failure / 6 passes** in the adapter file before its validation fix.
- **GREEN:** `node --experimental-strip-types --test tests/subagent-runtime.test.ts tests/nicobailon-subagent-adapter.test.ts` → **13 tests, 13 passed, 0 failed**.
- **Triangulate:** completion derives from status/events, replies are matched by request ID, and a valid envelope carrying a conflicting protocol marker is rejected; final PR1 run → **42/42 passed**.
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

## Work Unit Evidence

### Focused PR1 proof

```text
node --experimental-strip-types --test tests/subagent-runtime.test.ts tests/nicobailon-subagent-adapter.test.ts tests/workspace-guard.test.ts tests/gentle-ai.test.ts
ℹ tests 42
ℹ pass 42
ℹ fail 0
ℹ skipped 0
```

The per-task focused totals are 6/6 runtime, 7/7 adapter, 9/9 guard, and 20/20 extension tests.

### Full repository proof

```text
pnpm test
ℹ tests 1180
ℹ pass 1179
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1

$ node scripts/check-provider-contract.mjs
... provider contract mirror check passed (contract 1.1.0, 8 bundle entries, 2 generated baselines, acquisition field-test-local).

$ node --experimental-strip-types tests/runtime-harness.mjs
exit 0
```

The exact full command exited **0**. The harness was also rerun directly with `pnpm run test:harness` and exited **0**.

### Git/evidence checks

- `git diff --check` passed.
- Worktree was clean before this apply-progress artifact was written.
- No push, PR, merge, or release operation was performed.
- No native SDD attempt token was acquired or settled.

## Rollback boundary

PR1 can be reverted in reverse order without touching later phases:

1. `4672fb39` — extension delegation route and tests
2. `93cf6908` — workspace guard and tests
3. `4ca68568` — runtime/adapter hardening and tests
4. `d37ac463` — Nicobailon adapter, RPC lock, and tests
5. `a688c5f7` — runtime port and tests

The boundary includes only `lib/subagent-runtime.ts`, `lib/nicobailon-subagent-adapter.ts`, `lib/workspace-guard.ts`, `contracts/pi-subagents-rpc-v1.lock.json`, the paired tests, `extensions/gentle-ai.ts`, and the PR1 task checkboxes. Phase 2/3/4 behavior and artifacts remain outside this rollback boundary.

## Blockers and next steps

- **PR1 blockers:** none observed; the complete test command and harness pass.
- **Deferred work:** tasks 2.1–4.6 remain unchecked by design.
- **Next recommended:** parent performs independent SDD verification and settles the native attempt exactly once, then proceeds to the next chained slice only after verification.
