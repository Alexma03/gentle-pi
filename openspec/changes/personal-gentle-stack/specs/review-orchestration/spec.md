# Delta for Review Orchestration

## MODIFIED Requirements

### Requirement: Bounded convergence and Judgment Day

Ordinary MAY enter `correction_required` once and authorize one bounded correction semantically scoped to confirmed frozen finding IDs and their relevant paths. When required, it MUST run one proportional final-candidate RDD transaction with one positive pre-edit forecast of intended correction scope and effects, one correction that MUST NOT add unrelated functionality or modify unrelated paths, one validator for original criteria plus correction regression, and one post-correction final verification. Failed targeted validation, correction exhaustion, malformed evidence, or final-verification failure escalates; it never reruns initial lenses or refutation, changes frozen claims, adds work, or launches discovery actors. No-fix uses zero validators. RDD evidence remains independent of ordinary delivery. Explicit Judgment Day replaces ordinary, uses two blind judges and zero refuters, and alone permits discovery re-judgment rounds.
(Previously: ordinary and Judgment Day shared bounded iteration rules without explicitly requiring one final-candidate RDD transaction.)

#### Scenario: Fix path

- GIVEN an ordinary correction attempt passes targeted validation
- WHEN the final-candidate RDD transaction advances
- THEN one final verification runs without rerunning initial review

#### Scenario: No-fix or failure

- GIVEN no fix, a failed targeted validation, or correction/final-verification exhaustion
- WHEN the transaction is reduced
- THEN no-fix has zero validators and every failed correction or final verification escalates without another attempt

#### Scenario: Judgment Day

- GIVEN explicit Judgment Day
- WHEN review runs
- THEN two blind judges and zero refuters run

#### Scenario: Judgment Day limit

- GIVEN findings survive round two
- WHEN evaluated
- THEN no third round runs and the transaction escalates
