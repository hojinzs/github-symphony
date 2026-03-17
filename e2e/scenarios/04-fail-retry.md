# TC-04: Failure & Retry — Worker Fails, Orchestrator Retries

## Setup

```bash
# Start with fail scenario
docker compose -f docker-compose.e2e.yml up -d --build
```

Modify `docker-compose.e2e.yml` environment:
```yaml
environment:
  STUB_SCENARIO: fail
```

Then:
```bash
docker compose -f docker-compose.e2e.yml up -d --build
curl --retry 10 --retry-delay 2 http://localhost:4680/healthz
```

## Steps

1. **Inject issue fixture**
   ```bash
   cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json
   ```

2. **Trigger reconciliation**
   ```bash
   curl -X POST http://localhost:4680/api/v1/refresh
   ```

3. **Verify worker starts and fails**
   ```bash
   # After ~5s (2s starting + 3s running), worker should fail
   # Poll status
   curl -s http://localhost:4680/api/v1/status | jq '.activeRuns[0].status'
   # Expected: transitions from "starting" → "running" → "failed"
   ```

4. **Verify retry scheduling**
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.retryQueue'
   # Expected: non-empty retry queue with the failed issue
   ```

5. **Check event log**
   ```bash
   docker exec symphony-e2e sh -c 'cat /app/.runtime/projects/e2e-project/runs/*/events.ndjson'
   # Expected: dispatch event, failure event, retry-scheduled event
   ```

## Expected

- Worker starts and reports failure after ~5s
- Run record transitions to `failed`
- Orchestrator schedules a retry (appears in retryQueue)
- Token usage artifact is saved even on failure

## Cleanup

```bash
docker compose -f docker-compose.e2e.yml down
echo "[]" > e2e/fixtures/issues.json
```
