---
name: gentle-ai-rdd-defect-workflow
description: "Trigger: RDD, receipt-driven development, review authority, receipt/lineage, correction/recovery, delivery gate/kill switch, bounded review defects. Guide work."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "2.0"
---

## Activation Contract

Load when receipt-driven review or a defect workflow needs candidate identity, bounded correction, or review evidence.

This skill guides technical work. It does not create GitHub policy or require external tracking artifacts.

## Hard Rules

- Check the user-owned RDD switch first. When disabled, do not start receipt reviews or fabricate approval; follow ordinary repository policy and report `disabled/unmanaged`.
- When RDD is enabled, review applicable candidates automatically. Do not ask for a second candidate-scoped consent. The global or clone-local disable command is the user-owned kill switch.
- GitHub issues are optional. Never require, create, search, approve, or link an issue unless the user explicitly asks for that issue operation. Missing issue metadata never blocks implementation, review, recovery, or delivery.
- Reproduce from the state relevant to the task. Do not force a clean `main` reproduction when the active worktree, incident state, or production recovery is the authoritative context.
- Group work by causal invariant and rollback boundary. Split independent causes; keep one cohesive correction together.
- Assess review workload through causal cohesion, architecture, risk, verification, and rollback boundaries rather than changed-line counts.
- Inventory every operator flow in scope, including entry, mode, environment, expectation, and negative controls. Prefer truthful runtime evidence over synthetic proxies.
- Use CodeGraph-first impact mapping, a dedicated worktree, and behavior-first tests. Run source-mutating normalization before candidate freeze.
- Bind review candidate identity, lineage, correction, and recovery records exactly. Keep bounded review defects in one correction transaction; ordinary repository policy decides delivery.
- Require independent read-only candidate validation before publication when applicable. Validation cannot edit source or authority; findings require a new candidate.

## Decision Gates

| Condition | Action |
| --- | --- |
| RDD disabled | Ordinary policy; `disabled/unmanaged`; no receipt or approval claim. |
| RDD enabled | Start applicable review automatically; no candidate consent prompt. |
| Missing GitHub issue | Continue; issue tracking is optional. |
| Reproduction context is uncertain | Use the task's actual worktree or incident state and state the evidence gap. |
| Invariant or rollback is independent | Separate the implementation and delivery unit. |
| Change remains one cohesive invariant | Keep one review unit and explain its rollback story. |

## Execution Steps

1. Check RDD mode and identify the authoritative task/worktree state.
2. Name the causal invariant and rollback boundary; CodeGraph-map code, tests, evidence, docs, distribution, and registration.
3. Inventory flows and controls; add failing tests and the smallest correction.
4. Normalize, run applicable checks, and record exact candidate-bound evidence.
5. Freeze, validate read-only, and report the verdict plus one concrete next action.

## Output Contract

Return `rdd_mode`, `causal_invariant`, `operator_flows`, `runtime_evidence`, `workload_assessment`, `tests`, `rollback`, and `unresolved_technical_decisions`.

Do not include issue approval, issue linkage, or missing issue metadata as authority or as a blocker.
