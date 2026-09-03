---
name: pull
description: Bring the assigned branch up to date with its base branch by merging (never rebasing), so the host-owned fast-forward push still succeeds.
license: MIT
metadata:
  author: gh-symphony
  version: "3.0"
  generatedBy: "gh-symphony"
---

# /pull — Branch Sync Workflow (merge only)

## Trigger

Use this skill to bring the assigned branch up to date with its base branch:

- At the start of a rework cycle when the PR is behind its base.
- Before the handoff when `main` moved and your change touches the same files.
- During a Land cycle only for a **trivial conflict** (`.changeset/*`, `docs/**`, `CHANGELOG.md`, lockfile); otherwise Land uses the server-side `updatePullRequestBranch` mutation.

## Why merge, never rebase

The worker child has no push credentials. The host pushes `$SYMPHONY_ASSIGNED_BRANCH` at the end of every turn and **refuses** the push when `origin/<branch>` is not an ancestor of your local head. A rebase, amend, reset, or squash of commits that are already on the remote makes the push impossible and strands your work. A merge commit keeps history fast-forwardable and keeps prior human approvals valid.

## Flow

1. Confirm you are on the assigned branch: `git branch --show-current` must equal `$SYMPHONY_ASSIGNED_BRANCH`. Never switch branches.
2. Determine the base branch: the PR's `baseRefName` when a PR exists (from the workpad or the `IssueContext` query), otherwise `main`.
3. Refresh the base ref. The orchestrator refreshed `origin/<base>` in the shared cache at dispatch; try `git fetch origin <base>` for a newer ref, and if it fails for lack of credentials (private repository), continue with the cached `origin/<base>`.
4. Merge:

   ```bash
   git merge --no-edit "origin/$base"
   ```

5. On conflicts:
   - Resolve them in the worktree, run the relevant validation (Completion Bar for source files; `pnpm install --lockfile-only` or `npm install --package-lock-only` when the lockfile conflicted), then `git add` and `git commit --no-edit`.
   - If you cannot resolve them in this turn, `git merge --abort` before the turn ends — never leave a merge in progress.
   - In a Land cycle, a conflict outside the trivial set is a rework failure: abort and let `/land` classify it.
6. Verify `git status --porcelain` is empty and `git log --oneline -1` shows the merge commit. The host pushes it at turn end.
7. Record the merge (base SHA merged, conflicts resolved) in the workpad Progress Log.

## Rules

- Never `git rebase`, `git commit --amend`, `git reset --hard`, or `git push --force*`.
- Never merge into `main` locally or check it out.
- Do not re-run a merge that already produced a merge commit this turn; the branch is up to date once `git merge-base --is-ancestor origin/$base HEAD` succeeds.
