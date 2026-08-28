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

### 1. Policy — defined by the repo/project

- `WORKFLOW.md` (repository root or standalone project folder) — prompt body and team rules
- Prompt policy can branch on the normalized lifecycle `execution_phase`; phase classification alone does not impose agent behavior.
- Skill layers: global `~/.gh-symphony/skills/` + project `.agent/skills/`, injected into the worktree's `.codex/skills/` / `.claude/skills/` (see Skill Layering in [configuration.md](configuration.md))
- Examples: [examples/](examples/)

### 2. Configuration — typed parsing and validation

- `WORKFLOW.md` front matter parsing and validation: `packages/core/src/workflow/`
- Shared lifecycle state normalization and execution-phase classification: `packages/core/src/workflow/lifecycle.ts`
- Layered MCP composition (`.mcp.json` sidecar): `packages/core/src/runtime/mcp-compose.ts` + each runtime adapter
- CLI global/project config, discoverable repo/standalone runtime command options,
  folder-addressed standalone project derivation, and cwd-first
  diagnostic selection: `packages/cli/src/config.ts`, `packages/cli/src/project-selection.ts`,
  `commands/project.ts`; `workspaceDir` is the issue-workspace root in both modes, while
  repo-embedded configs additionally carry `repositoryDir` for daemon CWD/liveness
- Environment variables and `.env` loading order: [configuration.md](configuration.md)

### 3. Coordination — the orchestrator

- Dispatch loop, concurrency, retry, reconciliation: `packages/orchestrator/src/service.ts`
- Initial prompt rendering receives the execution phase derived from the configured planning and active states.
- Confirmed tracker transitions outside the configured active states are recorded on the active run. When the canonical item becomes non-actionable, reconciliation gives the worker a bounded clean-exit grace; successful finalization then re-reads the current canonical state and preserves `succeeded` only while it remains non-actionable. An unavailable final read persists a warning-level `run-finalization-deferred` event with a discriminated cause and defers classification for up to three consecutive reconciliation ticks; the third unknown read enters the existing failure-retry path so the run cannot remain pinned. The tick counter intentionally follows reconciliation opportunities rather than wall-clock time, so adaptive polling can stretch the elapsed grace window by up to the configured 10× poll multiplier while preserving a deterministic provider-read budget. A known active or non-actionable result resets the streak. This failure-retry treatment after a successful worker exit intentionally diverges from the upstream specification's normal-exit continuation retry: the repository prioritizes bounded finalization and eventual suppression when canonical state cannot be established, and retains the tracker cause in retry diagnostics instead of reporting a worker failure. Per-turn `state-read` requests do not reload or rewrite workflow snapshots.
- Before dispatch, active candidates carrying an adapter-provided terminal fact are converged to the workflow terminal state and suppressed from worker startup.
- Filesystem state store (`OrchestratorFsStore`), leases: `packages/orchestrator/src/fs-store.ts`
- Shared bare clone cache (`<config-dir>/repos/<owner>/<repo>.git`), heartbeat locks, direct-clone degradation, safe inventory/eviction, and worktree populate: `repository-cache.ts`, `git.ts`; operator diagnostics and cleanup: `packages/cli/src/commands/cache.ts`
- Issue workspace records remain in orchestrator state, while population, quarantine, terminal cleanup, and worktree removal operate on `<workspace.root>/<issue-key>` in repo-embedded and standalone modes.
- Workflow source resolution (declared external/repo sources): `service.ts` + core workflow config. The file is defensively re-read on every reconciliation tick; no filesystem watcher is installed (an explicit upstream divergence documented in [ADR 2026-08-26](adr/2026-08-26-workflow-reload-divergence.md)).

### 4. Execution — worker and agent subprocess

- Single-issue execution, `/api/v1/state`, approval workflow, hooks: `packages/worker`
- Worker run metadata uses the same core lifecycle phase resolver as orchestrator prompt rendering.
- Multi-turn convergence compares local workspace/HEAD progress and reads canonical tracker state through `/api/v1/tracker-state` before each turn after the first and again at the failure threshold. A confirmed state outside the workflow's active states completes the worker at the next boundary; active or unconfirmed reads fail closed. Comments, PR pushes, and active-to-active transitions do not reset the local non-productive-turn counter. Each read uses the tracker adapter and may consume a live provider request (up to 19 per default 20-turn session, plus the threshold read).
- Runtime adapters: `packages/runtime-codex` (app-server protocol), `packages/runtime-claude` (print mode)
- Runtime-neutral MCP tools: `packages/tool-github-graphql`, `packages/tool-linear-graphql`

### 5. Integration — tracker adapters (tracker-specific code lives only here)

- GitHub Project V2: `packages/tracker-github` (including source issue state and linked-PR metadata kept distinct from Project workflow status); it returns all active scoped items and derives GitHub assignment, repository-scope, pickup-label, and fork-PR eligibility as `dispatchable` with an explainable reason.
- Linear: `packages/tracker-linear`
- File-based (E2E only): `packages/tracker-file`
- GitHub-specific planning/approval/PR-reporting extensions: `packages/extension-github-workflow`

### 6. Observability — events and status surfaces

- Structured events and snapshot builder: `packages/core/src/observability/`; the project snapshot exposes the short SHA-256-derived workflow revision and load time applied during its latest tick, and `run-dispatched` records that revision. Completed-run reconciliation emits `run-finalization-deferred` with the discriminated unknown cause, diagnostic error, consecutive count, bound, and exhaustion flag, while candidate-level reconciliation emits `tracker-terminal-candidate-reconciled` before any run exists.
- Operator HTTP control plane (bearer auth, redaction): `packages/control-plane`
- Browser dashboard: `packages/dashboard` — details in [../packages/control-plane/README.md](../packages/control-plane/README.md)
- Runtime state files: `.runtime/orchestrator/` (`workspaces/<id>/`, `runs/<run-id>/`)

## Package dependency graph

`packages/cli` is the published entrypoint that bundles the rest at build time
(referenced via devDependencies). In addition to `dist/index.js` and the worker
entry, its package build emits `dist/mcp-server.js`, which dispatches exactly one
built-in GraphQL MCP implementation from an explicit server argument, and
`dist/git-credential-helper.js`, which supplies runtime-scoped GitHub credentials
to Git subprocesses.

```
cli (bundles: orchestrator, worker, control-plane, dashboard, runtime-claude, tracker-github, core)
orchestrator ──→ core, runtime-claude, runtime-codex, tracker-file, tracker-github, tracker-linear
worker ────────→ core, extension-github-workflow, runtime-claude, runtime-codex, tool-github-graphql, tracker-github
control-plane ─→ core, dashboard
dashboard ─────→ core
runtime-claude ─→ core, tool-github-graphql, tool-linear-graphql
runtime-codex ──→ core, tool-github-graphql, tool-linear-graphql
tracker-github ─→ core, tool-github-graphql
tracker-linear ─→ core
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
