# Required-label routability reconciliation

## Purpose

Verify both required-label boundaries: a candidate missing a required label is
never dispatched, and an active issue that loses one is canceled on the next
reconciliation tick. Both cases retain an explainable routability reason.

## Setup

1. Start the Docker E2E environment with `STUB_SCENARIO=stall`.
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
2. Trigger `POST /api/v1/refresh` with the E2E bearer token.
3. Inspect `/api/v1/state` and the run's `events.ndjson`.

## Expected results

- The worker receives `SIGTERM` and the run is suppressed with
  `runPhase: "canceled_by_reconciliation"`.
- The run error records the missing required label as its routability reason.
- The issue orchestration claim is released.
- The issue workspace remains present; no terminal cleanup occurs.
- `gh-symphony repo explain <identifier>` reports
  `not routable: Issue is missing required labels ("agent").`.
