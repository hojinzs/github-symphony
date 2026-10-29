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
cheaper model for mechanical landing in `Land`. Today that is impossible
without separate workflows.

Two further gaps:

1. **One run spans several states.** Between turns the worker calls
   `POST /api/v1/tracker-state`, which already returns the concrete `state`,
   but `refreshTrackerState` (`packages/worker/src/turn-lease.ts`) collapses it
   to active / non-actionable. A run that starts in `Ready` keeps the same
   process after the agent moves the issue to `In progress`.
2. **No model field.** Model selection is only possible by hand-writing
   runtime-specific flags into `runtime.args`.

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
  codex-fast:
    kind: codex-app-server
    command: codex
    args: [app-server]
    model: gpt-5-codex-mini

agent:
  runtime_by_state: # unmapped active states use `default`
    Ready: claude-plan
    In progress: default
    Land: codex-fast
```

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

| Condition                                                    | Result                                   |
| ------------------------------------------------------------ | ---------------------------------------- |
| `runtime_by_state` references an unknown profile             | `WorkflowValidationError`                |
| `runtimes` declares `default`                                | `WorkflowValidationError`                |
| `runtime_by_state` key is not in `tracker.active_states`     | diagnostic `state_runtime_entry_ignored` |
| duplicate key after normalization                            | diagnostic `state_runtime_entry_ignored` |
| `runtimes` / `runtime_by_state` present but `runtime` absent | `WorkflowValidationError` (no default)   |

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
- `WorkflowAgentConfig` gains `runtimeByState: Record<string, string>`.
- `WorkflowRuntimeConfig` gains `model: string | null`.
- `resolveWorkflowRuntimeCommand` / `resolveWorkflowRuntimeTimeouts` take a
  resolved runtime instead of the whole workflow. The `ParsedWorkflow.agentCommand`
  compatibility field keeps reporting the default profile.

### 5. Dispatch (Coordination)

- At dispatch, the orchestrator resolves the profile from `issue.state` and
  exports `SYMPHONY_RUNTIME_PROFILE=<profileId>`. `SYMPHONY_AGENT_COMMAND` and
  the timeout env come from the resolved profile.
- `run.json` and the dispatch event record `runtimeProfile`, `runtimeKind`, and
  `model`.
- Skill injection writes to the skills directory of **every** runtime kind used
  by any profile, because one issue workspace can now host more than one
  runtime across its lifetime.

### 6. In-run state change (Execution)

- `refreshTrackerState` additionally returns the concrete state name already
  present in the `/api/v1/tracker-state` response.
- After each turn, the worker re-resolves the profile for that state. If it
  differs from `SYMPHONY_RUNTIME_PROFILE`, the worker finishes the run cleanly
  with exit reason `runtime_profile_changed`.
- No orchestrator change is needed for re-dispatch: a clean exit with the issue
  still active is already classified as `continuation`
  (`classifyRetryKind`) and retried after `CONTINUATION_RETRY_DELAY_MS` (1s).
  The new dispatch resolves the new profile.
- Threads and sessions are never resumed across profiles. Context carries over
  through the branch and the workpad comment, which is already the
  WORKFLOW.md contract.

The worker reads the profile by name from the env and re-resolves it from its
own parse of `WORKFLOW.md`, so `runtime-routing.ts`, the Claude preflight, and
the codex launch path in `packages/worker/src/index.ts` switch from
`workflow.runtime` to the resolved runtime.

### 7. Policy surface

The prompt template exposes `runtime.profile`, `runtime.kind`, and
`runtime.model`, so a WORKFLOW.md can branch on runtime where skill invocation
differs between agents.

### 8. Observability and CLI

- Status snapshot and dashboard show profile and model per run.
- Token usage is aggregated per `model` in addition to the existing totals.
- `doctor` and `workflow validate` check binary presence and auth for every
  profile, not only the default.
- `repo explain` prints the resolved profile per active state.

## Spec divergence

The upstream spec defines a single runtime configuration (`codex`). Named
profiles and state-scoped selection are a repo-local extension layered on top;
`docs/symphony-spec.md` is not modified. With neither `runtimes` nor
`runtime_by_state` set, behavior matches the current single-runtime model.

The feature is tracker-neutral: it keys on normalized state strings only, and
no tracker adapter changes.

## Alternatives considered

- **Per-state inline runtime blocks** (`runtime_by_state: { Ready: { kind: … } }`).
  Rejected: duplicates full runtime blocks and makes reuse across states verbose.
- **Switch runtime inside one run.** Rejected: Codex and Claude have
  incompatible session models, and one run owning two runtimes complicates
  cancellation, token accounting, and the run snapshot.
- **Label-driven profile selection.** Deferred. The resolver signature can take
  labels later without changing the front matter introduced here.
- **`reasoning_effort` field.** Deferred until both CLIs expose a stable,
  comparable flag; `args` covers it meanwhile.

## Consequences

- Operators can mix runtimes and models per state from one WORKFLOW.md.
- A state change that crosses profiles costs one process restart and a
  continuation delay of about one second.
- Issue workspaces may carry both `.codex/skills` and `.claude/skills`
  injections.
- Every profile's credentials must be present on the host; `doctor` surfaces
  missing ones before dispatch.

## Rollout

1. Core: schema, parser, `resolveRuntimeForState`, validation and diagnostics
   tests. Changeset.
2. Orchestrator dispatch + worker runtime selection + run record fields.
3. In-run `runtime_profile_changed` exit, multi-runtime skill injection,
   `doctor` / dashboard / `repo explain`, `docs/configuration.md` and
   `docs/architecture.md` updates, Docker E2E covering a `Ready → In progress`
   profile switch.

## Open questions

- Should `max_concurrent_agents_by_runtime` ship with this ADR to cap
  per-provider rate limits, or wait for operator demand?
- Should a profile switch be suppressed when only `model` differs within the
  same `codex-app-server` kind, by passing the model on the next `thread/start`
  instead of restarting?
