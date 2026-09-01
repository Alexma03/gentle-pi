# Delta for Review Runtime

## MODIFIED Requirements

### Requirement: Reviewers inspect the immutable candidate snapshot

The controller MUST provide every selected reviewer with a read-only, resolvable view of the frozen candidate identified by the review authority through the negotiated runtime port. Reviewer dispatch MUST fail closed before any actor starts when the snapshot cannot be resolved or its content identity cannot be verified. Reviewers MUST NOT fall back to the live working directory or an alternate provider.
(Previously: the controller provided the immutable snapshot without requiring dispatch through the negotiated runtime port.)

#### Scenario: Frozen content differs from the live worktree

- GIVEN a review snapshot has been frozen and the live worktree is subsequently changed
- WHEN a selected reviewer reads the candidate through the runtime port
- THEN the reviewer reads the frozen snapshot content and not the live worktree content

#### Scenario: Snapshot resolution fails

- GIVEN a selected reviewer has no resolvable controller-owned snapshot context
- WHEN dispatch is requested through the runtime port
- THEN dispatch is denied before actor execution and the failure identifies snapshot resolution or identity verification
