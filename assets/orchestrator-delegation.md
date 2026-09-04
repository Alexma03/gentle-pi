# Orchestrator — Delegation Detail (lazy-loaded)

Bind this to the parent Pi session only, on delegation or routing triggers. Not always-on; loaded on demand from `assets/orchestrator.md`'s pointers.

### Lossless Blocking Prompts (MANDATORY)

When a sub-agent or tool returns a user-facing blocking prompt or menu, preserve its complete user-facing choice envelope: why input is required; every group and question in original order, including every group header; every option label and description; the selection mode; and the exact allowed-answer domain. Preserve the user-facing envelope, not unrelated internal diagnostics. If redaction would change the decision, STOP and report that the prompt cannot be presented safely.

- Never summarize, abbreviate, reorder, relabel, merge, or omit choices. Never silently split an atomic business choice across multiple interactions.
- Native route: For every strictly closed single-select envelope, use `ask_user_choice` only when it is available in the current interactive TUI and the complete envelope is exactly representable as one question with 2-4 ordered options. Pass each option's user-facing label and description plus its envelope-owned canonical option token as opaque `value`. The native selector exposes no custom/free-text or multi-select path and returns exactly one `value`; map it to the envelope-owned choice once, then select any envelope-owned continuation or invocation once where present. For any invocation-bearing envelope, execute only the exact captured provider-owned choice invocation; never synthesize it. Do not re-parse its label or ordinal. `ask_user_question` is the externally owned open/free-text questionnaire: use it only for an open/free-text envelope it can represent, never for a closed domain. Otherwise fall through to the Fallback clause below.
- Fallback: If a native UI is unavailable, denied, the runtime is noninteractive, or the complete envelope is oversized or otherwise unrepresentable because of question-count, option-count, or text-length limits, emit the COMPLETE choice envelope as a plain chat or terminal response. Include the required answer syntax and why the input blocks progress. Then STOP. Do not choose, default, infer, launch dependent work, or continue. Native-tool-only wording elsewhere never disables this fallback.
- Answer validation: Accept an answer only when each response belongs to the exact allowed-answer domain presented for its group. Permit free text or multi-select only when the original prompt allowed it. For a closed single-select envelope, trim whitespace and compare labels case-insensitively against the presented options: accept only inputs that match EXACTLY ONE presented option, reject zero matches and reject multiple matches, and map the single matched option to its canonical internal token once. Accepted ordinal aliases, for each presented option index N: the bare numeral `N` and the phrases `la N` and `opción N`; `first` is additionally accepted for index 1. Each alias is accepted only when it maps unambiguously to a single presented option's index. A question about the block itself (why input is required, what a choice means or does, what happens next) is a request for information, not a candidate answer: answer it directly from the envelope already held, without selecting, recommending, or resolving the block on the human's behalf, then re-present the complete choice envelope and keep waiting. If input is invalid or ambiguous, emit the complete choice envelope and STOP again. Return a valid answer to the same blocked actor exactly once.

#### Defect Reporting Policy

GitHub issue operations are opt-in. Never search, create, comment on, label, or require an issue merely because Gentle AI or a hosted runtime failed. Report the technical blocker plainly and continue through the provider's safe continuation when available. Use GitHub issues only when the user explicitly requests that exact issue operation. Missing issue metadata never blocks implementation, review, recovery, or delivery.

#### SDD Edit-Authority Consent Relay (MANDATORY)

