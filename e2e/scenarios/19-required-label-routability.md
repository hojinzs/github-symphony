# Required-label routability reconciliation

## Purpose

Verify both required-label boundaries: a candidate missing a required label is
never dispatched, and an active worker that loses one ends at the next turn
boundary. Both cases retain an explainable routability reason.

## Setup

1. Start the Docker E2E environment with `STUB_SCENARIO=required-label-removed`.
2. Add `required_labels: [agent]` to the fixture repository `WORKFLOW.md`
   before starting the daemon.
3. Inject a `Ready` file-tracker issue with the `agent` label and wait until
   the stub worker is running.

## Case A: missing label before dispatch

1. Inject a `Ready` file-tracker issue without the `agent` label.
2. Trigger `POST /api/v1/refresh` with the E2E bearer token and wait for two
   reconciliation ticks.
3. Inspect `/api/v1/state`, `events.ndjson`, and `repo explain`.

### Expected results

- No worker is started and no `run-dispatched` event is written.
- `gh-symphony repo explain <identifier>` reports
  `not routable: Issue is missing required labels ("agent").`.

## Case B: label removed during a run

1. Remove `agent` from the issue's `labels` array while preserving its active
   state.
2. Let the deterministic stub complete turn one and issue its turn-boundary
   `state-read`.
3. Inspect the worker log and the run's `events.ndjson`.

## Expected results

- The worker log records `turn=1 completed` followed by
  `turn=2 prevented by routability refresh`; it must not begin turn two.
- The worker exits cleanly after its state-read reports the missing required
  label as unroutable.
- `gh-symphony repo explain <identifier>` reports
  `not routable: Issue is missing required labels ("agent").`.
