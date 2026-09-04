# TC-14: Dispatch start failure isolation

## Setup

1. Reset `e2e/fixtures/issues.json` to `[]`.
2. Start the Docker E2E stack with the default `happy` stub scenario:

   ```bash
   GH_SYMPHONY_HTTP_TOKEN=e2e-http-token \
     docker compose -f docker-compose.e2e.yml up -d --build
   ```

3. Wait for `http://localhost:4680/healthz` to become ready.

## Steps

1. Copy `e2e/fixtures/dispatch-start-failure.json` to
   `e2e/fixtures/issues.json`.
2. Trigger `POST /api/v1/refresh` with the configured bearer token.
3. Poll `GET /api/v1/state` until `test-owner/test-repo#21` appears in
   `activeRuns`.
4. Inspect
   `/e2e/work/test-repo/.runtime/orchestrator/projects/*/issues.json`
   in the container.
5. Inspect the container logs for the failed `test-owner/test-repo#20`
   dispatch.

## Expected

- Candidate `#20` is released with `failureRetryCount` at the configured
  suppression limit and no `retryEntry`, because missing pull request metadata
  is a permanent dispatch error.
- Candidate `#21` reaches `running` in the same reconciliation tick.
- The project remains `degraded` and retains candidate `#20`'s error in
  `lastError` without aborting the tick.
- The log reports the isolated failure and that retries were suppressed.

## Cleanup

```bash
echo "[]" > e2e/fixtures/issues.json
docker compose -f docker-compose.e2e.yml down
```
