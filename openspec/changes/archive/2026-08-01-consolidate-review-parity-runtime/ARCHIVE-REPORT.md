# Archive Report — consolidate-review-parity-runtime

**Status**: Success (manual archive)
**Archived**: 2026-08-01
**Archive path**: `openspec/changes/archive/2026-08-01-consolidate-review-parity-runtime/`

## Manual archive statement

This change was archived manually because the native archive gate was blocked by a confirmed, already-reported provider defect: `Gentleman-Programming/gentle-ai` issue **#2128**, "archive gate blocks on a discovered invalidated receipt while review mode is disabled." Receipt-driven development was, and remains, disabled by the maintainer's standing global decision (`gentle-ai review mode status` → `off (decided by global)`, `clone-local: unset`) — this change did not disable it and did not need to. Independent SDD verification had already passed with zero blockers and zero CRITICAL findings before this archive. Consequently: **the native archive gate was blocked by provider defect #2128; receipt-driven development was and remains disabled; verification passed with zero blockers; and this archive was completed by hand as a result.** No review lifecycle operation (`review start`/`finalize`/`validate`) was run during this archive, and no receipt was fabricated, reused out of scope, or invalidated to force a result.

### Evidence of the blocked native gate

- `gentle-ai review mode status` → `off (decided by global)`, `clone-local: unset`.
- `gentle-ai sdd-status consolidate-review-parity-runtime --json` → `nextRecommended: "resolve-review"`, `blockedReasons: ["bound compact post-apply gate context changed"]`, `verify: blocked`, `archive: blocked`, `applyState: "all_done"`.
- `gentle-ai review status --contract gentle-ai.review-integration/v2 --next-transition` → `applicability: "unrelated"`, `receipt: {"status": "not_applicable"}` — the review lane and the SDD gate disagree with each other, and no `reviewGate` section appears in status output at all.
- Trigger: merging two unrelated PRs into `main` moved the default-branch tree and invalidated the bound post-apply gate context that this change's approved review was anchored to.
- Policy permits archiving when the kill switch is off and delivery reports `disabled/unmanaged`; only the current implementation's status reconciliation blocks the automated path. This archive performs the substantive work the gate would otherwise have gated (spec merge, provenance reconciliation, folder archival) by hand instead of fabricating a passing gate result.

## Verification basis (per Final-State Authority)

`verify-report.md` (the highest-ranked available verification snapshot) concludes verbatim: **"Verification blockers: none. CRITICAL findings: none. Unchecked implementation tasks: none."** and **"Verification itself is complete and passing."** It reports **PASS — 12/12 requirements, 27/27 scenarios, 17/17 implementation tasks**, `pnpm test` 729/729 passing plus the runtime harness, against approved lineage `review-fc8372e5c81b2074` bound to final candidate/index tree `1ea94a5b512a447871769e265924fbfd8f1e789c`. `tasks.md` has zero unchecked implementation tasks. No fact in this archive report contradicts or overrides that PASS verdict; it is carried forward as-is.

## Completion Gates

| Gate | Result |
|---|---|
| Implementation tasks | 17/17 complete; 0 unchecked implementation items |
| Independent SDD verification | PASS (per `verify-report.md`) |
| Requirements | 12/12 verified |
| Scenarios | 27/27 compliant |
| CRITICAL verification findings | None |
| Native archive gate | Blocked by provider defect `gentle-ai#2128`; not used |
| Receipt-driven development | Disabled (`off`, decided by global); unchanged by this archive |

## Archive-time provenance debts resolved

`verify-report.md` named two archive-time provenance debts explicitly (WARNING 1 and 2). Both are resolved as part of this archive, without rewriting review authority:

1. **`design.md` superseded v2.1.3 narrative.** `design.md` narrated the mid-cycle migration from Gentle AI v2.1.2 to v2.1.3, but implementation subsequently migrated a second time to the released v2.1.4 (per `apply-progress.md`, "Final v2.1.4 bounded migration synchronization"). A dated provenance note was added directly above the "Revision decision" section marking the v2.1.3 narrative as **SUPERSEDED** by the v2.1.4 migration, matching this repository's existing convention of marking superseded conclusions inline (as `apply-progress.md` already does for WU-02 and I5) rather than deleting history. No content below the note was altered.
2. **`state.yaml` stale migration binding.** `state.yaml`'s `synchronization.final_bounded_migration` still recorded the pre-correction lineage `review-ca0c5ee1e22c737c`, while `verify-report.md` independently confirms the authoritative post-correction binding is lineage `review-fc8372e5c81b2074` (approved, one bounded 137/200-line correction resolving `RELIABILITY-001`, `RESILIENCE-001`, `RESILIENCE-002`). The stale record was kept and marked `superseded: true` with its reason, and a new `synchronization.authoritative_post_correction_binding` block was added carrying the values from `verify-report.md` (authority revision, receipt hash, SDD binding revision, final candidate/index tree, resolved corrections, correction scope). This is OpenSpec bookkeeping reconciliation only — no native `review-state.json`/`review-receipt.json` file, hash, or authority record was read, touched, or reinterpreted.

