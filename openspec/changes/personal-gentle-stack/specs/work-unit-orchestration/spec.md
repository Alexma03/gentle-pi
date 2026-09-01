# Work-Unit Orchestration Specification

## Purpose

Define atomic DAG scheduling, evidence, and integration gates.

## Requirements

### Requirement: Dependency-safe work units

The scheduler MUST represent work as atomic DAG units, run only dependency-ready units, allow parallelism only for isolated units, enforce one writer per worktree, and require focused checks plus final verification before integration.

#### Scenario: Independent units run safely

- GIVEN two dependency-ready units target isolated worktrees
- WHEN scheduling evaluates them
- THEN they MAY run in parallel and each records status and evidence

#### Scenario: Writer conflict or failed dependency

- GIVEN units share a worktree writer or a dependency is incomplete
- WHEN scheduling evaluates them
- THEN the conflicting unit is not started until safe and dependency-ready
- AND integration remains blocked until final verification passes