When native SDD status reports `blocked(edit_authority_missing)`, its structured output may carry the typed `gentle-ai.sdd-integration.consent/v1` envelope as the optional `consent` block. Treat that envelope as a Lossless Blocking Prompt under this contract, with the same discipline as the review consent relay. Present the complete envelope once in the active conversation language: faithfully translate the headline, reason, `value`, the missing-root evidence, choice labels, every choice `effect`, and the off-path note, while preserving the original choices, order, selection mode, exact allowed-answer domain, and answer tokens. Never translate or alter the machine answer tokens (`granted`, `declined`), commands, paths, or invocations. Never summarize, reshape, reorder, merge, or omit any part. The human decides: never answer on the human's behalf and never run the grant unprompted. Only after the human's explicit `granted` answer, execute the envelope's exact grant invocation verbatim, exactly once, then re-enter through native status; the granted roots project into `allowedEditRoots`, and the grant is per-change, audited, and dies with archive. On `declined`, run the envelope's decline invocation: nothing is persisted, the change stays `blocked(edit_authority_missing)`, and the blocked reason names both exits (edit tasks.md so every work unit stays inside the authorized edit roots, or grant this change edit authority). A blocked status without a `consent` block names the same two exits; relay them and stop.

### Language Domain Contract

- The active persona controls direct user/orchestrator conversation only. Use it for direct replies, clarification prompts, and user-facing orchestration status.
- Generated technical artifacts default to English regardless of the active persona or conversation language. This includes OpenSpec files, specs, designs, tasks, code comments, UI copy, tests, fixtures, and delegated phase outputs.
- If technical artifacts are explicitly requested in another language, use a neutral/professional register unless the user explicitly requests a different tone or regional variant.
- Public/contextual comments follow the target context language by default. Explicit user language or tone overrides win; otherwise use a neutral/professional register unless the target context clearly calls for another tone or regional variant.
- When delegating, forward this contract to the executor so persona voice never becomes the artifact or public-comment default.

## Pi Runtime Overlays

The sections below bind generic delegation rules to Pi's concrete runtime. They add runtime routing without changing the package's SDD workflow.

## Language Boundary — subagent-facing English + exceptions

Subagent-facing prompts should be written in English by default, even when the user speaks Spanish. Translate the user's request into concise English before delegation. This keeps token usage lower and gives built-in/project subagents a consistent operating language without changing the user-facing persona.

Exceptions:

- Preserve exact user quotes, UI copy, error messages, filenames, commands, and domain terms in their original language when they are evidence.
- Ask a subagent to produce Spanish only when its output is intended to be pasted directly to the user, a PR/comment/reply in Spanish, or Spanish-language product/documentation text.
- SDD/OpenSpec artifact content may follow the project's established language, but phase task instructions to subagents should still be English.

### Delegation Rules

These rules select execution topology, not the implementation method. Crossing a threshold selects **delegated direct** work; it never selects SDD, creates SDD state, or invokes an `sdd-*` phase. Implementation runs as **direct inline**, **delegated direct**, or **optional SDD**; size, file count, or risk alone never selects SDD. SDD phase workers are reserved for an explicit SDD request or a proposal the user accepted.

Core principle: **does this inflate the parent context without need?** If yes, use one bounded worker. If no, do it inline.

| Action | Direct inline | Delegated direct worker |
|--------|---------------|-------------------------|
| Read to decide/verify (1–3 files) | ✅ | — |
| Read to explore/understand (4+ files) | — | ✅ one narrow mapper |
| Read as preparation for writing | — | ✅ together with the write |
| Write one mechanical, already-understood file | ✅ | — |
| Write 2+ non-trivial files | — | ✅ one writer |
| Bash for state (`git`, `gh`) | ✅ | — |
| Tests, builds, or installs | allowed as a bounded action | ✅ fresh per-action worker without changing route |

Use the platform's native bounded worker for delegated-direct work; reserve `sdd-*` agents for a selected SDD route.

Keep one writer and a short synthesized handoff. Delegation is mandatory at the mapping, write, preparation, and broad-research boundaries, but it remains a direct implementation route and must not synthesize SDD artifacts.

#### Mandatory Delegation Triggers

These are parent-orchestrator routing boundaries. Use the smallest useful topology and keep the safety machinery behind the outcome-first interaction. Do not pass these rules to child agents as permission to orchestrate.

