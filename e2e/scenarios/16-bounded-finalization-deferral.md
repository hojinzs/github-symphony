# TC-16: Bounded unknown finalization deferral

## Setup

Run the Docker E2E harness with the scenario that confirms tracker progress,
removes the canonical file-tracker item, and then exits successfully:

```bash
bash e2e/run-e2e.sh api-progress-unknown 120
```

## Steps

1. Inject the standard `Ready` issue and dispatch the stub worker.
2. Let the worker request and confirm `Ready → Done` through the run-scoped API.
3. Let the worker remove the canonical item before its successful exit.
4. Allow reconciliation to classify three consecutive final readbacks as unknown.
5. Inspect the persisted run event log from inside the Docker container.

## Expected

- Exactly three `run-finalization-deferred` events are persisted.
- `consecutiveDeferrals` is `1`, `2`, then `3`.
- `maxDeferrals` is `3` on every event.
- Only the third event has `exhausted: true`.
- Reconciliation leaves the indefinitely deferred path and enters failure retry handling.

## Cleanup

The E2E runner stops the Docker stack and restores `e2e/fixtures/issues.json`
to an empty array automatically.
