# TC-15: Terminal candidate reconciliation

## Setup

1. Reset `e2e/fixtures/issues.json` to `[]`.
2. Start the Docker E2E stack with the default `happy` stub scenario.
3. Wait for `http://localhost:4680/healthz` to become ready.

## Steps

1. Copy `e2e/fixtures/terminal-candidate.json` to `e2e/fixtures/issues.json`.
2. Trigger `POST /api/v1/refresh` with the configured bearer token.
3. Poll the mounted fixture until issue `#30` has state `Done`.
4. Inspect `GET /api/v1/state` and the container logs.

## Expected

- Issue `#30` is never present in `activeRuns`; the stub worker is not started.
- Its stale active `Ready` state is reconciled to terminal state `Done`.
- The reconciliation tick counts one suppressed candidate; a later idle poll may reset the current summary counters to zero.
- Container logs contain a `tracker-terminal-candidate-reconciled` structured event with `terminalFact: issue_closed`, `targetState: Done`, and `outcome: confirmed`.

## Cleanup

```bash
echo "[]" > e2e/fixtures/issues.json
docker compose -f docker-compose.e2e.yml down
```
