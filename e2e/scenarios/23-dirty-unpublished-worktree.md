# TC-23: Dirty unpublished worktree retention

## Setup

Build and start the Docker E2E environment with the deterministic dirty
publication scenario:

```bash
./e2e/run-e2e.sh dirty-unpublished-worktree 60
```

## Steps

1. Dispatch the `Ready` fixture issue.
2. Let the stub create and commit `tracked.txt`, then modify it and create the
   untracked `untracked/notes.txt` file.
3. Let the stub simulate the host transport contract indicating the committed
   branch push succeeded while those edits remain unpublished, and transition
   the issue to `Done`.
4. Inspect the persisted run and workspace after terminal reconciliation.

## Expected

- The run remains `succeeded`/`succeeded`, rather than becoming a transport or
  ordinary worker failure.
- Its dedicated `unpublishedWorktree` record identifies the committed
  transport outcome and bounded tracked/untracked file lists while `lastError`
  remains null.
- The workspace remains active with the same publication record, and both
  unpublished files remain present after terminal cleanup has been considered.
- This scenario verifies orchestrator retention with a simulated transport
  outcome; worker-side Git detection is covered by `git-transport.test.ts`.

## Cleanup

`e2e/run-e2e.sh` removes the Compose project, volumes, image, and injected
fixture contents automatically.
