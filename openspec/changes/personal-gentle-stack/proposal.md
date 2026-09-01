# Proposal: Personal Gentle Stack — Gentle Pi

## Intent

Replace provider coupling and phase-sized SDD execution with a capability-driven runtime and atomic work units. Keep Orca and Gentle AI responsible for isolation and authority.

## Scope

### In Scope
- Integrate only `npm:pi-subagents` from `nicobailon/nicopreme` through one narrow port and one Nicobailon adapter using versioned RPC and advertised capabilities.
- Bind execution once to the Orca worktree; permit local reads/writes while retaining secrets, external-path, destructive-command, and cross-worktree protections.
- Use DAG work units, safe parallelism, one writer per worktree, focused checks, final verification, and one final complex-candidate RDD transaction.
- Limit task/result contracts to task, context, dependencies, expected outcome, status, summary, evidence, and blockers.
- Remove GGA, branding, marketplace/plugin features, and unused assets; retain Engram, Context7, CodeGraph, behavioral SDD assets, and basic Pi UI.

### Out of Scope
- Tintinweb, j0k3r, alternate adapters, compatibility paths, provider inference, or Gentle Pi-managed isolation.

## Capabilities

### New Capabilities
- `subagent-runtime`: Negotiated Nicobailon RPC lifecycle and portable contracts.
- `workspace-guardrails`: Orca-bound access and protections.
- `work-unit-orchestration`: DAG scheduling, evidence, parallelism, and integration gates.
- `package-surface`: Retained behavior and retired cosmetic/community features.

### Modified Capabilities
- `review-runtime`: Dispatch immutable inputs through the runtime port.
- `review-orchestration`: Run one proportional final-candidate RDD transaction when required.
- `package-runtime`: Coordinate binaries, contracts, dependencies, and release evidence.

## Approach

Introduce the port, adapter, binding, and conformance tests; migrate prompts and scheduling; remove obsolete surfaces. Advertised capabilities alone govern operations.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `extensions/gentle-ai.ts`, `lib/` | Modified | Runtime, guardrails, review, DAG status |
| `assets/agents/`, `assets/chains/`, `assets/support/` | Modified | Behavioral contracts |
| `themes/`, `assets/`, `extensions/startup-banner.ts` | Removed | Branding/community assets |
| `tests/`, `scripts/`, `runtime/`, `package.json` | Modified | Verification and packaging |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| RPC drift | Medium | Validate capabilities; fail closed |
| Unsafe concurrency | Medium | One writer per worktree; parallelize isolated work only |
| Contract mismatch | High | Coordinate releases with Gentle AI |

## Rollback Plan

Revert Gentle Pi and Gentle AI together, restore the managed-asset manifest and lockfile, and rerun package verification. Do not retain a legacy adapter.

## Dependencies

- Companion Gentle AI change for installer cleanup, binary/contracts, DAG attempt/status authority, and coordinated releases.
- Published `npm:pi-subagents` RPC contract.

## Success Criteria

- [ ] Linux, macOS, and Windows runtime, package, and boundary suites pass.
- [ ] No Tintinweb/j0k3r dependency, adapter, fallback, prompt, or documentation remains.
- [ ] DAG execution proves evidence, safe parallelism, single-writer enforcement, final verification, and proportional native RDD.
- [ ] Retained integrations and SDD assets remain functional.
