# TC-21: Linear dirty-workspace recovery attribution

## Setup

Build and start the Docker E2E environment with the deterministic Linear dirty
recovery scenario:

```bash
./e2e/run-e2e.sh linear-dirty-recovery 60
```

## Steps

1. Inject the file-tracker fixture whose opaque identifier is `DEV-54`.
2. Let the first worker create branch `dev-54-fix`, dirty
   `.gh-symphony/workpads/DEV-54.md`, and a partial source artifact.
3. Let that worker transition the issue to non-terminal `In review` before a
   turn completes, causing incomplete-turn dirty-workspace classification.
4. Reactivate `DEV-54` and trigger reconciliation.
5. Require the recovery worker to observe the original branch, workpad,
   partial artifact, recovery kind, and recovery prompt before completing.

## Expected

- The dirty workspace is attributed to `DEV-54` and reused.
- The recovery worker sees branch `dev-54-fix` and the unchanged workpad and
  partial artifact.
- No `recovery-quarantined` event is emitted.
- The recovered worker completes with the canonical fixture state `Done`.

## Cleanup

`e2e/run-e2e.sh` removes the Compose project, volumes, image, and injected
fixture contents automatically.
