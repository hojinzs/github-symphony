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
3. Let the stub report the host transport contract indicating the committed
   branch push succeeded while those edits remain unpublished, and transition
   the issue to `Done`.
4. Inspect the persisted run and workspace after terminal reconciliation.

## Expected

- The run remains `succeeded`/`succeeded`, rather than becoming a transport or
  ordinary worker failure.
- Its `lastError` identifies `git_unpublished_worktree`, the committed
  transport outcome, and tracked/untracked file lists.
- The workspace remains active with the same diagnostic, and both unpublished
  files remain present after terminal cleanup has been considered.

## Cleanup

`e2e/run-e2e.sh` removes the Compose project, volumes, image, and injected
fixture contents automatically.
