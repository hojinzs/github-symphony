# TC-15: Restart failure isolation

## Automated coverage

`packages/orchestrator/src/service.test.ts` seeds a due retrying run whose
restart checkout fails, then verifies that the original run is retained as
failed with its diagnostic while both eligible candidates, including a healthy
later candidate, dispatch during the same reconciliation tick.

## Docker black-box confirmation

1. Start the Docker E2E stack and wait for `/healthz`.
2. Inject a due retrying run for candidate `#20` whose issue workspace causes
   checkout to fail, alongside a healthy actionable candidate `#21`.
3. Trigger `POST /api/v1/refresh` once.
4. Inspect the project state and persisted run records.

## Expected

- The original `#20` run is terminal `failed` and retains the checkout error
  in `lastError`.
- The project snapshot is `degraded` and retains the same diagnostic.
- Candidate `#21` is dispatched without waiting for a second refresh.

## Cleanup

```bash
echo "[]" > e2e/fixtures/issues.json
docker compose -f docker-compose.e2e.yml down
```
