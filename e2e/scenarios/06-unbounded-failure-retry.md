# TC-06: Retry Continues Past Third Worker Failure

## Setup

```bash
echo "[]" > e2e/fixtures/issues.json
# `docker-compose.e2e.yml` sets `STUB_SCENARIO: ${STUB_SCENARIO:-happy}`,
# so prefixing the command switches the stub container to the fail scenario.
STUB_SCENARIO=fail docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.events.yml up -d --build
curl --fail --retry-all-errors --retry 10 --retry-delay 2 http://localhost:4680/healthz
```

## Steps

1. Inject a single active issue.
   ```bash
   cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json
   curl -s -X POST http://localhost:4680/api/v1/refresh
   ```

2. Wait until the worker fails once and a retry is scheduled.
   ```bash
   curl -s http://localhost:4680/api/v1/test-owner%2Ftest-repo%231 | jq '{
     status,
     attempts,
     retry
   }'
   # Expected: status="retrying"
   ```

3. Keep the issue active and trigger reconciliation after each retry becomes due until the run reaches attempt 4.
   ```bash
   curl -s -X POST http://localhost:4680/api/v1/refresh
   ```

4. Verify that the run is still retried after the third worker failure.
   ```bash
   curl -s http://localhost:4680/api/v1/test-owner%2Ftest-repo%231 | jq '{
     status,
     attempts,
     retry,
     tracked
   }'
   # Expected: attempts.current_retry_attempt >= 4
   ```

## Expected

- Retries continue past attempt 3 even when the worker keeps exiting with failure.
- No terminal `failed` transition is caused by retry-attempt exhaustion.
- The orchestration remains active instead of being abandoned after the third failed worker run.

## Cleanup

```bash
docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.events.yml down
echo "[]" > e2e/fixtures/issues.json
rm -rf evidence
```
