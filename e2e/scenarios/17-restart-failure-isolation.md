# TC-17: Restart failure isolation

## Setup

1. Reset `e2e/fixtures/issues.json` to `[]`.
2. Start the Docker E2E stack with the default `happy` worker scenario:

   ```bash
   GH_SYMPHONY_HTTP_TOKEN=e2e-http-token \
     docker compose -f docker-compose.e2e.yml up -d --build
   curl --fail --retry-all-errors --retry 10 --retry-delay 2 \
     http://localhost:4680/healthz
   ```

## Steps

1. Copy the candidate fixture and seed the due retrying run whose persisted
   repository source makes its restart startup fail:

   ```bash
   cp e2e/fixtures/restart-failure-isolation.json e2e/fixtures/issues.json
   docker exec symphony-e2e node /e2e/seed/restart-failure.mjs
   ```

2. Trigger one refresh:

   ```bash
   curl --fail -X POST \
     -H 'Authorization: Bearer e2e-http-token' \
     http://localhost:4680/api/v1/refresh
   ```

3. Poll the authenticated state API until `test-owner/test-repo#21` appears
   in `activeRuns`, then inspect the seeded run and issue record:

   ```bash
   curl --fail -H 'Authorization: Bearer e2e-http-token' \
     http://localhost:4680/api/v1/state
   docker exec symphony-e2e cat \
     /e2e/work/test-repo/.runtime/orchestrator/projects/repository/runs/restart-failure-run/run.json
   docker exec symphony-e2e cat \
     /e2e/work/test-repo/.runtime/orchestrator/projects/repository/issues.json
   ```

## Expected

- `restart-failure-run` is terminal `failed`, retains the startup error in
  `lastError`, and clears its `nextRetryAt` and `retryKind` fields.
- The retrying issue is `retry_queued` with `failureRetryCount: 2` and a
  future retry entry, so it is not immediately dispatched again.
- Candidate `#21` is dispatched during the same refresh tick.
- The project is `degraded` and retains the restart error in `lastError`.

## Cleanup

```bash
echo "[]" > e2e/fixtures/issues.json
docker compose -f docker-compose.e2e.yml down
```
