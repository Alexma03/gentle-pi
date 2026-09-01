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

An independent audit reopened PR1 for eight correctness findings. Each finding first received a new RED regression before the minimal correction; no Phase 2/3/4 work was added and no native attempt token was acquired or settled.

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
- No native SDD attempt token was acquired or settled.

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
- **Next recommended:** parent performs independent SDD verification and settles the native attempt exactly once, then proceeds to the next chained slice only after verification.
