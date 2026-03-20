# TC-06: Retry/Recovery - Issue Title Preservation

## Setup

```bash
echo "[]" > e2e/fixtures/issues.json
docker compose -f docker-compose.e2e.yml up -d --build
curl --retry 10 --retry-delay 2 http://localhost:4680/healthz
```

## Steps

1. Inject the standard happy-path fixture.
   ```bash
   cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json
   ```
2. Trigger reconciliation and wait for the first run to complete.
   ```bash
   curl -X POST http://localhost:4680/api/v1/refresh
   ```
3. Keep the issue active long enough for a continuation retry to be scheduled and revived.
   ```bash
   curl -s http://localhost:4680/api/v1/status | jq '.retryQueue'
   ```
4. Inspect persisted run records inside the container.
   ```bash
   docker exec symphony-e2e sh -c 'find /app/.runtime/projects/e2e-project/runs -name run.json -exec cat {} \;'
   ```
5. Verify that both the original run and the recovered retry run preserve the original issue title instead of replacing it with the identifier.

## Expected

- The initial run record stores `"issueTitle": "Happy path test issue"`.
- A continuation or recovery retry run is created after the first worker exit.
- The retry run record also stores `"issueTitle": "Happy path test issue"`.
- No retry run record regresses to `"issueTitle": "test-owner/test-repo#1"`.

## Cleanup

```bash
docker compose -f docker-compose.e2e.yml down
echo "[]" > e2e/fixtures/issues.json
```
