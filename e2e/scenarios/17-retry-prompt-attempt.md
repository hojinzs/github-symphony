# TC-17: Retry prompt attempt rendering

## Setup

Build the workspace and start the Docker E2E environment with the default
`happy` stub scenario. Add the `Ready` fixture and trigger a refresh.

## Steps

1. Wait for the stub worker to complete while the issue remains actionable.
2. Confirm the orchestrator queues a `continuation` retry with a one-second
   delay.
3. Confirm the next worker dispatch starts from that queued continuation.
4. Run `packages/orchestrator/src/service.test.ts` and
   `packages/core/src/workflow/render.test.ts`.

## Expected

- The continuation retry record has `attempt: 1`, independent of earlier
  failure retry counts.
- The restarted worker's rendered prompt receives `attempt=1`.
- An initial execution still receives a null template value.

## Cleanup

Remove the fixture issue and stop the Docker environment.
