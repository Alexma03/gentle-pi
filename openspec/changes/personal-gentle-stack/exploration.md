## Exploration: Personal Gentle Stack — Gentle Pi Lane

### Current State

Gentle Pi currently depends on subagent behavior without owning a runtime boundary. The main extension (`extensions/gentle-ai.ts`) detects literal `subagent_run` tools, recognizes `pi-subagents-j0k3r`/legacy package names, mutates `subagent_run` inputs for review candidate injection, parses per-task `## Allowed edit surfaces`, and renders orchestration instructions around the j0k3r `task|background` contract. The same 5,825-line extension also owns model routing, SDD startup/status hooks, destructive-command and sensitive-path guards, and the native review controller, so provider-specific details leak into unrelated policy code.

The active external runtime is `pi-subagents-j0k3r` 1.5.6. It registers `subagent_run`, `subagent_status`, `subagent_result`, `subagent_cancel`, `subagent_list_agents`, `subagent_list_tasks`, `subagent_send_message`, and optionally `subagent_continue`. It applies global defaults of a 20-minute total timeout, a 4-minute stall timeout, five-way concurrency, and `task` foreground mode. Its tool/result schemas, SQLite-backed history, continuation rules, and mode names have become part of Gentle Pi's prompt and test contracts even though `package.json` does not declare that runtime dependency; Gentle AI installs it separately.

Background routing is a second provider-specific layer. Gentle Pi resolves a project/global/env policy, then determines capability from the live tool registry or package presence. Prompt assets require foreground `mode: "task"` for SDD phases and permit background only for independent read-only work. This mixes execution policy, availability detection, and one plugin's invocation vocabulary.

SDD is phase-linear today. The packaged chains run `proposal → spec → design → tasks → apply → verify → sync → archive`; `sdd-full.chain.md` explicitly states that no RDD authority is required between phases. Native attempt authority is correctly delegated to Gentle AI through `sdd-attempt acquire|settle`, but the Go ledger exposes a singular `ActiveAttempt` and blocks a second acquire with `active_attempt`. Therefore a real parallel DAG of runtime-bearing work units cannot be claimed until that companion contract supports concurrent, independently bound work-unit leases; otherwise only read-only work can run in parallel.

Review/RDD is wired separately from SDD. `gentle_review` and `gentle_review_capture` wrap the native Gentle AI lifecycle, while `lib/review-candidate-view.ts` patches the mutable `subagent_run` request to append a frozen candidate context for review lenses. This preserves strong native authority but couples immutable-candidate delivery to one tool schema. Runtime-wide timeouts also exist in j0k3r and in native/host relay code; bounded discovery, Git, and native-control timeouts are useful, but a global wall-clock timeout for arbitrary agent work is not.

The package also mixes behavioral assets with cosmetics. `assets/agents`, `assets/chains`, and `assets/support` are executable contracts installed globally by `lib/sdd-preflight.ts`; they cannot be deleted as if they were branding. The genuinely cosmetic surface is `themes/`, `assets/gentle-logo-only.png`, `extensions/startup-banner.ts`, and the `pi-pretty` wrapper/dependency. Gentle AI additionally installs `@juicesharp/rpiv-ask-user-question`, `pi-web-access`, `@juicesharp/rpiv-todo`, and `pi-btw` for every Pi installation, and its tests/dependency-tree UI pin that sequence.