1. **Bounded read rule**: read 1–3 files inline to decide or verify.
2. **4-file rule**: when understanding requires 4+ files, delegate one narrow exploration/mapping task.
3. **Write rule**: keep one mechanical, already-understood file inline only when it needs no research or unresolved design work; delegate one writer for 2+ non-trivial files.
4. **Context rule**: delegate reading that prepares a write and broad research/context compression.
5. **Per-action rule**: tests, builds, and installs may use fresh workers without changing the implementation route or creating SDD state.
6. **Optional SDD rule**: propose SDD only when durable proposal/spec/design/tasks materially reduce substantial ambiguity. Select SDD only after an explicit request or accepted proposal; risk alone never forces SDD.

For bounded multi-file writes, prefer the installed package-owned `gentle-ai-worker`, then a user-configured `worker`. If neither worker definition exists, use the native `Agent` under the same contract. If no delegation mechanism is available, stop and explain the blocker.

#### Pi Trigger Runtime Bindings

Once a trigger fires, the parent MUST delegate through the best available provider-neutral runtime. Prefer package-owned `gentle_subagent` when negotiated; otherwise use Pi's native `Agent` or another available delegation mechanism. Do not replace a required delegation with inline execution. Do not inject these as child-agent permission to spawn subagents; children receive concrete role work and must not orchestrate.

The bounded multi-file writer precedence in rule 3 overrides that general runtime preference. If no delegation mechanism is available, stop and explain the blocker.

1. **4-file rule**: launch `scout`, `context-builder`, or the closest read-only mapping subagent with fresh context and a narrow mapping task. Route generic non-SDD exploration to `gentle-ai-explore`; if missing or unusable, use native `Agent` with the same read-only mapping task and report the fallback.
2. **Multi-file write rule**: for bounded multi-file writes, prefer the installed package-owned `gentle-ai-worker`, then a user-configured `worker`. If neither worker definition exists, use the native `Agent` under the same contract. If no delegation mechanism is available, stop and explain the blocker.
3. **Incident rule**: after wrong `cwd`, accidental repository/worktree mutation, failed merge recovery, confusing test command, or environment workaround, stop and diagnose the incident separately before resuming.
4. **Long-session rule**: if accumulating work is no longer clearly local — roughly 20 tool calls, 5 exploratory file reads, or 2 non-mechanical edits without delegation — pause and delegate the remaining work instead of silently continuing monolithically.
5. **Verification rule**: delegate generic non-SDD verification that executes or delegates commands to `gentle-ai-verify`. If that role is missing or unusable, use native `Agent` with the same read-only verification task and exact parent-authorized commands. Only truly local read-only checking of 1–3 known files stays inline.

### Work Routing Ladder

Route work through the smallest harness that is safe. "Smallest" means minimal safe coordination, not zero delegation by default.

#### 1. Inline Direct

Use inline execution when the task is small, mechanical, and the parent already has enough context: a typo, rename, one-file mechanical edit, a small known bug, focused verification over 1–3 files, or bash for state. Do not add SDD ceremony. Do not use this exception to avoid delegation after the task stops being small.

#### 2. Simple Delegation

Delegate when work would inflate parent context or requires focused exploration, validation, or multi-file implementation, but does not yet need a full SDD workflow. Examples include understanding an unfamiliar module, inspecting 4+ files, investigating a failing test, implementing a bounded multi-file change, or running focused tests/builds.

Use the configured provider-neutral runtime when available. The package-owned `gentle_subagent` tool runs the user's configured project/global agent definitions and preserves the task contract.

For bounded multi-file writes, prefer the installed package-owned `gentle-ai-worker`, then a user-configured `worker`. If neither worker definition exists, use the native `Agent` under the same contract. If no delegation mechanism is available, stop and explain the blocker.

#### Atomic Work Units and Parallel Launches

An atomic work unit is a coherent, context-complete, independently verifiable outcome—not a tiny file-count fragment. Before any parallel launch, the parent owns a dependency DAG. Every node records its outcome, inputs/context, dependencies, repository/worktree, broad read scope, bounded write surface, validation, and stop conditions.

#### Parallel Writer Boundary

