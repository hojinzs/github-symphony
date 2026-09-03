# Architecture Map

Living document — maps the components (§3.1) and layers (§3.2) of the upstream
spec [symphony-spec.md](symphony-spec.md) to this repository's packages and
modules. When code moves, update the matching slice. The "why" lives in
[adr/](adr/), the "what to build" in [designs/](designs/); this document only
answers "where is it now".

## Spec components → implementation (spec §3.1)

| Spec component       | Implementation                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Workflow Loader      | `packages/core` (`workflow/parser`, `workflow/loader`)                                                                          |
| Config Layer         | `packages/core` (`workflow/config`), `packages/cli` (`config.ts`, global/project config)                                        |
| Issue Tracker Client | `packages/tracker-github`, `packages/tracker-linear`, `packages/tracker-file` — contract is core's `OrchestratorTrackerAdapter` |
| Orchestrator         | `packages/orchestrator` (`OrchestratorService` dispatch loop, leases, retry, recovery)                                          |
| Workspace Manager    | `packages/orchestrator` (`git.ts` worktree populate, `repository-cache.ts` bare clone cache, `skills.ts` skill injection)       |
| Agent Runner         | `packages/worker` + `packages/runtime-codex` / `packages/runtime-claude`                                                        |
| Status Surface       | `packages/control-plane` (HTTP API + auth), `packages/dashboard` (React SPA handlers)                                           |
| Logging              | `packages/core` (observability events and snapshots), `runs/<run-id>/events.ndjson`                                             |

## Layer slices (spec §3.2)

Each slice points at the current sources of truth for that layer. When a PR
touches a layer, check that its slice (and the linked documents) still holds.

### Cross-layer Linear recovery safeguards

The Linear recovery fixes span several layers rather than belonging solely to
the tracker adapter:

- **Coordination:** `packages/orchestrator/src/service.ts` consumes the durable
  retry budget for dirty-workspace recovery, preserves recovery context on
  exhaustion, releases the claim, and requires an explicit tracker state change
  before redispatch. Docker coverage: [bounded recovery circuit breaker](../e2e/scenarios/20-bounded-recovery-circuit-breaker.md).
- **Execution:** `packages/worker/src/turn-lease.ts` distinguishes permanent
  unsupported state reads from transient provider failures and retains
  diagnostics for the latter. This capability behavior is focused-test coverage
  because the Docker file tracker implements state reads.
- **Core and coordination:** `packages/core/src/workflow/issue-identity.ts`
  recognizes normalized `TEAM-123` branch and workpad evidence for safe
  dirty-workspace attribution; `packages/orchestrator/src/service.ts` consumes
  that evidence. Docker coverage: [Linear dirty-workspace recovery](../e2e/scenarios/21-linear-dirty-workspace-recovery.md).
- **Configuration and integration:** `packages/cli/src/commands/doctor.ts`
  selects the Linear adapter for standalone `doctor --smoke` reads without a
  GitHub Project binding. This provider selection is focused-test coverage;
  [the Linear sandbox guide](../e2e/scenarios/09-linear-sandbox.md) is the
  separate live-provider acceptance procedure.

### 1. Policy — defined by the repo/project

- `WORKFLOW.md` (repository root or standalone project folder) — prompt body and team rules
- Prompt policy can branch on the normalized lifecycle `execution_phase`; phase classification alone does not impose agent behavior.
- Skill layers: global `~/.gh-symphony/skills/` + project `.agent/skills/`, injected into the worktree's `.codex/skills/` / `.claude/skills/` (see Skill Layering in [configuration.md](configuration.md))
- Examples: [examples/](examples/)

### 2. Configuration — typed parsing and validation

- `WORKFLOW.md` front matter parsing and validation: `packages/core/src/workflow/`
- Workflow `server.port` configuration and the `repo start --port` / `--http`
  status-API options: `packages/core/src/workflow/`,
  `packages/cli/src/commands/start.ts`
