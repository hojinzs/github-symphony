# TC-23: Cross-runtime-root project lock

## Purpose

Verify that a canonical project folder cannot host two orchestrators through
different runtime roots while preserving concurrent starts for different
project folders.

## Procedure

1. Run `./e2e/run-standalone-project-e2e.sh`.
2. The runner starts `project-alpha` and `project-beta` concurrently under the
   primary runtime root.
3. While `project-alpha` remains live, the runner starts the same folder again
   with an alternate `--config` root and `TMPDIR`, using `--once` so a
   duplicate-exclusion regression terminates instead of hanging the runner.

## Expected result

- The two distinct folders run and dispatch independently.
- The second start of `project-alpha` exits non-zero with `is already running`.
- The original daemon remains healthy and completes its dispatch.
