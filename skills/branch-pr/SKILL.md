---
name: gentle-ai-branch-pr
description: "Trigger: creating, opening, or preparing branches and pull requests. No mandatory issue linkage."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "3.0"
---

# Gentle AI — Branch & PR Skill

## When to Use

Load this skill when creating a branch, preparing a pull request, or opening a pull request.

## Critical Rules

1. **GitHub issues are optional.** Never require, create, search, or link an issue unless the user explicitly asks for that issue operation. An existing issue may be linked when it is genuinely useful, but it never authorizes or blocks implementation, review, or delivery.
2. **Use ordinary repository policy.** Confirm the target branch, inspect the final diff, run applicable checks, and follow actual branch protection without inventing extra gates.
3. **Keep review units cohesive.** Split only at natural architectural, domain, interface, risk, verification, or rollback boundaries; never use changed-line counts.
4. **Use Conventional Commits.** Never add `Co-Authored-By` or AI attribution to commits.
5. **Never force-push a protected branch.**

## Workflow

1. Confirm the repository, target branch, and requested delivery scope.
2. Create a descriptive branch from the intended base.
3. Implement one cohesive work unit and run applicable checks.
4. Inspect the final diff and commit with Conventional Commits.
5. Push and open the PR with a truthful summary and test evidence.
6. Link an issue only when the user explicitly requested it or supplied one.

## Branch Naming

Prefer `<type>/<short-description>` with a conventional type such as `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, or `chore`. Follow a repository-specific convention when one exists.

## PR Body

Include:

- A concise summary and motivation.
- The important files or areas changed.
- Exact checks run and their outcomes.
- Rollback or migration notes when relevant.
- An optional issue link only when explicitly requested.

## Completion

Return the branch, commit, PR URL when created, test evidence, and any real repository-policy blocker. Never report a missing issue as a blocker.