- Shared lifecycle state normalization and execution-phase classification: `packages/core/src/workflow/lifecycle.ts`
- MCP declarations are resolved at the host boundary. Codex advertises adapter tools through dynamic-tool schemas without `config.mcp_servers`; Claude's worker starts a loopback HTTP MCP service and generates an `mcp.json` containing only its URL and ephemeral session capability. Repository/project subprocess entries are not exposed to either coding-agent child.
- Runtime launchers share the core child-home resolver and prepare a private workspace-contained `HOME`/`GH_CONFIG_DIR`. Non-bare local authentication stages only Codex `auth.json` or Claude `claudeAiOauth`; default custom commands receive only their declared `runtime.auth.env`. Host agent configuration, Claude MCP OAuth, tracker credentials, and `gh auth` remain outside the child boundary.
- CLI global/project config, discoverable repo/standalone runtime command options,
  folder-addressed standalone project derivation, and cwd-first
  diagnostic selection: `packages/cli/src/config.ts`, `packages/cli/src/project-selection.ts`,
  `commands/project.ts`; doctor smoke diagnostics route Linear live issue selection through
  the Linear adapter while retaining the GitHub Project read path for GitHub-backed projects,
  where Project binding checks remain confined; `workspaceDir` is the issue-workspace root in both modes, while
  repo-embedded configs additionally carry `repositoryDir` for daemon CWD/liveness
- Cross-runtime instance index and host-level `instances` CLI surface: `packages/cli/src/instances.ts`, `commands/instances.ts`. The index is advisory; lock heartbeat and process identity remain the liveness authority.
- Environment variables and `.env` loading order: [configuration.md](configuration.md)

### 3. Coordination — the orchestrator

- Dispatch loop, concurrency, retry, reconciliation: `packages/orchestrator/src/service.ts`
- Run records pair the spawning orchestrator's owner token with its project-lock
  process-start identity. Reconciliation protects a foreign-owned run only when
  the owner PID is live and that identity still matches; legacy records and
  unavailable identity probes remain fail-closed.
- A `retry_queued` orchestration record with a non-null `currentRunId` retains its
  concurrency reservation until it is restarted, released, or suppressed. Due
  reservations are reconciled after non-due active runs, then oldest due time
  first with stable issue-identity tie-breaking. A capacity-only requeue
  retains its original due time, so an already-waiting retry ages ahead of a
  retry that just ran; it still consumes neither failure budget nor retry
  backoff. Due reservations are excluded from retry-fire capacity accounting
  and count as running immediately after restart.
- This reservation behavior is an intentional repository-local scheduler
  divergence. After a confirmed transition out of an active state, the worker
  also receives a fixed 30-second clean-exit grace before reconciliation acts.
- Failed runs with dirty-workspace recovery consume the same durable
  `max_failure_retries` budget as other worker failures. Exhaustion preserves
  the recovery context, releases the claim, and suppresses redispatch until an
  explicit tracker state change re-arms the issue; fresh polls and same-state
  tracker writes cannot silently reset the counter. Healthy continuation
  retries remain outside this circuit breaker. This bounded failure handling
  conforms to the upstream retry-safety model; its restart-persistent storage
  follows the repository-local persistence divergence documented below.
