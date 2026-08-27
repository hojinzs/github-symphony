# Dispatchable eligibility suppression

This black-box regression verifies the orchestration boundary used by GitHub
Project eligibility: a tracker record with `dispatchable: false` remains
visible to dispatch evaluation but must not start a worker. The GitHub adapter
unit suite covers derivation from assignment, repository scope, pickup labels,
and fork PR heads; this Docker case verifies the adapter-neutral dispatch gate.

## Setup

Start the Docker E2E environment with an empty issue fixture.

## Steps

1. Inject one active `Ready` file-tracker issue with `dispatchable: false` and
   a non-empty `dispatchReason`.
2. Trigger `/api/v1/refresh` and wait through one reconciliation interval.
3. Read `/api/v1/state` and the run event log.

## Expected

- The tracker record is evaluated without starting a worker.
- `activeRuns` remains `0` and no `run-dispatched` event is written.
- The same reason is available to the dispatch explain surface for the issue.

## Cleanup

Replace the fixture with `[]` and stop the Compose project.
