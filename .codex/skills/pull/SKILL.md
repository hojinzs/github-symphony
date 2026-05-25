---
name: pull
description: Sync the current branch with the latest base branch (PR base if a PR exists, otherwise origin/main).
license: MIT
metadata:
  author: gh-symphony
  version: "2.0"
  generatedBy: "gh-symphony"
---

# /pull — Branch Sync Workflow

## Trigger

Use this skill to bring the current branch up to date with its base branch:
- Before creating a PR.
- Before starting a new work session on an existing branch.
- When the `/land` skill's pre-flight check 3 (branch up-to-date with PR base) fails.

## Flow

1. Determine the base branch:
   ```bash
   # If a PR exists for the current branch:
   pr_number=$(gh pr view --json number --jq .number 2>/dev/null)
   if [ -n "$pr_number" ]; then
     base=$(gh pr view --json baseRefName --jq .baseRefName)
   else
     base="main"
   fi
   ```

2. Fetch latest:
   ```bash
   git fetch origin "$base"
   ```

3. Rebase the current branch onto the base:
   ```bash
   git rebase "origin/$base"
   ```

   - `rebase` (not `merge`) keeps the branch history linear and avoids creating merge commits — required for the squash-merge policy used by `/land`.

4. If conflicts arise:
   - Resolve each conflict file.
   - `git rebase --continue` after staging the resolution.
   - Re-run tests to confirm the integrated state is clean.

5. After a successful rebase, the local branch has new commit SHAs. If the branch was already pushed (e.g. a Draft PR exists), force-push with lease:
   ```bash
   git push --force-with-lease origin <branch-name>
   ```
   `--force-with-lease` is safer than `--force`: it refuses to overwrite if the remote moved since your last fetch.

6. Record the pull skill evidence in the workpad `### Validation` section:
   - base branch (e.g. `origin/feature/epic-x` or `origin/main`)
   - result: `clean` or `conflicts resolved`
   - resulting HEAD short SHA: `git rev-parse --short HEAD`

## Rules

- Always use the PR's actual base branch (not hardcoded `origin/main`) when a PR exists. An Epic working branch must rebase against the Epic base, not `main`.
- Use `git rebase` (not `git merge`) to keep history linear for the squash-merge policy.
- After rebase + force-push, treat the branch as having new commit SHAs — any prior approval on the PR is invalidated; re-run pre-flight checks.
- Record the rebase evidence in the workpad before proceeding to PR creation or merge.
