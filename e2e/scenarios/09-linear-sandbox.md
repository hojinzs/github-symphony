# TC-09: Linear Sandbox State Flow And Reconciliation

## Setup

Use a dedicated Linear sandbox workspace/project with a disposable issue and a repository whose `WORKFLOW.md` uses:

```yaml
tracker:
  kind: linear
  project_slug: symphony-sandbox
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Human Review
    - Done
    - Cancelled
    - Duplicate
```

Start the runtime with `LINEAR_API_KEY` set and the `linear_graphql` worker tool available. Do not use webhook delivery for this TC; reconciliation must happen through polling or `/api/v1/refresh`.

## Steps

1. Create a sandbox Linear issue in `Todo`.
2. Start `gh-symphony repo start --http 4680`.
3. Trigger reconciliation with `curl -X POST http://localhost:4680/api/v1/refresh`.
4. Verify the worker, not orchestrator coordination code, moves the issue from `Todo` to `In Progress` using `linear_graphql`.
5. Let the worker complete and move the issue to `Human Review` or `Done` using `linear_graphql`.
6. Inspect `/api/v1/state` and the run `events.ndjson`.
7. Repeat with an active worker and move the issue directly from `Todo` or `In Progress` to `Cancelled` or `Duplicate`.
8. Repeat with an active worker and delete the issue or move it out of the sandbox project.
9. Repeat with an active worker and concurrently edit the issue state while the worker is running.

## Expected

- The golden path observes `Todo -> In Progress -> Human Review/Done`.
- State writes are performed by the worker through `linear_graphql`; the orchestrator only dispatches and reconciles.
- `tracker.list` and `tracker.fetchByIds` structured events include `tracker.adapter="linear"`, `tracker.projectSlug`, `issue.identifier`, and `issue.id`.
- Linear rate-limit headers appear in the project `rateLimits` snapshot with `source="linear"`.
- Direct terminal-state jumps stop active workers on the next polling/reconciliation tick.
- Deleted or moved issues stop active workers on the next polling/reconciliation tick.
- Concurrent state changes are reconciled by `fetchIssueStatesByIds` before the next candidate list is dispatched.

## Cleanup

Stop the runtime, remove the sandbox Linear issue, and clear any local `.runtime/` directory created during the run.
