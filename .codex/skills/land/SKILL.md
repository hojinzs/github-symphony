---
name: land
description: Merge approved pull requests safely after verifying approvals, CI, and branch freshness.
license: MIT
metadata:
  author: gh-symphony
  version: "1.0"
  generatedBy: "gh-symphony"
---

# /land — PR Merge Workflow

## Trigger

Use this skill when the issue is in the Merging state (PR approved by human).
Do NOT call `gh pr merge` directly — always go through this flow.

## Pre-flight Checks

Before merging, verify ALL of the following:

1. **PR is approved**:
   ```bash
   gh pr view --json reviews --jq '.reviews[] | select(.state == "APPROVED")'
   ```
2. **All CI checks are green**:
   ```bash
   gh pr checks
   ```
3. **Branch is up-to-date with base**:
   ```bash
   git fetch origin && git merge-base --is-ancestor origin/main HEAD
   ```
   If not up-to-date, run the `/pull` skill first.

## Flow

1. Run all pre-flight checks above
2. If all checks pass, merge the PR:
   ```bash
   gh pr merge --squash    # squash merge (default)
   # or: gh pr merge --merge   # merge commit
   # or: gh pr merge --rebase  # rebase merge
   ```
   Choose the merge strategy per project policy.
3. On merge success:
   - Use the **gh-project skill** to transition the issue status to Done
   - Do NOT call status APIs directly — delegate to gh-project
4. On merge failure:
   - Record the failure reason in workpad Notes
   - Resolve the blocking issue (re-run pre-flight checks)
   - Retry the merge
5. Loop until merged or blocked by an unresolvable issue

## Rules

- Never call `gh pr merge` without completing pre-flight checks
- Status transition to Done MUST go through the gh-project skill
- If any pre-flight check fails, do not merge — fix the issue first
- Record all merge attempts and outcomes in the workpad