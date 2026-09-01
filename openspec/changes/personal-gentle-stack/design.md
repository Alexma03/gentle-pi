# Design: Personal Gentle Stack — Gentle Pi

## Technical Approach

Create `SubagentRuntimeV1` with exactly one Nicobailon RPC v1 adapter. A successful capability `ping` is mandatory; otherwise fail closed with no alternate/fallback provider. Orca owns the worktree, Gentle Pi its binding/guard, and Gentle AI attempt/review authority. Review evidence never governs ordinary delivery.

## Architecture Decisions

| Decision | Choice | Rejected | Rationale |
|---|---|---|---|
| Runtime boundary | `lib/subagent-runtime.ts` owns portable DTOs/lifecycle; `lib/nicobailon-subagent-adapter.ts` alone maps RPC | Tool inference; provider internals | Hides RPC churn behind conformance tests. |
| Workspace and review view | Bind canonical `ctx.cwd`, Git common-dir, and worktree identity once; tasks cannot override. Before `start`, `ReviewCandidateDecorator` resolves the controller-owned read-only frozen snapshot and verifies exact content/tree identity. Failure denies dispatch before any actor; no live-worktree/provider fallback exists. | Per-task surfaces; runtime worktrees | Preserves Orca and immutable review. |
| Scheduling authority | `WorkUnitSchedulerV1` first proves dependencies complete and no writer conflict. Only then acquire by work-unit identity; start on `proceed`, settle terminal evidence. Concurrent native leases enable isolated parallel units; otherwise attempt-bearing units serialize. | Acquire-before-readiness; host authority | Native status stays authoritative. |
| Final RDD | One positive pre-edit forecast of scope/effects precedes exactly one ordinary correction, semantically bounded to confirmed frozen finding IDs and relevant paths. There is NO changed-line or numeric line budget; unrelated features/paths are forbidden. One targeted validator checks original criteria/regression, then one post-correction final verification. No-fix uses zero validators. Malformed, failed, or exhausted proof escalates without rerunning lenses/refutation. Judgment Day replaces ordinary with two blind judges, zero refuters, at most two judgment rounds; survivors escalate. | Per-unit review; numeric budgets | Evidence remains delivery-independent. |

## Data Flow

`SDD tasks -> dependency/writer readiness -> native acquire -> workspace guard -> runtime port -> Nicobailon RPC v1`

`completion -> focused check -> native settle/status -> normalization/integration -> full verification -> optional final RDD -> ordinary delivery`

## File Changes

| File | Action | Description |
|---|---|---|
| `lib/subagent-runtime.ts`, `lib/nicobailon-subagent-adapter.ts` | Create | Versioned port, negotiation, RPC correlation, normalized lifecycle. |
| `lib/workspace-guard.ts`, `lib/work-unit-scheduler.ts` | Create | Orca binding, path/command protection, DAG readiness, writer leases, evidence. |
| `extensions/gentle-ai.ts`, `lib/review-candidate-view.ts`, `lib/sdd-status.ts` | Modify | Route execution/review/status through the new modules; remove j0k3r/Tintinweb package/tool probes and payload mutation. |
| `assets/orchestrator-delegation.md`, `assets/sdd-orchestrator-workflow.md`, `assets/agents/sdd-tasks.md`, `assets/agents/sdd-apply.md`, `assets/agents/sdd-verify.md`, `assets/chains/sdd-full.chain.md`, `assets/chains/sdd-verify.chain.md`, `assets/support/sdd-status-contract.md` | Modify | Provider-neutral atomic work/result and integration contracts. |
| `lib/sdd-preflight.ts`, `package.json`, `pnpm-lock.yaml`, `README.md`, `scripts/check-provider-contract.mjs`, `scripts/verify-package-files.mjs`, `contracts/pi-subagents-rpc-v1.lock.json` | Modify/Create | Managed retirement, retained integrations, exact RPC/package evidence, and forbidden GGA/plugin inventory. |
| `extensions/pi-pretty.ts`, `extensions/startup-banner.ts`, `themes/Gentle.json`, `themes/Gentleman-Cute.json`, `themes/Gentleman-Sexy.json`, `assets/gentle-logo-only.png`, `tests/gentle-theme.test.ts` | Delete | Remove cosmetic/community surface. |
| `tests/subagent-runtime.test.ts`, `tests/workspace-guard.test.ts`, `tests/work-unit-scheduler.test.ts`, `tests/runtime-harness.mjs`, `tests/package-manifest.test.ts` | Create/Modify | Contract, boundary, DAG, retained-surface, and package coverage. |

## Interfaces / Contracts

`SubagentTaskV1` contains only `task`, `context`, `dependencies`, `expectedOutcome`; `SubagentResultV1` only `status`, `summary`, `evidence`, `blockers`. Controller-owned role, binding, handle, and cancellation remain external. The port exposes `negotiate/start/status/result/cancel`; admission requires protocol `1`, `spawn/status/stop`, and `events.asyncComplete`.

## Testing Strategy

| Layer | Approach |
|---|---|
| Unit | Strict RED -> GREEN -> TRIANGULATE -> REFACTOR for RPC/DTO validation, readiness-before-acquire, lease concurrency/serialization, writer conflicts, and guard denial. |
| Integration | Stub and real-package harnesses prove lifecycle bindings, pre-actor snapshot identity failure/no fallback, every RDD branch, focused checks, Engram/Context7/CodeGraph, and basic UI. |
| Release | Node 24 on Linux/macOS/Windows: focused suites, harness, `pnpm test`, runtime/package checks, packed install, then proportional final RDD when required. |

## Threat Matrix

| Boundary | Applicability | Safe/failure behavior | Planned RED tests |
|---|---|---|---|
| Documentation-like paths | N/A: no executable-file classification changes | Existing file handling remains data-only | None |
| Git repository selection | Applicable | `git -C`, relative, and absolute paths must resolve to the bound worktree; escape or another worktree is denied without rebinding | One case per selector plus symlink/junction escape |
| Commit state | N/A: no index or commit automation | Existing semantics unchanged | None |
| Push state | Applicable: destructive-command policy is centralized | Tracking, first-push, and explicit-refspec forms receive the configured guard; force/ambiguous forms fail closed | One case per push form and force variant |
| PR commands | N/A: no PR automation | Existing policy unchanged | None |

## Migration / Rollout

Publish and record an RPC-v1-capable `npm:pi-subagents` version/digest. Land Gentle Pi, then update Gentle AI's transactional installer, binary pin, DAG authority contract, and inventory together. Inventory removes GGA and marketplace/community-plugin features—`pi-web-access`, `@juicesharp/rpiv-todo`, `@juicesharp/rpiv-ask-user-question`, `pi-btw`; verification rejects their assets/docs/install entries. Run the cross-OS matrix before coordinated release. Rollback restores both prior releases/manifests, never a legacy adapter. Commit/push/PR/release remain ordinary policy regardless of RDD.

## Open Questions

None.
