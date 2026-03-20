# TC-01: Happy Path — Single Issue Dispatch & Worker Lifecycle

## Setup

```bash
echo "[]" > e2e/fixtures/issues.json
docker compose -f docker-compose.e2e.yml up -d --build
curl --fail --retry-all-errors --retry 10 --retry-delay 2 http://localhost:4680/healthz
```

## Steps

1. **Verify idle state**
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.health'
   # Expected: "idle"
   ```

2. **Inject issue fixture**
   ```bash
   cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json
   ```

3. **Trigger reconciliation**
   ```bash
   curl -X POST http://localhost:4680/api/v1/refresh
   ```

4. **Wait for dispatch** (poll every 1s, allow ~5s for git clone + workspace prep)
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.summary.activeRuns'
   # Expected: 1 (within ~5s)
   ```

5. **Observe worker running** (poll every 1s)
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.activeRuns[0] | {status, executionPhase, lastEvent}'
   # Expected: status="running", executionPhase="implementation", lastEvent="running"
   # Worker stays in running state for ~7s (2s starting + 5s running)
   ```

6. **Observe continuation retry** (after ~12s from dispatch)
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.activeRuns[0].status, .retryQueue[0].retryKind'
   # Expected: status="retrying", retryKind="continuation"
   # Because issue is still in "Ready" (active) state, orchestrator schedules continuation
   ```

7. **Remove issue to stop retry cycle** (simulates worker changing state to "Done")
   ```bash
   echo "[]" > e2e/fixtures/issues.json
   ```

8. **Observe final failure + release** (within ~15s)
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.health, .summary.activeRuns'
   # Expected: health="idle", activeRuns=0
   # Worker exits → issue not found → retryKind="failure"
   # Due retry rechecks tracker eligibility and releases the orchestration
   ```

9. **Verify event log**
   ```bash
   docker exec symphony-e2e sh -c 'cat /app/.runtime/projects/e2e-project/runs/*/events.ndjson'
   # Expected: run-dispatched and run-recovered events
   ```

## Expected Lifecycle

```
idle → [inject issue + refresh] → dispatching (git clone ~3s)
     → running (stub worker ~7s) → retrying/continuation
     → [remove issue] → retrying/failure → released → idle
```

- Issue `test-owner/test-repo#1` is dispatched to stub worker
- Stub worker reports status via `/api/v1/state` endpoint
- Orchestrator polls worker and tracks executionPhase, lastEvent
- After worker exit, orchestrator classifies retry as "continuation" (issue still active)
- After issue removal, retry becomes "failure", and the due retry tick releases the run instead of restarting a worker

## Cleanup

```bash
docker compose -f docker-compose.e2e.yml down
echo "[]" > e2e/fixtures/issues.json
```
