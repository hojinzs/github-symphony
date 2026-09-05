# TC-12: Transition intent does not make the orchestrator author comments

## Setup

1. Start the Docker E2E stack with `STUB_SCENARIO=transition-race`.
2. The file-tracker fixture contains one `Ready` issue and the workflow polls every five seconds.

## Steps

1. Dispatch the stub worker for the `Ready` issue.
2. The worker requests `Ready → In review` through the run-scoped tracker-state API without a comment body.
3. The file tracker confirms the state readback without persisting comment metadata.
4. The worker remains running until reconciliation observes that `In review` is not actionable and terminates it.

## Expected

- The worker is observed in `running` before reconciliation terminates it.
- The fixture state is `In review`.
- `metadata.transitionComments` is absent, proving that the orchestrator and tracker adapter did not author a comment.
- Worker policy requires the agent to publish the prepared status body after confirmed readback; that host-side GitHub dispatch remains outside this file-tracker fixture.

## Cleanup

Run `docker compose -f docker-compose.e2e.yml down` and reset `e2e/fixtures/issues.json` to `[]`.
