# TC-12: Orchestrator-owned transition comment survives reconciliation

## Setup

1. Start the Docker E2E stack with `STUB_SCENARIO=transition-race`.
2. The file-tracker fixture contains one `Ready` issue and the workflow polls every five seconds.

## Steps

1. Dispatch the stub worker for the `Ready` issue.
2. The worker requests `Ready → In review` through the run-scoped tracker-state API and supplies the exact transition body in `comment_body`.
3. The file tracker confirms the state readback and the orchestrator writes the exact body to the fixture.
4. The worker remains running until reconciliation observes that `In review` is not actionable and terminates it.

## Expected

- The worker is observed in `running` before reconciliation terminates it.
- The fixture state is `In review`.
- `metadata.transitionComments` contains exactly one exact transition body, proving that the comment was published by the orchestrator after confirmed readback and survived worker termination.
- No agent-side `gh issue comment` or correction path is involved.

## Cleanup

Run `docker compose -f docker-compose.e2e.yml down` and reset `e2e/fixtures/issues.json` to `[]`.