- Project workflow and polling policy load before tracker candidates are fetched. The scheduler then applies only the normalized `TrackedIssue.dispatchable` gate before loading issue-specific workflow or starting a worker. It does not encode provider assignment, repository-scope, label, or fork rules; each tracker adapter derives those rules and supplies an explainable `dispatchReason` with non-dispatchable candidates.
- Initial prompt rendering receives the execution phase derived from the configured planning and active states.
- Confirmed tracker transitions outside the configured active states are recorded on the active run. When the canonical item becomes non-actionable, reconciliation gives the worker a bounded clean-exit grace; successful finalization then re-reads the current canonical state and preserves `succeeded` only while it remains non-actionable. An unavailable final read persists a warning-level `run-finalization-deferred` event with a discriminated cause and defers classification for up to three consecutive reconciliation ticks; the third unknown read enters the existing failure-retry path so the run cannot remain pinned. The tick counter intentionally follows reconciliation opportunities rather than wall-clock time, so adaptive polling can stretch the elapsed grace window by up to the configured 10× poll multiplier while preserving a deterministic provider-read budget. A known active or non-actionable result resets the streak. This failure-retry treatment after a successful worker exit intentionally diverges from the upstream specification's normal-exit continuation retry: the repository prioritizes bounded finalization and eventual suppression when canonical state cannot be established, and retains the tracker cause in retry diagnostics instead of reporting a worker failure. Per-turn `state-read` requests do not reload or rewrite workflow snapshots.
- Before dispatch, active candidates carrying an adapter-provided terminal fact are converged to the workflow terminal state and suppressed from worker startup.
- Filesystem state store (`OrchestratorFsStore`), leases: `packages/orchestrator/src/fs-store.ts`.
  Claims, retry entries, and run records survive daemon restart; upstream
  Symphony §14.3 does not restore scheduler state. This is an intentional
  repository-local persistence divergence.
- Shared bare clone cache (`<config-dir>/repos/<owner>/<repo>.git`), heartbeat locks, direct-clone degradation, safe inventory/eviction, worktree populate, and conservative agent-branch collection (only refs fully reachable from `origin/*` and not linked to a worktree): `repository-cache.ts`, `git.ts`; operator diagnostics and cleanup: `packages/cli/src/commands/cache.ts`
- Issue workspace records remain in orchestrator state, while population, quarantine, terminal cleanup, and worktree removal operate on `<workspace.root>/<issue-key>` in repo-embedded and standalone modes. A successful assigned-branch push is not a complete-publication claim when the worktree still has tracked or untracked changes: the worker records a bounded, dedicated `unpublishedWorktree` publication outcome with the pushed branch/commit and file lists while preserving successful transport status. Terminal and startup cleanup retain a workspace carrying either this outcome or a Git transport failure until recovery. This retention is an intentional repository-level divergence from upstream Symphony §8.6: unrecoverable unpublished agent work must not be destroyed by otherwise unconditional terminal cleanup.
- Dirty-workspace recovery attribution is tracker-neutral core behavior in `packages/core/src/workflow/issue-identity.ts`, consumed by `packages/orchestrator/src/service.ts`. GitHub numeric identifiers and normalized `TEAM-123` identifiers both accept positive branch/workpad evidence; a different full tracker identifier overrides same-number evidence, and missing positive evidence remains fail-closed.
- Workflow source resolution (declared external/repo sources): `service.ts` + core workflow config. The file is defensively re-read on every reconciliation tick; no filesystem watcher is installed (an explicit upstream divergence documented in [ADR 2026-08-26](adr/2026-08-26-workflow-reload-divergence.md)).

### 4. Execution — worker and agent subprocess

- Single-issue execution, approval workflow, hooks: `packages/worker`. The
  control-plane routes, including `/api/v1/state`, are served by
  `packages/cli/src/commands/start.ts` through `packages/control-plane`.
- Worker run metadata uses the same core lifecycle phase resolver as orchestrator prompt rendering.
- Multi-turn convergence compares local workspace/HEAD progress and reads canonical tracker state through `/api/v1/tracker-state` before each turn after the first and again at the failure threshold. A confirmed state outside the workflow's active states completes the worker at the next boundary. Transient or malformed reads retain HTTP, provider, or exception diagnostics and fail closed only after the configured consecutive-failure threshold. A `403 tracker_state_requests_unsupported` response is a permanent adapter capability result: the worker warns once, excludes it from failure accounting, and skips between-turn tracker gates while continuing turns. At the convergence threshold, this permanent capability gap causes the worker to accept the local non-productive signal rather than continue indefinitely. Comments, PR pushes, and active-to-active transitions do not reset the local non-productive-turn counter. Each supported read uses the tracker adapter and may consume a live provider request (up to 19 per default 20-turn session, plus the threshold read).
- Runtime adapters: `packages/runtime-codex` (app-server protocol), `packages/runtime-claude` (print mode)
- Codex provider-native tools are snapshotted at worker session start, advertised through `thread/start.dynamicTools`, and executed in-process by the worker after `item/tool/call`; tool credentials and opaque issue context remain on the host side.
- Runtime-neutral GraphQL implementations: `packages/tool-github-graphql`, `packages/tool-linear-graphql`

