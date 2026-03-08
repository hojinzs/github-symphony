## Context

The current repository implements a control-plane-heavy workflow: the web app provisions workspaces, creates GitHub Projects, brokers runtime credentials, and observes worker state. The worker package already contains tracker-reading and runtime-launching primitives, but there is no dedicated long-running orchestrator service that matches the Symphony architecture in [SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md).

The target architecture separates responsibilities into Symphony core plus optional product extensions:

- `orchestrator`: headless CLI and daemon process that polls trackers, dispatches work, reconciles worker runs, and performs restart recovery
- `worker`: per-assigned-issue execution runtime that launches `codex app-server` and reports state
- `control-plane`: optional operator console extension for workspace setup, tracker binding, issue creation assistance, and status monitoring
- `github-project-tracker-adapter`: optional tracker adapter extension that maps the core tracker contract onto GitHub Projects and GitHub issues

The orchestrator must not require a frontend and must not require a persistent database for correctness. Recovery must come from tracker state, local filesystem state, repository-owned `WORKFLOW.md`, and worker/process reconciliation.

## Goals / Non-Goals

**Goals:**

- Add a first-class orchestrator service that can run entirely from the CLI.
- Move tracker polling, actionable issue selection, dispatch, retry, and reconciliation out of the control plane.
- Redefine worker runtimes as assigned-issue executors instead of tracker-polling workspace daemons.
- Make repository-owned `WORKFLOW.md` the source of workflow semantics for orchestration and execution.
- Keep the control plane as an optional operator-facing surface for metadata management and observability.
- Define GitHub Projects support as an adapter layered on top of the core tracker contract instead of as the core contract itself.
- Preserve or improve current GitHub Project and issue creation setup flows.
- Make orchestrator correctness independent from a required persistent database.

**Non-Goals:**

- Replacing GitHub Projects with a different tracker.
- Removing the control plane's operator workflows for workspace setup and issue creation assistance.
- Requiring the control plane for core orchestration to run.
- Defining a rich browser-first orchestration workflow as the primary runtime interface.
- Requiring a new database schema for active orchestration state.

## Decisions

### 1. Introduce a dedicated CLI-first orchestrator service

The system will add a separate orchestrator runtime, likely under `apps/orchestrator`, with CLI entrypoints such as `run`, `run-once`, `dispatch`, `run-issue`, `recover`, and `status`.

Rationale:

- Symphony orchestration is a backend concern, not a UI concern.
- Headless execution is necessary for local debugging, CI, and production deployment.
- A CLI interface makes targeted issue replay and recovery practical.

Alternatives considered:

- Keep orchestration inside `apps/control-plane`: rejected because it couples dispatch correctness to the web app lifecycle.
- Move polling into `packages/worker`: rejected because worker processes should execute assigned work, not coordinate the fleet.

### 2. Make the orchestrator authoritative for actionable issue detection and dispatch

The orchestrator will own tracker polling, determine whether an issue is actionable from workflow state, acquire a local lease for the issue phase, and launch or resume a worker run.

Rationale:

- Prevents duplicate worker behavior across multiple runtimes.
- Centralizes polling cadence, bounded concurrency, retry, crash recovery, and scheduling policy.
- Matches the Symphony specification's orchestrator role.

Alternatives considered:

- Let each worker poll trackers independently: rejected because it complicates deduplication and recovery.
- Let the control plane API trigger every run: rejected because orchestration must continue without operator traffic.

### 3. Keep orchestration state DB-less and filesystem-backed

The orchestrator will maintain authoritative in-memory state while running and persist enough local files to recover after restart. Tracker state remains the external source of truth for issue phase, repository-owned `WORKFLOW.md` remains the source of workflow semantics, and local files capture leases, run attempts, and event logs.

Expected local state shape:

```text
.runtime/
  orchestrator/
    workspaces/<workspace-id>/state.json
    workspaces/<workspace-id>/leases.json
    runs/<run-id>/run.json
    runs/<run-id>/events.ndjson
```

Rationale:

