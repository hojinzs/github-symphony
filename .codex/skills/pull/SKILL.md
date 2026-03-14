---
name: pull
description: Sync the current branch with the latest remote base before implementation or review handoff.
license: MIT
metadata:
  author: gh-symphony
  version: "1.0"
  generatedBy: "gh-symphony"
---

# /pull — Git Pull / Sync Workflow

## Trigger

Use this skill to sync the current branch with the latest `origin/main`
before starting work or before creating a PR.

## Flow

1. Fetch latest from remote:
   ```bash
   git fetch origin
   ```
2. Merge into current branch:
   ```bash
   git merge origin/main
   ```
3. If conflicts arise:
   - Resolve each conflict file
   - Run tests to confirm nothing broke
   - Commit the merge: `git commit` (merge commit message is auto-generated)
4. Re-run tests after merge to confirm the integrated state is clean
5. Record pull skill evidence in workpad Notes:
   - merge source (e.g. `origin/main`)
   - result: `clean` or `conflicts resolved`
   - resulting HEAD short SHA: `git rev-parse --short HEAD`

## Rules

- Always pull before creating a PR
- Always pull at the start of a new work session
- Record the pull evidence in the workpad before proceeding