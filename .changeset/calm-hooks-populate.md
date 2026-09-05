---
"@gh-symphony/cli": major
---

Move repository population out of the orchestrator and into the shipped default `after_create` hook, preserving fresh-workspace cleanup and non-destructive reuse (#901).

Before upgrading, configure `hooks.after_create` and enable trusted hooks with
`SYMPHONY_ALLOW_WORKFLOW_HOOKS=1`. The obsolete `cache status` and `cache prune`
commands are removed; existing linked-worktree workspaces still require their
legacy bare cache until those workspaces are removed and recreated.
