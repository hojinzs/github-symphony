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
- Skill layers: global `~/.gh-symphony/skills/` + project `.agent/skills/`, injected into the worktree's `.codex/skills/` / `.claude/skills/` (see Skill Layering in [configuration.md](configuration.md))
- Examples: [examples/](examples/)

### 2. Configuration — typed parsing and validation

- `WORKFLOW.md` front matter parsing and validation: `packages/core/src/workflow/`
- Layered MCP composition (`.mcp.json` sidecar): `packages/core/src/runtime/mcp-compose.ts` + each runtime adapter
- CLI global/project config and folder-addressed standalone project derivation: `packages/cli/src/config.ts`, `commands/project.ts`
- Environment variables and `.env` loading order: [configuration.md](configuration.md)

### 3. Coordination — the orchestrator

- Dispatch loop, concurrency, retry, reconciliation: `packages/orchestrator/src/service.ts`
- Confirmed tracker transitions are recorded on the active run. When the canonical item becomes non-actionable, reconciliation gives the worker a bounded clean-exit grace and preserves a subsequently reported `succeeded` run instead of rewriting it as suppressed.
- Filesystem state store (`OrchestratorFsStore`), leases: `packages/orchestrator/src/fs-store.ts`
- Shared bare clone cache (`<config-dir>/repos/<owner>/<repo>.git`) and worktree populate: `repository-cache.ts`, `git.ts`
- Workflow source resolution (declared external/repo sources): `service.ts` + core workflow config

### 4. Execution — worker and agent subprocess

- Single-issue execution, `/api/v1/state`, approval workflow, hooks: `packages/worker`
- Multi-turn convergence compares local workspace/HEAD progress and, at the failure threshold, reads canonical tracker state through `/api/v1/tracker-state`. A confirmed state outside the workflow's active states completes the worker; active or unconfirmed reads fail closed. Comments, PR pushes, and active-to-active transitions do not reset the local non-productive-turn counter.
- Runtime adapters: `packages/runtime-codex` (app-server protocol), `packages/runtime-claude` (print mode)
- Runtime-neutral MCP tools: `packages/tool-github-graphql`, `packages/tool-linear-graphql`

### 5. Integration — tracker adapters (tracker-specific code lives only here)

- GitHub Project V2: `packages/tracker-github`
- Linear: `packages/tracker-linear`
- File-based (E2E only): `packages/tracker-file`
- GitHub-specific planning/approval/PR-reporting extensions: `packages/extension-github-workflow`

### 6. Observability — events and status surfaces

- Structured events and snapshot builder: `packages/core/src/observability/`
- Operator HTTP control plane (bearer auth, redaction): `packages/control-plane`
- Browser dashboard: `packages/dashboard` — details in [../packages/control-plane/README.md](../packages/control-plane/README.md)
- Runtime state files: `.runtime/orchestrator/` (`workspaces/<id>/`, `runs/<run-id>/`)

## Package dependency graph

`packages/cli` is the published entrypoint that bundles the rest at build time
(referenced via devDependencies).

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
