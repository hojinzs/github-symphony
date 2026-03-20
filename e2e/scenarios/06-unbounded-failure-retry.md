# TC-06: Unbounded Failure Retry — No Retry Attempt Cap After Third Failure

## Setup

```bash
echo "[]" > e2e/fixtures/issues.json
STUB_SCENARIO=fail docker compose -f docker-compose.e2e.yml up -d --build
curl --retry 10 --retry-delay 2 http://localhost:4680/healthz
```

## Steps

1. Inject a single active issue.
   ```bash
   cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json
   curl -s -X POST http://localhost:4680/api/v1/refresh
   ```

2. Wait until the worker reaches `running`, then remove the issue before the worker exits so the retry is classified as `failure`.
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '{
     activeRuns: [.activeRuns[] | {status, attempt}]
   }'
   echo "[]" > e2e/fixtures/issues.json
   ```

3. Wait until the worker fails and the first failure retry is scheduled.
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '{
     activeRuns: [.activeRuns[] | {status, attempt}],
     retryQueue: [.retryQueue[] | {attempt, retryKind, nextRetryAt}]
   }'
   # Expected: retryKind="failure"
   ```

4. Keep triggering refresh after each retry becomes due until the run reaches attempt 4.
   ```bash
   curl -s -X POST http://localhost:4680/api/v1/refresh
   ```

5. Verify that the run is still retried after the third failure.
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '{
     activeRuns: [.activeRuns[] | {status, attempt}],
     retryQueue: [.retryQueue[] | {attempt, retryKind, nextRetryAt}]
   }'
   # Expected: attempt >= 4 appears in activeRuns or retryQueue and retryKind="failure"
   ```

## Expected

- Failure retries continue past attempt 3.
- No terminal `failed` transition is caused by retry-attempt exhaustion.
- Retry scheduling remains governed by backoff delay only.

## Cleanup

```bash
docker compose -f docker-compose.e2e.yml down
echo "[]" > e2e/fixtures/issues.json
```