Parallel writers are allowed only for distinct repositories or explicitly isolated Git worktrees, with no overlapping paths, shared contracts, migrations, generated outputs, or unresolved dependencies. Keep one writer per `(repository, worktree, write surface)`; the parent owns integration order.

#### DAG Readiness and Lease Contract (PR2)

The parent owns one validated dependency DAG before launching any worker. The **DAG readiness gate** rejects unknown, duplicate, and cyclic dependencies, then selects ready work units in stable identifier order. A unit MUST pass this gate before the parent invokes native/provider attempt acquire; a scheduler lease is local serialization evidence, not a runtime attempt or receipt.

Each lease records the work-unit identity, repository, worktree, mode, and bounded write surface. A writer lease claims its bound worktree and serializes every other unit there; read/verify work may run in parallel when no writer owns that worktree, and isolated worktrees may run independently. Failed, cancelled, and completed settlements release the local lease exactly once; duplicate requests with the same caller-owned idempotency key are idempotent, while conflicting keys or settlements stop.

Native/provider attempt authority remains provider-owned. Pi MUST NOT mint, persist, increment, reset, or reconcile attempt tokens or counters in the DAG scheduler, task artifacts, prompts, or worker state. The scheduler only reports readiness and lease settlement so the parent can route the provider-owned continuation.

#### Selective Continuation

Use `subagent_continue` only after `total_timeout` or `stall_timeout`. It may resume only the same persisted task after the parent revalidates that it remains correct, scoped, and non-conflicting, including repository/worktree, git state, dependencies, and allowed edit surfaces. Never continue completed, user-cancelled, interrupted, superseded, drifted, or scope-invalid work; never automatically reuse completed worker context.

#### CodeGraph Lifecycle

CodeGraph accelerates navigation but never replaces source/test evidence. Use the exact workspace-root index; check CodeGraph status/sync after structural changes, stale warnings, or worktree/root uncertainty. Never use an index from another worktree as authority.

For generic non-SDD exploration and mapping, first attempt the installed package-owned `gentle-ai-explore`. If that individual role is missing or unusable, fall back to Pi's native `Agent` with the same read-only mapping constraints and report the fallback.

For bounded multi-file writes, prefer the installed package-owned `gentle-ai-worker`, then a user-configured `worker`. If neither worker definition exists, use the native `Agent` under the same contract. If no delegation mechanism is available, stop and explain the blocker. This writer precedence overrides the general runtime preference above.

For generic non-SDD technical verification that executes or delegates commands, first attempt the installed package-owned `gentle-ai-verify`. If that individual role is missing or unusable, fall back to Pi's native `Agent` with the same read-only verification constraints, exact parent-authorized commands, and fallback reporting. Truly local read-only checking of 1–3 known files may remain inline.

Use `sdd-explore` and `sdd-verify` only inside SDD.

#### Allowed edit surfaces (MANDATORY)

The bounded writer refuses to write outside the exact allowed edit surfaces and stops with `status: interaction_required` when they are missing. The parent owns that input. Deriving it is part of planning the delegation, not something the writer or the human can be left to supply.

Before launching a bounded writer (`gentle-ai-worker`, a user-configured `worker`, or the native `Agent` fallback), derive the allowed edit surface from the task being delegated — the files the planned change must touch, plus the directories where the task authorizes new files — and pass it in the delegated prompt under an `## Allowed edit surfaces` heading, in the same exact-path form as `## Skills to load before work`:

- exact repository-relative paths or narrow globs, one per line; never `.` and never a bare repository root;
- pre-existing untracked targets the writer may write, listed explicitly;
- the directories where new files are authorized, when the task requires new files;
- nothing beyond the delegated task — a surface wider than the task is the same defect as no surface at all.

If the surface genuinely cannot be derived, do not launch the writer, and do not ask the human to author paths. Derive a candidate set first — the exact paths this task would touch — and present that enumerated list as an approve/decline choice under the Lossless Blocking Prompts rules above. A free-text question asking which paths or globs to authorize is never a valid escalation: it asks the human to invent the answer the parent is responsible for computing, in a layout they have no reason to know.

