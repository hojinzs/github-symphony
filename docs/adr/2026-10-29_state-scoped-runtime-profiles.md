# ADR: State-scoped runtime profiles

- **Date**: 2026-10-29
- **Status**: Proposed
- **Symphony Layers**: Configuration, Coordination, Execution, Observability
- **Related Spec**: `docs/symphony-spec.md` §5 (Workflow), §10 (Runtime), §13 (Runtime Snapshot)
- **Related ADRs**: [2026-04-15 claude-print runtime support](2026-04-15_claude-print-runtime-support.md), [2026-08-28 agent tool isolation](2026-08-28_agent-tool-isolation.md)

## Context

A workflow binds exactly one agent runtime. `WorkflowDefinition.runtime` is a
single object, and every consumer reads it directly:

- `packages/orchestrator/src/runtime-factory.ts` `createWorkflowRuntimeAdapter`
- `packages/worker/src/runtime-routing.ts` `resolveWorkerRuntimeRoute`
- `packages/core/src/workflow/config.ts` `resolveWorkflowRuntimeCommand` /
  `resolveWorkflowRuntimeTimeouts`, which feed `SYMPHONY_AGENT_COMMAND` and the
  timeout env in `OrchestratorService` dispatch
- `packages/orchestrator/src/skills.ts` `resolveRuntimeSkillsDirectory`, which
  picks `.codex/skills` or `.claude/skills` from that single command

Operators want different agents per lifecycle state: for example Claude for
triage/planning in `Ready`, Codex for implementation in `In progress`, and a
lighter Codex model for mechanical landing in `Land`. Today that is impossible
without separate workflows.

Further gaps:

1. **One run spans several states.** Between turns the worker calls
   `POST /api/v1/tracker-state`, which already returns the concrete `state`,
   but `refreshTrackerState` (`packages/worker/src/turn-lease.ts`) collapses it
   to active / non-actionable. A run that starts in `Ready` keeps the same
   process after the agent moves the issue to `In progress`.
2. **No model field.** Model selection is only possible by hand-writing
   runtime-specific flags into `runtime.args`.
3. **No provider-level concurrency.** `max_concurrent_agents` and
   `max_concurrent_agents_by_state` cannot express "at most 2 Claude runs",
   which is what provider rate limits and subscription seats require once
   runtimes are mixed.

## Decision

### 1. Front matter

```yaml
runtime: # the "default" profile; unchanged semantics
  kind: codex-app-server
  command: codex
  args: [app-server]
  model: gpt-5-codex
  timeouts:
    turn_timeout_ms: 3600000
    stall_timeout_ms: 900000

runtimes: # named profiles; same schema as `runtime`
  claude-plan:
    kind: claude-print
    model: claude-opus-5-5
  codex-luna:
    kind: codex-app-server
    command: codex
    args: [app-server]
    model: codex-luna

agent:
  max_concurrent_agents: 8
  runtime_by_state: # unmapped active states use `default`
    Ready: claude-plan
    In progress: default
    Land: codex-luna
  max_concurrent_agents_by_runtime:
    claude-plan: 2
    default: 5
```

Model IDs above are illustrative.

Rules:

- `runtime` is the profile named `default`. `default` is reserved in
  `runtimes`.
- Each `runtimes.<name>` entry is parsed with the existing `parseRuntimeConfig`.
  An omitted `timeouts` block inherits `runtime.timeouts`; nothing else is
  inherited.
- `agent.runtime_by_state` keys use `normalizeWorkflowState`, matching
  `agent.max_concurrent_agents_by_state`.
- Profile names match `^[a-z0-9][a-z0-9-]*$`.
- Workflows without `runtimes` / `runtime_by_state` behave exactly as today.

### 2. `model`

