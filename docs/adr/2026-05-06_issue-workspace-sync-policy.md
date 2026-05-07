# ADR: Issue Workspace Repository Sync Policy

## Status

Accepted

## Context

Symphony requires deterministic per-issue workspaces to be reused and preserved
across runs. In this implementation, issue workspaces contain a `repository/`
checkout used as the coding-agent working directory. Failed or interrupted agent
runs can leave that checkout dirty, and that dirty state is recovery context.

The workflow cache clone is different: it is an implementation cache used to
load repository policy and can be rebuilt if a pull fails.

## Decision

Repository synchronization uses two policies:

- Workflow-cache clones may be destructively recloned after `git pull --ff-only`
  fails.
- Persisted issue workspaces are synchronized non-destructively. Existing
  `repository/` checkouts are checked for local changes before pulling. If the
  checkout is dirty, or if a clean checkout cannot be fast-forwarded, the
  workspace is preserved and run preparation fails with an explicit recovery
  error.
- If a persisted workspace record exists but `repository/` is missing entirely,
  the orchestrator creates a fresh clone in that path. This is not treated as
  destructive because there is no checkout state at `repository/` to preserve.
- If `repository/` exists but is not a git checkout, the directory is preserved
  and run preparation fails. Operators or hooks must decide whether that debris
  is recoverable before retrying.

New issue workspaces may still remove partial clone debris during first
creation, because no prior issue workspace state exists to preserve.

## Consequences

Retries no longer silently discard uncommitted agent work from per-issue
workspaces. Operators or configured recovery hooks must resolve local changes or
divergence before another run can reuse that workspace.

This aligns the implementation with `docs/symphony-spec.md` workspace reuse and
population-failure guidance without changing the upstream specification.
