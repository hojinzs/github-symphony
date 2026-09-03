---
name: push
description: Publish the assigned branch through the authenticated host action and verify its concrete result.
license: MIT
metadata:
  author: gh-symphony
  version: "3.0"
  generatedBy: gh-symphony
---

# /push — Host-owned Branch Publication

## Trigger

Use this skill after committing work that must become visible on the assigned
remote branch, including before creating or refreshing a pull request.

## Flow

1. Run the relevant tests and confirm the worktree is clean.
2. Confirm `git branch --show-current` equals `$SYMPHONY_ASSIGNED_BRANCH`.
3. Request publication from the authenticated host:

   ```bash
   curl --fail-with-body --silent --show-error \
     -X POST "$SYMPHONY_ORCHESTRATOR_URL/api/v1/assigned-branch/publish" \
     -H "X-Symphony-Run-Id: $SYMPHONY_RUN_ID" \
     -H "X-Symphony-Orchestrator-Token: $SYMPHONY_ORCHESTRATOR_TOKEN"
   ```

4. Require `ok: true`, `outcome: published`, and the expected branch/head in
   the response before relying on the remote ref.
5. A missing remote ref alone is not a blocker and must never trigger a
   turn-count escalation. If publication was not requested yet, request it; if
   the action fails, record its concrete error.

## Host guarantees

- The host alone holds Git credentials.
- The host verifies the assigned branch, refuses non-fast-forward publication,
  disables repository hooks, and reports tracked or untracked work left
  unpublished.
- Repeating the action at the same HEAD is safe and idempotent.
- The worker also publishes at session exit as a backstop, including abnormal
  exits.

## Rules

- Never run `git push`, add credentials, or edit `origin` from the agent child.
- Never rebase, amend, reset, or force-rewrite commits that may already be
  remote.
- Never publish `main`; the assigned branch is the only publication target.