`runtime.model` (and each profile's `model`) is optional. Adapters translate it:

| kind               | translation                                          |
| ------------------ | ---------------------------------------------------- |
| `codex-app-server` | `-c model="<value>"` appended to the app-server argv |
| `claude-print`     | `--model <value>` via `ensureFlagValue` in `argv.ts` |
| `custom`           | `SYMPHONY_AGENT_MODEL` in the child environment      |

Setting `model` while `args` already carries the runtime's own model flag is a
validation error, not a silent override.

### 3. Validation

| Condition                                                       | Result                                         |
| --------------------------------------------------------------- | ---------------------------------------------- |
| `runtime_by_state` references an unknown profile                | `WorkflowValidationError`                      |
| `runtimes` declares `default`                                   | `WorkflowValidationError`                      |
| `runtimes` / `runtime_by_state` present but `runtime` absent    | `WorkflowValidationError` (no default)         |
| `runtime_by_state` key is not in `tracker.active_states`        | diagnostic `state_runtime_entry_ignored`       |
| `runtime_by_state` duplicate key after normalization            | diagnostic `state_runtime_entry_ignored`       |
| `max_concurrent_agents_by_runtime` key is not a defined profile | diagnostic `runtime_concurrency_entry_ignored` |
| `max_concurrent_agents_by_runtime` value is not a positive int  | diagnostic `runtime_concurrency_entry_ignored` |

Unknown profiles in `runtime_by_state` fail hard because dispatch cannot
proceed. Bad concurrency entries only drop a limit, so they follow the existing
`state_concurrency_entry_ignored` pattern.

### 4. Resolution (core, Configuration)

```ts
type ResolvedRuntimeProfile = {
  profileId: string; // "default" or a runtimes key
  runtime: WorkflowRuntimeConfig;
};

function resolveRuntimeForState(
  workflow: Pick<
    WorkflowDefinition,
    "runtime" | "runtimeProfiles" | "agent" | "codex"
  >,
  state: string
): ResolvedRuntimeProfile | null; // null keeps the legacy codex-only path
```

- `WorkflowDefinition` gains `runtimeProfiles: Record<string, WorkflowRuntimeConfig>`.
- `WorkflowAgentConfig` gains `runtimeByState: Record<string, string>` and
  `maxConcurrentAgentsByRuntime: Record<string, number>`.
- `WorkflowRuntimeConfig` gains `model: string | null`.
- `resolveWorkflowRuntimeCommand` / `resolveWorkflowRuntimeTimeouts` take a
  resolved runtime instead of the whole workflow. The `ParsedWorkflow.agentCommand`
  compatibility field keeps reporting the default profile.

### 5. Dispatch (Coordination)

- At dispatch, the orchestrator resolves the profile from `issue.state` and
  exports `SYMPHONY_RUNTIME_PROFILE=<profileId>`. `SYMPHONY_AGENT_COMMAND` and
  the timeout env come from the resolved profile.
- `run.json` and the dispatch event record `runtimeProfile`, `runtimeKind`, and
  `model`. `runtimeProfile` is immutable for the life of a run (see §7).
- Skill injection writes to the skills directory of **every** runtime kind used
  by any profile, because one issue workspace can now host more than one
  runtime across its lifetime.

### 6. Per-runtime concurrency (Coordination)

`agent.max_concurrent_agents_by_runtime` caps running runs per profile. A
dispatch must pass all three gates:

1. `max_concurrent_agents` (global)
2. `max_concurrent_agents_by_state[normalized issue.state]`
3. `max_concurrent_agents_by_runtime[resolved profileId]`

Accounting:

- Running runs are counted by their recorded `runtimeProfile`. Because a run
  never changes profile (§7), the count is exact without re-reading tracker
  state. This differs from the per-state count, which follows the run's latest
  `issueState`.
- A profile without an entry is limited only by the global and per-state gates.
- When the profile gate is full, the issue waits. The orchestrator never falls
  back to another profile, since that would silently change which agent works
  the issue.

Both dispatch paths enforce the gate:

- Candidate dispatch, next to the existing per-state check in the poll loop.
- Retry dispatch. `hasRetryDispatchSlot` checks only the global limit today.
  It must resolve the profile from the issue's **current** state and check the
  profile gate, because the continuation that follows a profile switch (§7)
  goes through this path. A full gate requeues with
  `"no available runtime slots"` and `{ countFailure: false, advanceAttempt: false }`,
  matching the existing global-slot requeue.

Limits are per profile, not per provider. Two profiles that share one account
(for example two Claude models on one subscription) are capped independently;
see Open questions.

### 7. In-run state change (Execution)

- `refreshTrackerState` additionally returns the concrete state name already
  present in the `/api/v1/tracker-state` response.
- After each turn, the worker re-resolves the profile for that state. If it
  differs from `SYMPHONY_RUNTIME_PROFILE` in any field, including only `model`,
  the worker finishes the run cleanly with exit reason
  `runtime_profile_changed`.
- No new retry kind is needed: a clean exit with the issue still active is
  already classified as `continuation` (`classifyRetryKind`) and retried after
  `CONTINUATION_RETRY_DELAY_MS` (1s). The retry resolves the new profile and
  passes the per-runtime gate (§6).
- Threads and sessions are never resumed across profiles. Context carries over
  through the branch and the workpad comment, which is already the
  WORKFLOW.md contract.

The worker reads the profile by name from the env and re-resolves it from its
own parse of `WORKFLOW.md`, so `runtime-routing.ts`, the Claude preflight, and
the codex launch path in `packages/worker/src/index.ts` switch from
`workflow.runtime` to the resolved runtime.

**Why restart even when only the model changes.** Codex `turn/start` and
`claude --resume --model` could switch models in place and keep the thread.
That was rejected for v1:

| Approach                                     | Gains                                                                                                                               | Costs                                                                                                                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Restart on any profile change (chosen)**   | One run = one profile = one model. Exact per-runtime slot counts, per-run token and cost attribution, one code path for every kind. | One process restart plus ~1s continuation delay per crossing; the next model starts from workpad and branch, not the prior thread.                                                                 |
| Switch model in place for same-kind profiles | No restart; the thread history carries over.                                                                                        | A run holds a slot under profile A while acting as B, so §6 caps can be exceeded; run snapshot and token usage need per-turn model; two code paths (in-place for same kind, restart across kinds). |
| Pin the profile at dispatch, never switch    | Simplest; no worker change.                                                                                                         | Breaks the main use case: the reference WORKFLOW.md moves `Ready → In progress` inside one run, so implementation would run on the triage profile.                                                 |

State crossings happen a few times per issue, so the restart cost is small.
Revisit in-place switching only if measurements show the lost thread context
hurts outcomes.

### 8. Policy surface

The prompt template exposes `runtime.profile`, `runtime.kind`, and
`runtime.model`, so a WORKFLOW.md can branch on runtime where skill invocation
differs between agents.

### 9. Observability and CLI

- Status snapshot and dashboard show profile and model per run, plus running
  count against each `max_concurrent_agents_by_runtime` limit.
- Issues held by a full profile gate surface the reason
  `runtime_concurrency_limit` instead of looking idle.
- Token usage is aggregated per `model` in addition to the existing totals.
- `doctor` and `workflow validate` check binary presence and auth for every
  profile, not only the default.
- `repo explain` prints the resolved profile and its limit per active state.

## Spec divergence

The upstream spec defines a single runtime configuration (`codex`) and global
plus per-state concurrency. Named profiles, state-scoped selection, and
per-profile concurrency are a repo-local extension layered on top;
`docs/symphony-spec.md` is not modified. With none of `runtimes`,
`runtime_by_state`, or `max_concurrent_agents_by_runtime` set, behavior matches
the current single-runtime model.

The feature is tracker-neutral: it keys on normalized state strings and profile
names only, and no tracker adapter changes.

## Alternatives considered

- **Per-state inline runtime blocks** (`runtime_by_state: { Ready: { kind: … } }`).
  Rejected: duplicates full runtime blocks and makes reuse across states verbose.
- **Switch runtime or model inside one run.** Rejected for v1; see the table in §7.
- **Per-kind concurrency** (`codex-app-server: 5`). Rejected: profiles of the
  same kind often hit different models or accounts, so kind is too coarse.
- **Label-driven profile selection.** Deferred. The resolver signature can take
  labels later without changing the front matter introduced here.
- **`reasoning_effort` field.** Deferred until both CLIs expose a stable,
  comparable flag; `args` covers it meanwhile.

## Consequences

- Operators can mix runtimes and models per state from one WORKFLOW.md and cap
  each profile independently.
- A state change that crosses profiles costs one process restart and a
  continuation delay of about one second, longer if the target profile is full.
- Issue workspaces may carry both `.codex/skills` and `.claude/skills`
  injections.
- Every profile's credentials must be present on the host; `doctor` surfaces
  missing ones before dispatch.

## Rollout

1. Core: schema, parser, `resolveRuntimeForState`, validation and diagnostics
   tests. Changeset.
2. Orchestrator dispatch, per-runtime gate on candidate and retry paths, worker
   runtime selection, run record fields.
3. In-run `runtime_profile_changed` exit, multi-runtime skill injection,
   `doctor` / dashboard / `repo explain`, `docs/configuration.md` and
   `docs/architecture.md` updates, Docker E2E covering a `Ready → In progress`
   profile switch under a full target-profile gate.

## Open questions

- Shared caps across profiles that use one provider account: add an optional
  `concurrency_group` on profiles, or wait for operator demand?
