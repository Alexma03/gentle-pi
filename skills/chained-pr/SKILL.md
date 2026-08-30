---
name: gentle-ai-chained-pr
description: "Trigger: stacked PRs, chained PRs, review slices, reviewer cognitive load. Split multi-boundary changes into coherent chained PRs."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## Activation Contract

Load this skill when SDD forecasts `Chained PRs recommended: Yes`, the work crosses natural domain/interface/risk boundaries, or the user asks for chained/stacked PRs, review slices, or reviewer-load control.

## Hard Rules

- Split only at natural architectural, domain, interface, risk, or verification boundaries.
- Never estimate, count, display, or gate on changed lines or review minutes.
- Never deform a correct cohesive solution merely to create smaller diffs.
- Use one deliverable work unit per PR; keep tests/docs with the unit they verify.
- State start, end, prior dependencies, follow-up work, and out-of-scope items in every chained PR.
- Every child PR must include a dependency diagram marking the current PR with `📍`.
- In Feature Branch Chain, create a draft/no-merge tracker PR; child PR #1 targets the tracker branch, later children target the immediate parent branch.
- Treat polluted diffs as base bugs: retarget or rebase until only the current work unit appears.
- Do not mix chain strategies after the user chooses one.

## Decision Gates

| Condition | Action |
|---|---|
| Change is cohesive and focused | Keep a single PR regardless of its diff size. |
| Natural slices can land independently | Use Stacked PRs to main. |
| Feature must integrate before main | Use Feature Branch Chain with tracker. |
| Generated/vendor/migration work cannot split coherently | Keep one PR and explain the cohesion and verification plan. |
| SDD provides `delivery_strategy` | Follow it before apply/PR creation. |

## Execution Steps

1. Assess conceptual complexity, cohesion, domains, interfaces, risk, verification burden, and independent work units without counting lines.
2. Ask for a chain strategy when none is cached and natural chaining boundaries are selected.
3. Create branches/PRs using the chosen strategy only.
4. Add Chain Context to each PR without replacing the repo PR template.
5. Verify each PR independently: CI/tests/docs/manual checks, rollback scope, and clean diff.
6. Keep tracker PR draft/no-merge until all child PRs are reviewed and integrated.

## Output Contract

Return the chosen strategy, PR order, current PR boundary, dependency diagram, qualitative workload rationale, verification plan, and any unresolved cohesion or dependency risk.

## References

- [references/chaining-details.md](references/chaining-details.md) — strategy diagrams, PR body section, branch commands, and reviewer guidance.
