# TC-24: Standalone hook configuration fault

## Setup

`pnpm e2e:standalone-project` creates a folder-addressed project whose
`WORKFLOW.md` declares `hooks/after_create.sh`, then removes that script.

## Steps

1. Run the packaged `gh-symphony project start` from the broken project folder.
2. Inspect its exit status and stderr before starting the two valid standalone
   project fixtures.

## Expected

- Start exits non-zero with `Project configuration fault`.
- The diagnostic names the resolved absolute path to
  `hooks/after_create.sh`.
- No worker is dispatched for the broken project. The valid project fixtures
  still dispatch normally with executable population hooks.

## Cleanup

The one-shot container removes its `/tmp` runtime and project folders on exit.
