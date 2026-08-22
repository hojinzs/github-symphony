# TC-15: Global repository cache maintenance

## Setup

Build the image and start the default Docker E2E stack so one issue workspace is populated from the shared bare cache.

## Steps

1. Run `gh-symphony cache status --json` in the container and verify the seeded repository is listed with a positive byte count.
2. Run `gh-symphony cache prune --max-age-days 0 --dry-run --json` and verify the active cache is skipped because it has a linked worktree.
3. Run `gh-symphony cache prune --max-age-days 0 --json` and verify the cache directory remains present.
4. Stop the orchestrator, remove the issue worktree through normal cleanup, run prune again, and verify the idle cache is removed.

## Expected

Inventory reports deterministic repository, size, lock, and worktree fields. Dry-run performs no deletion. Cleanup never deletes a locked cache or one backing an active worktree, and removes an eligible idle cache after normal workspace cleanup.

## Cleanup

Stop the Docker E2E stack and restore the fixture.