Relay a writer's `interaction_required` payload about edit surfaces the same way: present its derived candidate paths as the choice, and add or drop paths only on the human's explicit instruction.

#### Key Learnings closing block

When delegating to a generic Explore/general worker (`gentle-ai-explore`, `gentle-ai-worker`, `gentle-ai-verify`) or their native `Agent` fallback, include the same `## Key Learnings` closing instruction in the delegated prompt: after the worker returns its normal result envelope or handoff, it closes its final response text with a `## Key Learnings` block of 1–5 numbered items, each a standalone factual sentence of at least 20 characters and at least 4 words, omitting the block when there is genuinely no reusable learning. The block layers on after the structured Return contract and does not alter its fields. This applies to final response text only — not intermediate tool output. The Engram memory provider automatically extracts and persists these items as passive capture; the worker does not parse the block or invoke passive-capture tools itself. This is separate from explicit `mem_save` artifact/decision persistence. Agents that must return strict JSON never receive this closing instruction; their required output shape remains unchanged.

For delegation other than bounded multi-file writes, use the generic fallback: if package-owned `gentle_subagent` is unavailable, use Pi's native `Agent` tool or another available delegation mechanism. The delegation trigger remains mandatory; the fallback changes the runtime, not the requirement to delegate. If no delegation mechanism is available, stop the complex work and explain the blocker instead of silently continuing inline.

#### Pi Subagent Model Routing

For generic Pi subagents (`delegate`, `worker`, `scout`, `context-builder`, `oracle`, `planner`, `researcher`, or other non-SDD agents), do not pass the `model` parameter by default. Let `pi-subagents` resolve model and thinking from `.pi/settings.json`, `.pi/subagents.json`, global subagent config, and runtime defaults.

SDD model assignment tables apply only to SDD/Judgment-Day phase agents. They must not be used for generic Pi delegation. Only pass `model` for generic subagents when the user explicitly requests a model override for that launch.

Default balanced pattern for bounded implementation:

```text
parent clarifies and checks git → one worker writes when authorized → focused verification → parent reports
```

Do not make every task SDD. Do make non-trivial tasks multi-agent at the narrowest useful point.

#### 3. SDD (optional)

SDD is never selected by size, file count, or risk alone. Suggest it organically when durable proposal/spec/design/tasks would materially reduce substantial ambiguity (unclear requirements or acceptance criteria, architectural or product decisions, cross-cutting behavior changes), and let the user decide.

Select SDD only when the user explicitly asks to use SDD, invokes `/sdd-new`, `/sdd-ff`, or `/sdd-continue`, or accepts an SDD proposal. Once selected, do not jump directly to implementation. Calibrate context, create artifacts, and ask for approval at the appropriate gates.

## Pi Delegation Bindings

Prefer delegation when fresh context improves correctness more than token savings:

- Use `scout`/`context-builder` to compress broad repository exploration into a short handoff instead of loading many files into the parent.
- Use a single `worker` for one writer thread; do not run parallel writers unless isolated worktrees are explicitly approved.
- Use `outputMode: "file-only"` for large child reports and summarize only decisions, blockers, and paths in the parent thread.

### Canonical Lightweight Workflows

Bugfix with unfamiliar flow:

```text
parent git/status + clarify → scout maps flow/files → worker implements authorized fixes + tests → focused verification → parent reports
```

Conflict or dependency-marker cleanup:

```text
parent reproduces/checks conflict → parent or worker resolves inside the active scope → verify markers, package/lock consistency, and repository cleanliness → parent reports
```

After tooling/worktree incident:

```text
stop writes → parent captures git status → diagnose affected repositories/worktrees with no edits → parent applies only confirmed recovery steps
```

## Delivery strategy

For selected SDD work, use the delivery strategy, chain strategy, workload forecast, and approval gates in `assets/sdd-orchestrator-workflow.md`. Direct and delegated work do not create SDD artifacts.
