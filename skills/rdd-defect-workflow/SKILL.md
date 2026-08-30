---
name: gentle-ai-rdd-defect-workflow
description: "Trigger: RDD, receipt-driven development, review authority, receipt/lineage, correction/recovery, delivery gate/kill switch, bounded review defects. Guide work."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## Activation Contract

Load when the frontmatter trigger terms apply to a defect workflow.

This skill guides public collaboration. It does not grant issue approval, label, review, exception, or merge authority.

## Hard Rules

- Review and Judgment Day evidence is review-only. Pi never mints delivery authority: ordinary commit, push, PR, and release always follow repository policy, regardless of RDD mode.
- Require an approved issue (`status:approved`) and clean current `main` reproduction before implementation. Audit existing PRs for supersession or conflict; stop or narrow stale claims.
- Group by causal authority invariant. Use one issue and one PR or explicit chain per independent invariant and rollback boundary. Split independent causes; never merge a superseded or conflicting authority line.
- Inventory every operator flow claimed by the issue or PR, including entry, mode, environment, expectation, and negative controls. Require one truthful black-box bench journey per CLI or lifecycle flow, or actual runtime E2E proof when the core bench cannot represent it. Synthetic proxy coverage never proves another runtime.
- Use CodeGraph-first impact mapping, a dedicated worktree, and behavior-first tests. Run source-mutating normalization before candidate freeze.
- Assess conceptual complexity, cohesion, affected domains, interface and rollback boundaries, risk, verification burden, and reviewer cognitive load before edits. Chain only at natural work boundaries; never estimate or gate on changed lines.
- When RDD is enabled, bind review receipts, lineage, correction, and recovery evidence to the exact candidate. Keep bounded review defects in one correction transaction; never treat that evidence as delivery authority.
- Require independent read-only candidate validation before publication. Validation cannot edit source or authority; findings require a new candidate.
- Keep communication humane and evidence-based. Repository labels and workflow metadata are maintainer-owned, never evidence of contributor blame.

## Decision Gates

| Condition | Action |
| --- | --- |
| Any RDD mode | Review evidence remains review-only; ordinary commit, push, PR, and release follow repository policy with no Pi delivery authority. |
| Issue gate or reproduction fails | Wait, stop, or narrow with evidence. |
| Invariant or rollback is independent | Separate issue and authoritative PR line. |
| Core bench fits / does not fit | Bench journey / actual runtime E2E; never proxy. |
| Independent domain, interface, rollback, or verification boundaries exist | Chain at those natural boundaries before edits. |
| Change remains one cohesive invariant | Keep one PR and explain its review and rollback story. |

## Execution Steps

1. Check mode, approval, PR conflicts, and current-main reproduction.
2. Name invariant and rollback; isolate the worktree; CodeGraph-map code, tests, evidence, docs, distribution, and registration.
3. Inventory flows and controls; add failing tests and the smallest correction.
4. Normalize, preserve the approved scope and qualitative work boundaries, run tests, and record each flow's exact candidate, command, scenario, and result.
5. Freeze, validate read-only, and give the verdict, evidence, and one humane next action.

## Output Contract

Return `rdd_mode`, `issue_pr`, `causal_invariant`, `operator_flows`, `journey_runtime_evidence`, `workload_assessment`, `tests`, `rollback`, and `unresolved_authority_decisions`.

Identify approved and superseded/conflicting authority lines; every flow, negative control, and candidate-bound proof; qualitative scope, cohesion, risk, and any natural chain boundary; test results; independent rollback; and unresolved maintainer decisions. Never use changed-line counts as workload evidence.

## References

No supporting files. Current repository policy remains authoritative.
