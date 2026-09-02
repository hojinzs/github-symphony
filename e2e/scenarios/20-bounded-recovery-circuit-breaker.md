# TC-20: Bound Dirty-Workspace Recovery Retries

## Setup

Run the dedicated Docker black-box scenario:

```bash
./e2e/run-e2e.sh recovery-fail 60
```

The runner sets `agent.max_failure_retries: 3`. Its deterministic stub writes
`recovery-loop.txt` into the issue workspace before every non-zero exit, so
each failed run carries dirty-workspace recovery context.

## Steps

1. Inject one active file-tracker issue and observe the first worker run.
2. Keep the tracker issue active while the orchestrator schedules and starts
   its recovery retries.
3. Wait for the third failed attempt to exhaust the configured failure budget.
4. Inspect the persisted issue and run records inside the container.
5. Trigger two additional tracker refreshes while the issue remains active.

## Expected

- Exactly three worker attempts run; dirty recovery does not bypass the
  failure budget.
- The last run is `suppressed`, retains `recovery-loop.txt` in its recovery
  context, and reports that manual intervention is required.
- The issue claim is released with `failureRetryCount: 3` and no retry entry.
- Later same-state refreshes do not reset the counter or dispatch another run.
- An explicit tracker state change is required to re-arm the issue.

## Cleanup

The runner's exit trap stops and removes its isolated Compose project, clears
the file-tracker fixture, and removes generated evidence.
