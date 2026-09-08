# TC-13: Standalone project model Docker E2E

## Setup

`pnpm e2e:standalone-project` creates `project-alpha` and `project-beta`, which reference the same
local seed repository in a one-shot container. Each folder contains
`WORKFLOW.md`, `hooks/after_create.sh`, `.mcp.json`, `.env`, and `.agent/skills/<name>/SKILL.md`.

## Steps

1. Prepare two file-tracker issues whose label mappings are disjoint.
2. Start both projects at once by running `gh-symphony project start` from inside each
   project folder — no registration step and no shared active-project state.
3. Inspect the hook-populated clone, workspace location, branch, MCP/skill injection, `git status`,
   and worker log.

## Expected

- Each project hook clones directly into its own issue workspace; no shared repository cache is created.
- Project alpha recovers a persisted clean `fix/2-foreign` checkout into the stable issue #101 recovery workspace before the real worker identity preflight, while preserving the original foreign commit and file.
- From the same combined fixture, each dispatches only the issue with its own label and
  runs on distinct branches:
  `symphony/project-alpha/test-owner-test-repo-101` and
  `symphony/project-beta/test-owner-test-repo-102`.
- Issue workspaces are created under each project folder's `workspace.root`
  (`.runtime/workspaces`), not inside the runtime state directory.
- After project skill injection, `git status --porcelain` is empty, the workers compose the
  project MCP server, and both workers record `status=completed`.

## Cleanup

The `/tmp` runtime and workspaces are removed when the one-shot container exits.
