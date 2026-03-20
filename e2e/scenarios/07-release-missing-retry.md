# TC-07: Release Missing Retry Queue Instead of Restarting

## Setup

```bash
echo "[]" > e2e/fixtures/issues.json
# `docker-compose.e2e.yml` sets `STUB_SCENARIO: ${STUB_SCENARIO:-happy}`,
# so prefixing the command switches the stub container to the fail scenario.
STUB_SCENARIO=fail docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.events.yml up -d --build
curl --fail --retry-all-errors --retry 10 --retry-delay 2 http://localhost:4680/healthz
```

## Steps

1. Inject a single active issue and trigger reconciliation.
   ```bash
   cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json
   curl -s -X POST http://localhost:4680/api/v1/refresh
   ```

2. Wait until the worker fails once and the orchestrator reports a queued retry.
   ```bash
   curl -s http://localhost:4680/api/v1/test-owner%2Ftest-repo%231 | jq '{
     status,
     attempts,
     retry
   }'
   # Expected: status="retrying", retry.kind="continuation" or "failure"
   ```

3. Remove the issue before the queued retry becomes due.
   ```bash
   echo "[]" > e2e/fixtures/issues.json
   ```

4. Trigger reconciliation after the due time and verify the orchestrator releases the issue instead of starting a new worker.
   ```bash
   curl -s -X POST http://localhost:4680/api/v1/refresh
   curl -s http://localhost:4680/api/v1/test-owner%2Ftest-repo%231 | jq '{
     status,
     attempts,
     retry,
     tracked
   }'
   ```

## Expected

- No new worker is started after the retry becomes due.
- The issue status transitions away from `retrying` and surfaces as `suppressed`.
- `tracked.issue_orchestration_state` is `released`.

## Cleanup

```bash
docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.events.yml down
echo "[]" > e2e/fixtures/issues.json
rm -rf evidence
```
