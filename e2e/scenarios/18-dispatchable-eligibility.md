# Dispatchable eligibility suppression

This black-box regression verifies the orchestration boundary used by tracker
eligibility: a record with adapter-derived `dispatchable: false` remains
visible to dispatch evaluation but must not start a worker. The GitHub and
Linear adapter unit suites cover provider blocker derivation; this Docker case
verifies the adapter-neutral dispatch gate.

## Setup

Start the Docker E2E environment with an empty issue fixture.

## Steps

1. Inject `e2e/fixtures/blocked-issue.json`, whose blocked issue carries
   `dispatchable: false`, a non-empty `dispatchReason`, and best-effort
   `blockedBy` metadata.
2. Trigger `/api/v1/refresh` and wait through two post-injection reconciliation ticks.
3. Read `/api/v1/state` and the run event log.

## Expected

- The blocked tracker record is evaluated without starting a worker.
- `test-owner/test-repo#21` is absent from `activeRuns`, and no
  `run-dispatched` event is written for that identifier. The unblocked `#20`
  fixture record may dispatch.
- This scenario verifies that the scheduler respects adapter-provided
  dispatchability. GitHub and Linear adapter unit tests cover blocker
  derivation itself, including list and by-ID reads.

## Automated Docker command

```bash
./e2e/run-e2e.sh non-dispatchable 30
```

## Cleanup

Replace the fixture with `[]` and stop the Compose project.
