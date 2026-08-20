# TC-13: Standalone project model Docker E2E

## Setup

`pnpm e2e:standalone-project` creates `project-alpha` and `project-beta`, which reference the same
local seed repository, in a one-shot container that bypasses the entrypoint. Each folder contains
`WORKFLOW.md`, `.mcp.json`, `.env`, and `.agent/skills/<name>/SKILL.md`.

## Steps

1. Register both projects into a single registry with `gh-symphony project add`.
2. Prepare two file-tracker issues whose label mappings are disjoint.
3. Run the orchestrator `run-once` for each project ID.
4. Inspect the bare cache, worktree, branch, MCP/skill injection, `git status`, and worker log.

## Expected

- Both projects share a single `<config-dir>/repos/test-owner/test-repo.git` bare cache.
- From the same combined fixture, each dispatches only the issue with its own label and
  runs on distinct branches:
  `symphony/project-alpha/test-owner-test-repo-101` and
  `symphony/project-beta/test-owner-test-repo-102`.
- After project skill injection, `git status --porcelain` is empty, the workers compose the
  project MCP server, and both workers record `status=completed`.

## Cleanup

The `/tmp` runtime and cache are removed when the one-shot container exits.
