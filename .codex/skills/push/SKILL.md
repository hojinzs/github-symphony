---
name: push
description: Explains the host-owned push of the assigned branch and the turn-end checklist that makes it succeed. There is no agent-side push command.
license: MIT
metadata:
  author: gh-symphony
  version: "2.0"
  generatedBy: "gh-symphony"
---

# /push — Host-owned Branch Publication

## How publishing works

The worker child has no GitHub credentials, so `git push` from the agent fails. Instead, at the end of **every turn** (and again at session end) the worker host:

1. verifies the worktree is still on `$SYMPHONY_ASSIGNED_BRANCH` (refuses otherwise),
2. copies that ref into a temporary bare repository,
3. fetches `origin/<branch>` and checks it is an ancestor of your head (refuses non-fast-forward),
4. pushes with repository hooks disabled to the orchestrator-owned target URL,
5. records any tracked or untracked files still in the worktree as **unpublished work**, which blocks cleanup and triggers dirty-workspace recovery on the next dispatch.

## Turn-end checklist (run before you finish the message)

```bash
git branch --show-current            # must equal $SYMPHONY_ASSIGNED_BRANCH
git status --porcelain               # must be empty: commit everything, delete scratch files
git rev-parse --verify MERGE_HEAD 2>/dev/null && echo "merge in progress — finish or abort"
git log --oneline origin/"$SYMPHONY_ASSIGNED_BRANCH"..HEAD 2>/dev/null   # commits the host will push
```

- Scratch files (comment bodies, PR bodies, transition bodies) live under `mktemp -d "${TMPDIR:-/tmp}/symphony-<issue>.XXXXXX"`, never in the checkout.
- Run the relevant validation before committing; a broken intermediate commit still gets pushed.
- Conventional commit messages via `/commit`.

## Verifying the push next turn

The branch exists on the remote when this query returns a target:

```graphql
query BranchOnRemote($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) {
      target {
        oid
      }
    }
  }
}
```

(`$ref` = `refs/heads/<branch>`.) Compare the returned `oid` with `git rev-parse HEAD`. If the branch is missing or stale, the previous push was refused; the worker output names the reason (`refusing to push …`). Fix the cause (wrong branch, non-fast-forward history) and end the turn again.

## Rules

- Never `git push`, never add credentials, never edit `origin`.
- Never `--force`, `--force-with-lease`, rebase, amend, or reset commits that may already be on the remote.
- Never push to `main`; the assigned branch is the only publication target.