- Aligns with Symphony's recovery model.
- Avoids coupling orchestration correctness to a web-app database.
- Keeps local development simple.

Alternatives considered:

- Persist leases and runs in Prisma/Postgres: rejected for orchestrator correctness because it adds an unnecessary mandatory dependency.

### 4. Re-scope control-plane metadata to configuration and observability

The control plane will remain responsible for optional operator workflows such as workspace metadata management, tracker-binding configuration, repository allowlists, operator-assisted issue creation, broker configuration, and status aggregation. It will no longer own polling or dispatch logic, and orchestrator operation must remain valid when the control plane is unavailable.

Rationale:

- Preserves the product surface operators need.
- Keeps the control plane useful even though the orchestrator is independently runnable.
- Establishes a clean contract between management metadata and runtime execution.

Alternatives considered:

- Remove the control plane entirely: rejected because operator setup and status visibility remain necessary.

### 5. Recast the worker as an assigned-issue executor

Workers will receive an assigned issue/run context from the orchestrator, prepare an isolated workspace, load workflow semantics from the checked-out repository's `WORKFLOW.md`, resolve credentials, launch `codex app-server`, and report local execution state. They will not decide which issue to work on next.

Rationale:

- Simplifies the worker contract.
- Makes run attribution and recovery explicit.
- Separates scheduling from execution.

Alternatives considered:

- Keep long-lived workspace-bound polling workers: rejected because it conflicts with orchestrator-led assignment.

### 6. Treat GitHub Projects as an adapter extension, not the core tracker contract

Symphony core will define a tracker adapter contract around actionable work discovery, state inspection, and mutation handoff. GitHub Projects support will be implemented as one adapter that satisfies that contract while preserving existing operator flows.

Rationale:

- Keeps core orchestration semantics tracker-agnostic.
- Preserves compatibility with the current GitHub-backed product surface.
- Prevents GitHub-specific field names or API assumptions from leaking into the orchestrator core.

Alternatives considered:

- Bake GitHub Projects directly into the orchestrator core: rejected because it makes the core architecture less faithful to Symphony's general tracker model.

## Risks / Trade-offs

- [Split-brain transition during migration] → Introduce the orchestrator behind an explicit runtime mode flag and remove control-plane-side dispatch only after orchestrator reconciliation works.
- [Repository workflow files drift across branches or runs] → Reload `WORKFLOW.md` at run start and surface parse or validation failures as run-blocking status.
- [Status visibility becomes harder across multiple processes] → Define explicit orchestrator and worker status surfaces that the control plane can query and cache.
- [Filesystem recovery can drift from tracker state] → Reconcile local files against live tracker state on every orchestrator startup and recovery command.
- [Local orchestration state may accumulate stale runs] → Add CLI recovery and garbage-collection commands plus bounded retention for historical run logs.

## Migration Plan

1. Add the new orchestrator capability and CLI entrypoints without changing the existing control-plane workspace setup flow.
2. Extract shared tracker-adapter and workflow-evaluation code so the orchestrator can own polling and dispatch.
3. Update worker launch contracts to accept assigned issue context from the orchestrator.
4. Load workflow semantics from repository-owned `WORKFLOW.md` instead of control-plane-generated workflow artifacts.
5. Move dashboard aggregation to read orchestrator and worker status instead of assuming control-plane-owned execution.
6. Disable legacy control-plane-side dispatch paths once orchestrator parity is validated.

Rollback:

- Keep the existing control-plane-managed runtime path behind a temporary fallback mode until the orchestrator is stable.
- If orchestration issues appear, operators can stop the orchestrator process and return to the fallback mode while preserving workspace metadata.

## Open Questions

- Where should orchestrator workspace metadata be sourced from when the control plane is not running: direct DB access, exported config files, or a shared metadata package?
- Should worker launch isolation be standardized as per-run processes, per-run containers, or driver-dependent runtimes under a common contract?
- How much historical run data should remain local before archival or cleanup is required?
- How generic should the tracker adapter contract be before additional adapters beyond GitHub Projects are introduced?
