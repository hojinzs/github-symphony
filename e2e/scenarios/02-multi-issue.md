# TC-02: Multi-Issue — Concurrency Limit Enforcement

## Setup

```bash
docker compose -f docker-compose.e2e.yml up -d --build
curl --retry 10 --retry-delay 2 http://localhost:4680/healthz
```

## Steps

1. **Inject multi-issue fixture** (3 issues, concurrency_limit=2 in WORKFLOW.md)
   ```bash
   cp e2e/fixtures/multi-issue.json e2e/fixtures/issues.json
   ```

2. **Trigger reconciliation**
   ```bash
   curl -X POST http://localhost:4680/api/v1/refresh
   ```

3. **Verify concurrency cap** (poll within 10s)
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.activeRuns | length'
   # Expected: 2 (third issue is queued, not dispatched)
   ```

4. **Wait for first batch completion** (~7s)
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.summary'
   ```

5. **Trigger another reconciliation** to dispatch the queued issue
   ```bash
   curl -X POST http://localhost:4680/api/v1/refresh
   ```

6. **Verify third issue dispatched**
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.activeRuns | length'
   # Expected: 1 (third issue now running)
   ```

## Expected

- At most 2 issues are dispatched concurrently (concurrency_limit=2)
- Third issue is dispatched only after one of the first two completes
- All 3 issues eventually reach `succeeded` status

## Cleanup

```bash
docker compose -f docker-compose.e2e.yml down
echo "[]" > e2e/fixtures/issues.json
```