### 5. Integration — tracker adapters (tracker-specific code lives only here)

- GitHub Project V2: `packages/tracker-github` (including the adapter-owned linked-PR canonical-subject extension; opaque `nativeRef` data never crosses into orchestration). Source issue state and linked-PR metadata remain distinct from Project workflow status; candidate polling excludes terminal states and can include other non-terminal items. It derives GitHub assignment, repository-scope, pickup-label, and fork-PR eligibility as `dispatchable` with an explainable reason.
- Linear: `packages/tracker-linear`; it derives provider-native assignment eligibility as the normalized `dispatchable` contract, serves adapter-native CLI smoke reads (`listIssues` / `fetchIssueStatesByIds`) for standalone projects, confirms per-turn `state-read` requests from a fresh issue query, and exposes normalized Linear `branchName` values for dirty-workspace attribution without treating them as checkout refs. Its pickup labels instead filter label-ineligible candidates from the list before dispatch, so they are not retained for explain surfaces as `dispatchable: false` records. This adapter-side label filtering is a repository-level divergence from the upstream scheduler-owned label boundary and differs from the GitHub adapter's retained, reason-bearing records. Linear transition requests are explicitly rejected because state mutation remains worker-owned through `linear_graphql`.
- File-based (E2E only): `packages/tracker-file`; fixtures may set `dispatchable` and `dispatchReason` directly to exercise the adapter-neutral scheduler gate.
- GitHub-specific planning/approval/PR-reporting extensions: `packages/extension-github-workflow`
- Compact adapter profiles: [GitHub Project](trackers/github-project.md),
  [Linear](trackers/linear.md), and [file](trackers/file.md). GitHub's
  synthetic `Archived` state is a GitHub-specific implementation choice, not
  normalized Symphony core behavior.
- Host-side tracker tools: provider adapters own advertised schemas and credentials,
  and receive normalized active-issue context that stays host-internal. Callers are
  responsible for narrowing documents; adapters do not infer or rewrite a target.
  Codex snapshots those schemas in its runtime plan; Claude snapshots them when its
  loopback Streamable HTTP MCP server starts.
- Tracker adapters also resolve tenant-scoped worker credentials from separate
  project and daemon scopes. The orchestrator injects only the selected values
  into the worker's explicit environment; adapter-declared secret names preserve
  the agent-child stripping boundary. Missing credentials emit a structured
  `worker-credential-missing` run event and operator warning.

### 6. Observability — events and status surfaces

- Structured events and snapshot builder: `packages/core/src/observability/`; the project snapshot exposes the short SHA-256-derived workflow revision and load time applied during its latest tick, and `run-dispatched` records that revision. Retry scheduling emits `run-retried` with the run and issue IDs, attempt, retry kind, due time, and error summary; a capacity-postponed reservation emits one `retry-postponed` signal per distinct (attempt, retained due time, capacity reason) reservation instead of repeating it on every reconciliation poll, while preserving the original retry error in the queue row. Retry queue rows expose the issue ID, attempt, and error. Completed-run reconciliation emits `run-finalization-deferred` with the discriminated unknown cause, diagnostic error, consecutive count, bound, and exhaustion flag, while candidate-level reconciliation emits `tracker-terminal-candidate-reconciled` before any run exists.
- Operator HTTP control plane (bearer auth, redaction): `packages/control-plane`
- Browser dashboard: `packages/dashboard` — details in [../packages/control-plane/README.md](../packages/control-plane/README.md)
- Runtime state files: `.runtime/orchestrator/` (`workspaces/<id>/`, `runs/<run-id>/`)
- Instance registry: `${GH_SYMPHONY_INSTANCES_DIR:-${GH_SYMPHONY_CONFIG_DIR:-~/.gh-symphony}/instances/}` (mode `0700`; one file per runtime/project). Daemon runtime overrides do not change this inherited host index.

