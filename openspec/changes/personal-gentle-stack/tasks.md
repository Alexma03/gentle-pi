# Tasks: Personal Gentle Stack — Gentle Pi

## Workload Forecast

| Field | Value |
|---|---|
| Complexity and cohesion | High: cross-boundary |
| Domain/interface boundaries | Four: runtime, review, surface, release |
| Verification and risk burden | High: strict TDD, immutable |
| Chained PRs recommended | Yes |
| Suggested split | PR1 base=feature/tracker branch → PR2 base=PR1 branch → PR3 base=PR2 → PR4 base=PR3 |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain

### Suggested Work Units

| Unit | Goal | PR/base | Proof | Harness | Rollback |
|---|---|---|---|---|---|
| 1 | Runtime/guard | PR1/feature-tracker | runtime/guard tests | `pnpm run test:harness` binding | revert runtime |
| 2 | DAG and review | PR2/PR1 | scheduler/snapshot tests | harness snapshot/RDD | revert scheduler/review |
| 3 | Surface migration | PR3/PR2 | manifest/retained tests | N/A: inventory | revert removals/manifest |
| 4 | Release evidence | PR4/PR3 | `pnpm test`/checks | packed install | revert release changes |

## Phase 1: Runtime/Guard
- [x] 1.1 **RED** `tests/subagent-runtime.test.ts` DTO/capability; **GREEN** `lib/subagent-runtime.ts`; **REFACTOR** validation. D:—; P: fail-closed.
- [x] 1.2 **RED** adapter lifecycle tests; **GREEN** `lib/nicobailon-subagent-adapter.ts`, RPC lock; **REFACTOR** gate. D:1.1; P: start/status/result/cancel.
- [x] 1.3 **RED** mismatch tests; **GREEN** runtime/adapter correlation/errors; **REFACTOR** evidence. D:1.2; P: correlated RPC.
- [x] 1.4 **RED** `tests/workspace-guard.test.ts` selectors/symlink/push variants; **GREEN** `lib/workspace-guard.ts`; **REFACTOR** denial API. D:1.3; P: protected denial.
- [ ] 1.5 **RED** `tests/gentle-ai.test.ts` routing; **GREEN** `extensions/gentle-ai.ts`; **REFACTOR** remove probes. D:1.4; P: tests.

## Phase 2: DAG/Review
- [ ] 2.1 **RED** readiness tests; **GREEN** `lib/work-unit-scheduler.ts`; **REFACTOR** DAG status. D:1.5; P: incomplete deps never acquire.
- [ ] 2.2 **RED** lease conflict/parallel tests; **GREEN** leases/settle; **REFACTOR** serialization. D:2.1; P: safe concurrency.
- [ ] 2.3 **RED** immutable identity/no-fallback tests; **GREEN** `lib/review-candidate-view.ts`, `lib/sdd-status.ts`; **REFACTOR** resolver errors. D:2.2; P: pre-actor denial.
- [ ] 2.4 **RED** finding/path/RDD tests; **GREEN** `lib/review-correction-lifecycle.ts`; **REFACTOR** Judgment Day. D:2.3; P: no rerun/discovery.
- [ ] 2.5 **RED/GREEN/REFACTOR** `assets/orchestrator-delegation.md`, `assets/sdd-orchestrator-workflow.md`. D:2.4; P: provider-neutral contracts.
- [ ] 2.6 **RED/GREEN/REFACTOR** `assets/agents/{sdd-tasks,sdd-apply,sdd-verify}.md`. D:2.5; P: handoffs.
- [ ] 2.7 **RED/GREEN/REFACTOR** `assets/chains/{sdd-full,sdd-verify}.chain.md`, `assets/support/sdd-status-contract.md`. D:2.6; P: status routing.

## Phase 3: Surface
- [ ] 3.1 **RED/GREEN/REFACTOR** GGA inventory/removal in assets/docs/installer. D:2.7; P: forbidden scan.
- [ ] 3.2 **RED/GREEN/REFACTOR** Tintinweb/j0k3r adapters/fallbacks/prompts/docs. D:3.1; P: zero references.
- [ ] 3.3 **RED/GREEN/REFACTOR** delete themes/logos/banner. D:3.2; P: no cosmetic files.
- [ ] 3.4 **RED/GREEN/REFACTOR** remove community/plugin features/docs. D:3.3; P: retired inventory absent.
- [ ] 3.5 **RED/GREEN/REFACTOR** retained Engram/Context7/CodeGraph/UI tests/preflight. D:3.4; P: retained use.
- [ ] 3.6 **RED/GREEN/REFACTOR** `package.json`, `pnpm-lock.yaml`, package verifier. D:3.5; P: install inventory.

## Phase 4: Release
- [ ] 4.1 **RED/GREEN/REFACTOR** provider contract script/lock. D:3.6; P: `pnpm run check:provider-contract`.
- [ ] 4.2 **RED/GREEN/REFACTOR** generated `runtime/*`. D:4.1; P: `pnpm run check:runtime-modules`.
- [ ] 4.3 **RED/GREEN/REFACTOR** `scripts/verify-package-files.mjs`. D:4.2; P: package verification.
- [ ] 4.4 **RED/GREEN/REFACTOR** `tests/runtime-harness.mjs` binding/snapshot/RDD. D:4.3; P: `pnpm run test:harness`.
- [ ] 4.5 **RED/GREEN/REFACTOR** aggregate tests. D:4.4; P: `pnpm test`.
- [ ] 4.6 **RED/GREEN/REFACTOR** Node 24 OS matrix + Gentle AI release/rollback. D:4.5; P: final matrix.
