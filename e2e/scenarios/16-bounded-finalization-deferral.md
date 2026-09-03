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
4. Inspect the one final readback performed after the worker exit.
5. Inspect the persisted run event log from inside the Docker container.

## Expected

- Exactly one `run-finalization-deferred` event is persisted.
- Its `consecutiveDeferrals` is `1`, `maxDeferrals` is `3`, and `exhausted` is `false`.
- Refresh reconciliation does not re-enter worker-exit finalization, so it cannot
  exhaust the bounded sequence in this black-box scenario.
- `packages/orchestrator/src/service.test.ts` remains the authoritative coverage
  for the three-read sequence and its failure-retry transition.

## Cleanup

The E2E runner stops the Docker stack and restores `e2e/fixtures/issues.json`
to an empty array automatically.
