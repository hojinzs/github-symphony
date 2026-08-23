# ADR: Standalone Project Instance Boundary

- **Date**: 2026-08-13
- **Status**: Accepted
- **Supersedes**: [`2026-05-04_single-repo-orchestrator.md`](./2026-05-04_single-repo-orchestrator.md)
- **Related Spec**: `docs/symphony-spec.md` §3.1, §5.1, §9.1

## Context

The earlier single-repository ADR described the runtime boundary as “1 repo =
1 instance”. Standalone project folders now own independent policy, tracker
mapping, credentials, skills, MCP configuration, and runtime state while they
may reference the same repository.

## Decision

The orchestration instance boundary is **1 project = 1 instance**. A project
owns its `WORKFLOW.md`, optional `.mcp.json`, `.env`, and `.agent/skills/`.
Projects may share a repository only when their tracker mappings are disjoint.
They share one repository-scoped bare cache; project slugs namespace populated
worktree branches as `symphony/<project-slug>/<sanitized-issue-id>`.

Every project mode uses `workspaceDir` as the normalized `workspace.root` and
stores each checkout at `<workspaceDir>/<sanitized-issue-identifier>`, as
required by spec §9.1. Repo-embedded projects separately persist
`repositoryDir` for the source checkout and daemon working directory.
Standalone projects already keep those concepts separate through `projectDir`.

Workspace records remain in the orchestrator state directory in both modes;
only the populated workspace moves to `workspace.root`. This keeps operational
records, run history, and locks together without making the configured
workspace directory part of the control-plane state layout.

## Consequences

- Operators can run independent workflows for one repository without mutating
  the repository itself.
- Disjoint tracker mappings and branch namespaces prevent competing project
  dispatches and branch collisions.
- `workspace.root` has the same meaning in repo-embedded and standalone modes;
  runtime-state filenames no longer reserve ordinary issue workspace keys.
- Repo-embedded installations created before this decision retain their legacy
  layout until `repo init` writes the split paths. Operators use the documented
  stop/archive/reinitialize procedure when they want to discard orphaned
  worktrees and their shared-cache administration safely.
- This is a repository-local extension: the upstream single-workflow model is
  preserved inside each project instance. It does not modify the upstream spec.