## §17 conformance test matrix

The rows below are owned by the focused conformance suites rather than a
single implementation package. They map the upstream test matrix to the
authoritative tests for repository behavior.

| Spec row                                         | Test mapping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| §17.2 workspace safety and hooks                 | `packages/orchestrator/src/service.test.ts` covers rejecting an existing regular file at the issue workspace path and running `after_create` only for a newly created workspace; `packages/core/src/workspace-safety.test.ts` covers path containment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| §17.3 empty tracker lookup and malformed refresh | `packages/tracker-{github,linear,file}/src/*test.ts` assert empty state/ID lookups make no provider call. GitHub and Linear suites assert that malformed requested records fail; GitHub alone covers omission of malformed polling-list items. Linear polling-list omission is a documented implementation gap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| §17.4 reconciliation with no running issues      | `packages/orchestrator/src/service.test.ts` proves reconciliation does not invoke per-run reconciliation when there are no active runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| §17.5 child credential and tool boundary         | `packages/runtime-{codex,claude}`, `packages/core/src/runtime/custom-child-env.test.ts`, and `packages/worker/src/non-codex-runtime.test.ts` prove provider subprocesses/default custom commands exclude raw GitHub/Linear tokens, broker controls, host HOME/GH config, and Git credential helpers while custom auth is explicitly forwarded; parser coverage rejects reserved custom auth names and a non-custom compatibility flag. Orchestrator workflow-loading coverage proves adapter-declared reserved names are supplied to that parser boundary before dispatch. `packages/worker/src/codex-dynamic-tools.test.ts` covers structured rejection of unsupported dynamic tools. The Docker runtime black-box repeats the default and compatibility custom-child environment assertions alongside the Claude generated-config assertions. `runtime.isolation.inherit_environment` is the documented custom-only upstream divergence. |
| §13.7 host, port, and bind lifecycle             | `packages/cli/src/commands/start.test.ts` covers explicit ports and loopback versus `--bind-all` host selection. §17.7 positional workflow-path behavior remains a documented divergence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## Package dependency graph

`packages/cli` is the published entrypoint that bundles the rest at build time
(referenced via devDependencies). In addition to `dist/index.js` and the worker
entry, its package build emits `dist/mcp-server.js`, which dispatches exactly one
built-in GraphQL MCP implementation from an explicit server argument, and
`dist/git-credential-helper.js`, which supplies runtime-scoped GitHub credentials
only to worker-host Git subprocesses. Successful worker runs transfer the
checked-out assigned ref into a temporary host-owned bare repository, fetch and
verify fast-forward ancestry against the orchestrator-owned clone URL, and push
that exact branch with hooks disabled before reporting success. The
credential-bearing commands never read the child-controlled checkout's remote
or hook configuration.

```
cli (bundles: orchestrator, worker, control-plane, dashboard, runtime-claude, tracker-github, core)
orchestrator ──→ core, runtime-claude, runtime-codex, tracker-file, tracker-github, tracker-linear
worker ────────→ core, extension-github-workflow, runtime-claude, runtime-codex, tool-github-graphql, tracker-github, tracker-linear
control-plane ─→ core, dashboard
dashboard ─────→ core
runtime-claude ─→ core, tool-github-graphql, tool-linear-graphql, tracker-github, tracker-linear
runtime-codex ──→ core, tool-github-graphql, tool-linear-graphql
tracker-github ─→ core, tool-github-graphql
tracker-linear ─→ core, tool-linear-graphql
tracker-file ───→ core
extension-github-workflow ─→ core
tool-github-graphql ─→ core
tool-linear-graphql ─→ (none)
core ─→ (none; no external dependencies either)
```

## Releases

The single publish unit is `@gh-symphony/cli`. Behavior-changing PRs add a
changeset under `.changeset/`; merging the changeset-release bot PR publishes
to npm.

## Explicit non-goal

Appendix A's SSH worker transport is not implemented and is out of scope for
this repository at present; local worker execution is the supported model.
