# TC-03: Stall Detection — SIGTERM & Retry

## Setup

```bash
# Start with stall scenario
STUB_SCENARIO=stall docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.events.yml up -d --build
curl --retry 10 --retry-delay 2 http://localhost:4680/healthz
```

Or override after startup:
```bash
docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.events.yml up -d --build
# Set STUB_SCENARIO=stall in docker-compose.e2e.yml environment section
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

3. **Verify worker starts and stalls**
   ```bash
   # After ~5s, worker should be stuck in "running" state
   curl -s http://localhost:4680/api/v1/status | jq '.activeRuns[0].status'
   # Expected: "running" (indefinitely)
   ```

4. **Wait for stall detection** (depends on orchestrator stall timeout config)
   ```bash
   # Monitor logs for stall detection
   docker logs symphony-e2e --tail 20
   # Expected: stall detection event, SIGTERM sent to worker
   ```

5. **Verify graceful shutdown**
   ```bash
   docker exec symphony-e2e sh -c 'cat /app/.runtime/projects/e2e-project/runs/*/events.ndjson' | tail -5
   # Expected: events showing stall detection and worker termination
   ```

6. **Verify legacy fallback behavior explicitly**
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.activeRuns[0] | {startedAt, lastEventAt, status}'
   # Expected before SIGTERM: stub worker updates /api/v1/state lastEventAt, but no stderr codex_update channel exists
   # Expected orchestrator behavior: legacy worker remains compatible because API lastEventAt backfills activity until an event-channel timestamp exists
   ```

7. **Verify token usage artifact saved**
   ```bash
   docker exec symphony-e2e sh -c 'find /app/.runtime -name token-usage.json -exec cat {} \;'
   # Expected: { "inputTokens": 150, "outputTokens": 42, "totalTokens": 192 }
   ```

## Expected

- Worker enters "running" state and never transitions to "completed"
- Orchestrator detects stall after configured timeout
- Worker receives SIGTERM and saves token-usage artifact before exiting
- Orchestrator schedules retry for the issue
- Legacy worker path without stderr event channel can still refresh activity from `/api/v1/state`

## Cleanup

```bash
docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.events.yml down
echo "[]" > e2e/fixtures/issues.json
rm -rf evidence
```
