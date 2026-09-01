# Workspace Guardrails Specification

## Purpose

Define Orca-owned worktree binding and safe access boundaries.

## Requirements

### Requirement: Orca-bound execution

Each execution MUST bind once to its Orca-owned worktree. Local reads and writes MAY occur inside that binding, while secrets, external paths, destructive commands, and cross-worktree access MUST remain protected.

#### Scenario: Bound local edit

- GIVEN an execution is bound to an Orca worktree
- WHEN a task reads or writes an allowed repository path
- THEN the operation succeeds within that worktree

#### Scenario: Cross-worktree or protected access

- GIVEN a task requests a secret, external path, destructive command, or another worktree
- WHEN access is evaluated
- THEN the operation is denied and the binding remains unchanged
