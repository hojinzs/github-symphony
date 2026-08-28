# TC-06: Worker Failure Lifecycle Regression

## Setup

```bash
./e2e/run-e2e.sh fail 30
```

## Steps

1. Start the E2E environment with the `fail` scenario.
2. Inject the `happy-path` fixture and trigger reconciliation.

```bash
# Inject the happy-path fixture
cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json

# Send a refresh request to the orchestrator to trigger reconciliation
ORCH_URL="${ORCH_URL:-http://localhost:8080}"
curl -X POST "${ORCH_URL}/api/v1/refresh"
```

3. Observe that the worker enters `running` from `starting` and then fails.
4. Confirm that the orchestrator schedules a retry and returns to `idle` after the issue is removed.

```bash
# Poll worker / orchestrator state to observe the state transitions
watch -n 2 curl -s "${ORCH_URL:-http://localhost:8080}/api/v1/status"
```

## Expected

- After the worker failure, the orchestrator detects the run failure.
- The non-zero worker exit is recorded as a `failure` retry with retained diagnostics and exponential backoff.
- After cleanup, the state returns to `idle`.

## Cleanup

```bash
docker compose -f docker-compose.e2e.yml down
echo "[]" > e2e/fixtures/issues.json
```