Tintinweb provides a materially better first adapter target. The current official `@tintinweb/pi-subagents` documentation exposes `Agent`, `get_subagent_result`, `steer_subagent`, lifecycle events, and a public in-process event-bus RPC. The RPC supports discovery, spawn, stop, consume, lifecycle events, an absolute `cwd`, and detached/background execution. However, protocol version `2` does not guarantee feature granularity; it has no RPC verb for status, result retrieval, steering, or resume. Those gaps are evidence for capability negotiation, not a reason to bake Tintinweb tool names into Gentle Pi. Sources: [Tintinweb README](https://github.com/tintinweb/pi-subagents), [RPC reference](https://github.com/tintinweb/pi-subagents/blob/master/docs/rpc.md).

### Affected Areas

- `extensions/gentle-ai.ts` — split provider-neutral orchestration/safety policy from plugin detection, tool-name interception, background routing, and review dispatch decoration.
- `lib/review-candidate-view.ts` — replace mutation of a `subagent_run` payload with a provider-neutral pre-start request decorator that supplies controller-owned frozen review context.
- `assets/orchestrator-delegation.md` and `assets/orchestrator.md` — replace `subagent_*`/`task|background` vocabulary with runtime capabilities and stable Gentle Pi operations.
- `assets/sdd-orchestrator-workflow.md` and `assets/chains/*.chain.md` — replace the linear phase chain with an atomic work-unit DAG, focused verification, final integration, and one final complex-candidate RDD transaction.
- `assets/agents/sdd-tasks.md`, `assets/agents/sdd-apply.md`, and `assets/agents/sdd-verify.md` — define DAG nodes, dependencies, focused evidence, and aggregation instead of one phase-sized implementation attempt.
- `lib/sdd-status.ts` and `assets/support/sdd-status-contract.md` — project authoritative DAG readiness, work-unit state, final-candidate readiness, and the RDD requirement without reconstructing native attempt authority.
- `lib/sdd-preflight.ts` — migrate installed behavioral assets without overwriting user-modified copies; retire obsolete chain/agent assets through the managed manifest.
- `package.json`, `extensions/pi-pretty.ts`, `extensions/startup-banner.ts`, `themes/`, and `tests/gentle-theme.test.ts` — remove cosmetic themes, logo/banner behavior, and no-longer-needed presentation dependencies/tests while retaining UI dependencies still used by functional tools.
- `tests/background-subagents.test.ts`, `tests/writer-edit-surface-scope.test.ts`, `tests/review-controller-native-routing.test.ts`, `tests/runtime-harness.mjs`, and package-manifest tests — replace provider-name assertions with runtime-port conformance, capability, workspace-boundary, and migration tests.
- `scripts/build-runtime-modules.mjs` and `runtime/` — include only provider-neutral runtime modules that truly need generated JavaScript parity; do not generate an adapter merely because a dependency is external.
- Companion `/home/alex/Projects/forks/gentle-ai/internal/agents/pi/adapter.go` and its installer/dependency-tree tests — install `npm:@tintinweb/pi-subagents`, retire the j0k3r identity, and stop installing unnecessary Pi plugins.
- Companion `/home/alex/Projects/forks/gentle-ai/internal/cli/pi_background.go` — retire or generalize the j0k3r-specific projected background-policy file after Gentle Pi owns runtime capability negotiation.
- Companion `/home/alex/Projects/forks/gentle-ai/internal/sddstatus/runtime_compact.go` and runtime ledger — evolve singular active-attempt authority if concurrent runtime-bearing DAG nodes are required; otherwise report serialization explicitly.

### Approaches

1. **Internal adapter over tool names** — Keep observing the active tool registry and translate Gentle Pi operations into `subagent_run` or `Agent` tool-shaped payloads.
   - Pros: Smallest initial change; legacy j0k3r fallback is straightforward; existing prompt/tool-call tests can be adapted incrementally.
   - Cons: Tool schemas remain a hidden ABI; extensions do not have a safe general mechanism for invoking another registered model tool; review input mutation and capability inference stay fragile; provider semantics are inferred from names rather than negotiated.
   - Effort: Medium

2. **Gentle Pi runtime port with registered adapters** — Define a versioned provider registry and capability-specific interfaces inside Gentle Pi. Bind the first adapter to Tintinweb's public event-bus RPC and lifecycle events, while keeping orchestration, safety, SDD, and result validation above the port.
   - Pros: Stable deep-module boundary; no provider names in prompts or SDD; adapters can expose richer optional features without forcing a minimum common denominator; nicobailon or a custom runtime can be evaluated by conformance tests; Tintinweb can be upgraded independently behind one adapter.
   - Cons: Tintinweb RPC lacks explicit status/result/steer/resume verbs, so the first adapter must maintain an ID-keyed session-local run registry from lifecycle events and expose unsupported optional capabilities honestly. RPC discovery needs a short bounded handshake and careful synchronous `consume` handling.
   - Effort: High

3. **Direct coupling to Tintinweb internals** — Import Tintinweb manager types or use its global manager symbol directly and model Gentle Pi around its records/workflows.
   - Pros: Fast access to records, waiting, and richer implementation details; less adapter-owned bookkeeping; easiest path to Tintinweb-only UI features.
   - Cons: Couples Gentle Pi to an unversioned registry/private implementation; forces coordinated releases; makes later runtime substitution expensive; imports provider concepts such as worktree isolation that violate the Orca ownership boundary.
   - Effort: Medium initially, High lifecycle cost

### Recommendation

Adopt approach 2: a registered, capability-based runtime port, with Tintinweb RPC as the first adapter and a temporary legacy tool-name adapter only as a reversible migration bridge.

The boundary should be concrete and asymmetric rather than a lowest-common-denominator interface:

- `SubagentRuntimeRegistryV1` admits exactly one selected provider per Pi session and exposes its identity, protocol evidence, and capabilities.
- Mandatory `SubagentRuntimeCoreV1` provides `start(request)`, `status(handle)`, `result(handle, signal)`, and `cancel(handle, reason)` with provider-neutral run states and terminal results.
- Optional capability objects provide `background`, `parallel`, `steering`, `resume`, `events`, and `liveInspection` independently. Callers request a capability and fail clearly when it is absent; no fake fallback is inferred from a similarly named tool.
- `RuntimeBinding` is created once from the current Pi/Orca-owned worktree. It carries the canonical worktree root, canonical repository identity, and a `cwd` constrained inside that root. A delegated prompt cannot supply or override those values. Gentle Pi never creates task worktrees, selects repository bundles, or requests Tintinweb `isolation: "worktree"`; Orca owns those responsibilities.
- `SubagentStartRequest` carries role, prompt, execution class (`read|write|verify|review`), runtime binding, cancellation signal, and optional structured-result schema. Provider-specific `mode`, tool names, package names, and timeout fields do not cross the port.
- The Tintinweb adapter uses `subagents:ready` plus `subagents:rpc:ping` for bounded discovery, `subagents:rpc:spawn` for start, lifecycle events for status/result, `subagents:rpc:stop` for cancel, and synchronous `subagents:rpc:consume` when Gentle Pi owns result delivery. Its session-local run registry supplies core `status` and `result`. It advertises events and pooled parallel starts; it does not advertise steering/resume until a registered API supports them. The unversioned global manager registry may support diagnostics, not core correctness.
- Replace global execution deadlines with explicit cancellation and phase/work-unit stop conditions. Keep short bounds for capability discovery and bounded Git/native control-plane commands. Treat inactivity as observable status/steering input, not automatic termination; user cancellation and provider failure remain terminal.
- Remove per-task allowed-edit-surface parsing and prompts. Preserve role-level tool restrictions plus one `WorkspaceGuard` that rejects writes outside the canonical current worktree, cross-worktree/external paths, sensitive locations, and destructive commands. Coordination is handled by the DAG and a one-writer-per-worktree rule, not by duplicating exact path authorization in every task.
- Move review candidate injection into a provider-neutral `ReviewCandidateDecorator` invoked before `runtime.start`. It derives frozen context exclusively from the native controller registry and never accepts candidate roots or lineage material from prompts.

Redesign SDD execution around `WorkUnitV1` nodes with stable IDs, dependencies, execution class, acceptance evidence, focused verification, stop conditions, and qualitative complexity. The scheduler launches only dependency-ready nodes. Inside one Orca worktree, read-only exploration and independent verification may run in parallel; mutation remains single-writer. Parallel writers require separate Orca-provided task worktrees and are therefore outside Gentle Pi's ownership. Every runtime-bearing node still acquires and settles native attempt authority. Until Gentle AI supports concurrent work-unit leases, attempt-bearing nodes must be serialized and status must say so explicitly.

The target flow is:

`plan/spec/design → DAG-ready work units → focused check per unit → final integration/normalization → full verification → one native RDD transaction for a complex final candidate → sync/archive`.

RDD runs exactly once over the immutable final candidate after all source-mutating normalization and integrated verification. It must not run per work unit, per phase, or as a second implementation loop. Simple work retains proportional checks without manufacturing a review transaction. Native Gentle AI remains the sole review and attempt authority.

Use a staged reversible migration:

1. Add the runtime port, conformance suite, workspace guard, and Tintinweb adapter without activating it.
2. Add a provider selection (`auto`, `tintin-rpc`, temporary `legacy-tools`) and characterize both adapters against the same core contract; never activate two providers simultaneously.
3. Update Gentle AI's transactional installer to install Tintinweb, remove exact managed j0k3r/legacy identities, and stop adding the four unnecessary plugins. Preserve unrelated user packages and rely on the existing backup/rollback transaction. Where historical ownership is ambiguous, report a retired package rather than deleting a user-modified entry silently.
4. Switch provider-neutral prompts/hooks/tests to the port, then activate Tintinweb by default. Keep the legacy adapter for one bounded rollback window.
5. Introduce the SDD DAG and native work-unit status/attempt changes before enabling parallel runtime-bearing nodes.
6. Remove the legacy adapter, j0k3r package probes, obsolete background policy projection, exact tool-name tests, cosmetic themes/logo/banner, and `pi-pretty` only after package/runtime verification proves no functional dependency remains.

This exploration is analysis-only; no code, configuration, installer, dependency, runtime, or active package state was changed.

### Risks

- Tintinweb's RPC protocol version is too coarse to prove individual features, and its documented gaps require explicit capability evidence rather than version-only admission.
- RPC lifecycle state is process-local. A hard restart can lose Gentle Pi's adapter registry even when Tintinweb persisted a child session; resume must stay unsupported until a durable, registered API exists.
- Tintinweb RPC accepts absolute `cwd` and has its own optional worktree isolation. The adapter must reject arbitrary external roots and never delegate worktree creation, or it will violate Orca ownership.
- Tintinweb RPC spawns are detached; `isBackground` controls pooling/UI rather than foreground blocking. Gentle Pi must implement waiting at the port layer and must not map `foreground` mechanically to that flag.
- Current Gentle AI attempt authority permits one active attempt per change. Enabling parallel apply/verify before the ledger evolves would create false DAG concurrency or governance failures.
- Removing all `assets/` would delete behavioral contracts, not just branding. Cosmetic retirement must be separated from managed agent/chain/support migration.
- Existing installer state does not clearly distinguish every historically auto-installed Pi plugin from a user-owned install. Cleanup must be transactional, exact-identity based, and reversible.
- The current review controller and generated runtime parity surface are large. Splitting them while changing the runtime adapter and SDD scheduler in one slice would overload review; proposal/tasks should define staged cross-repository work units.

### Ready for Proposal

Yes. The proposal should adopt the registered capability-based runtime boundary, make Tintinweb RPC the first adapter, keep Orca as the only worktree/bundle owner, require a companion Gentle AI change for installer migration and concurrent attempt authority, distinguish cosmetic retirement from behavioral assets, and define the single final-candidate RDD gate for complex work.
