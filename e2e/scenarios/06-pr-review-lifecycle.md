# TC-06: PR Review Lifecycle — Phase Transitions Across Retries

## Setup

```bash
echo "[]" > e2e/fixtures/issues.json
export STUB_SCENARIO=pr-review
docker compose -f docker-compose.e2e.yml up -d --build
curl --retry 10 --retry-delay 2 http://localhost:4680/healthz
```

## Steps

1. **Verify idle state**
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.health'
   # Expected: "idle"
   ```

2. **Inject issue with state "Ready" (planning phase)**
   ```bash
   cp e2e/fixtures/pr-review.json e2e/fixtures/issues.json
   curl -X POST http://localhost:4680/api/v1/refresh
   ```

3. **Observe planning phase** (poll every 1s)
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.activeRuns[0] | {status, executionPhase}'
   # Expected: status="running", executionPhase="planning"
   ```

4. **Wait for worker exit and continuation retry**
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.retryQueue[0].retryKind'
   # Expected: "continuation" (issue still in "Ready" = active state)
   ```

5. **Switch issue state to "In Progress" (simulates human approval)**
   ```bash
   cp e2e/fixtures/pr-review-in-progress.json e2e/fixtures/issues.json
   ```

6. **Observe implementation phase on retry** (poll every 1s)
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.activeRuns[0] | {status, executionPhase}'
   # Expected: status="running", executionPhase="implementation"
   ```

7. **Wait for worker exit and continuation retry**
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.retryQueue[0].retryKind'
   # Expected: "continuation" (issue still in "In Progress" = active state)
   ```

8. **Remove issue to stop retry cycle**
   ```bash
   echo "[]" > e2e/fixtures/issues.json
   ```

9. **Observe final release** (within ~15s)
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.health, .summary.activeRuns'
   # Expected: health="idle", activeRuns=0
   ```

## Expected Lifecycle

```
idle → [inject Ready issue + refresh]
     → dispatching (git clone ~3s)
     → running (executionPhase="planning", ~4s)
     → retrying/continuation
     → [switch issue to "In Progress"]
     → running (executionPhase="implementation", ~4s)
     → retrying/continuation
     → [remove issue]
     → retrying/failure → released → idle
```

- Phase 1: stub worker reads SYMPHONY_ISSUE_STATE="Ready" → reports executionPhase="planning"
- Orchestrator records the planning phase in the run record
- Phase 2: after issue state changes to "In Progress", new worker reads updated state → reports executionPhase="implementation"
- Orchestrator records the implementation phase in the run record
- This validates end-to-end phase transition through the orchestrator dispatch loop

## Cleanup

```bash
docker compose -f docker-compose.e2e.yml down
echo "[]" > e2e/fixtures/issues.json
```