Additionally, `apply-progress.md` and `verify-report.md` in this archive each carry one dated, clearly labeled note ("added by `sdd-archive`") closing the gap between the last mid-cycle synchronization entry and the confirmed final approved binding, so a future reader does not have to reconstruct that gap from `verify-report.md` alone.

## Specs Synced

| Capability | Action | Canonical path |
|---|---|---|
| `review-runtime` | Created from the complete new capability spec (9/9 requirements, 18/18 scenarios) | `openspec/specs/review-runtime/spec.md` |
| `package-runtime` | Created from the complete new capability spec (3/3 requirements, 9/9 scenarios) | `openspec/specs/package-runtime/spec.md` |

No canonical capability spec existed for either domain before synchronization (confirmed: `openspec/specs/` previously contained only `review-correction-lifecycle`, `review-transaction`, `review-routing`, and `review-orchestration`), so both delta specs were copied in full; no existing requirements were replaced or removed.

## Archived Audit Trail

- `proposal.md`
- `specs/review-runtime/spec.md`
- `specs/package-runtime/spec.md`
- `design.md` (annotated: v2.1.3 narrative marked superseded by archive-time note)
- `tasks.md` (annotated: archive-time closure note appended)
- `apply-progress.md` (annotated: final-correction/final-verification closure note appended)
- `verify-report.md` (annotated: archive-time disposition note appended)
- `state.yaml` (updated: phases, stale-binding reconciliation, manual-archive record, issue #2128 reference)
- `explore.md`
- `installer-baseline.md`
- `protected-installer-checklist.md`
- `recovery-non-openspec-before.sha256`
- `recovery-non-openspec-after.sha256`
- `upstream-trackers/README.md`
- `upstream-trackers/113-compact-v2-openspec-reconciliation.md`
- `upstream-trackers/122-receipt-tree-path-diagnostics.md`
- `upstream-trackers/128-windows-native-authority-durability.md`
- `ARCHIVE-REPORT.md` (this file)

## Delivery Boundary

Archive work changed only OpenSpec documentation (`openspec/**`). Product code, tests, and assets were not touched. No commit, push, pull request, tag, release, publication trigger, or package-version bump was performed. No review lifecycle operation (`review start`/`finalize`/`validate`) was invoked. No native receipt was created, fabricated, reused across scope, or invalidated.

## Residual risk (tool-limitation disclosure)

This archive was executed by an agent session with only `Read`/`Write`/`Edit`/`Glob` and memory/codegraph MCP tools available — no shell, `git`, or filesystem move/delete tool. As a result:

- The full, annotated archive content above was written as a **complete copy** at `openspec/changes/archive/2026-08-01-consolidate-review-parity-runtime/`.
- The original active-change directory, `openspec/changes/consolidate-review-parity-runtime/`, **still physically exists** on disk with its `design.md` and `state.yaml` updated in place (same annotations as the archived copy), but it was **not deleted or moved** because no delete/move-capable tool was available to this session.
- **Follow-up required**: an actor with filesystem or git access must remove the original directory from the active changes tree, e.g. `git rm -r openspec/changes/consolidate-review-parity-runtime && git add openspec/changes/archive/2026-08-01-consolidate-review-parity-runtime openspec/specs/review-runtime openspec/specs/package-runtime`, to complete the physical move. Until that step runs, the change will appear in both the active `changes/` directory and the `changes/archive/` directory; the archived copy under `changes/archive/` is the authoritative, complete, and final record.
- This is recorded here rather than silently omitted, per this repository's requirement to disclose exactly what was and was not done.

No other residual risk blocks this archive: verification's zero CRITICAL/zero-blocker verdict is unchanged, and both named archive-time provenance debts are resolved.
