# TC-10: Run-scoped orchestrator tracker state API

## Setup

1. `echo "[]" > e2e/fixtures/issues.json`
2. `mkdir -p evidence`
3. `docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.events.yml up -d --build`
4. Wait until `/healthz` succeeds.

## Steps

1. Copy `e2e/fixtures/happy-path.json` to `e2e/fixtures/issues.json`.
2. Call `POST /api/v1/refresh` and look up the active run's `runId`.
3. Send `{"type":"state-read"}` to `POST /api/v1/tracker-state` without a run ID and verify a `400` with the complete `TrackerStateResult` shape.
4. Use only the current run ID while omitting the `SYMPHONY_ORCHESTRATOR_TOKEN` injected into the worker, and verify `401`, `tracker_state_authentication_failed`.
5. Read the token from the worker process environment and pass it via `X-Symphony-Orchestrator-Token`, but put a non-existent run in `X-Symphony-Run-Id`, and verify `403`, `run_not_found`.
6. Request with the current run ID and token, and verify `403`, `tracker_state_requests_unsupported`, indicating the file tracker does not support provider transitions.
7. In `events.ndjson`, verify the `tracker.state` durable rejection event for the authenticated current-run request.
8. In the GitHub adapter unit integration TC, send five transitions concurrently and verify each request queries only the canonical item ID and that the maximum provider call concurrency is 1.

## Expected

- The HTTP API passes process-secret authentication and authorizes only the current run matching `SYMPHONY_RUN_ID`.
- The run IDs exposed by the state API alone cannot invoke tracker reads/mutations.
- Unsupported or stale requests are not mistaken for success and leave diagnosable results/events.
- On the worker failure path, no confirmed response is returned that would allow lifecycle comments/workpads.
- The GitHub adapter concurrency TC performs only exact-item read → mutation → exact-item readback, with no board-wide item query.

## Cleanup

1. `echo "[]" > e2e/fixtures/issues.json`
2. `docker compose -f docker-compose.e2e.yml down`
3. `rm -rf evidence`
