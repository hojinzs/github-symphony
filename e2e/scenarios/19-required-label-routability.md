# Required-label routability reconciliation

## Purpose

Verify that an active issue which loses a required label is canceled on the
next reconciliation tick, retains its workspace, and exposes the routing
reason to diagnostics.

## Setup

1. Start the Docker E2E environment with `STUB_SCENARIO=stall`.
2. Add `required_labels: [agent]` to the fixture repository `WORKFLOW.md`
   before starting the daemon.
3. Inject a `Ready` file-tracker issue with the `agent` label and wait until
   the stub worker is running.

## Steps

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
