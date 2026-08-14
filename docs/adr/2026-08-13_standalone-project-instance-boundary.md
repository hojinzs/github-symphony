# ADR: Standalone Project Instance Boundary

- **Date**: 2026-08-13
- **Status**: Accepted
- **Supersedes**: [`2026-05-04_single-repo-orchestrator.md`](./2026-05-04_single-repo-orchestrator.md)
- **Related Spec**: `docs/symphony-spec.md` §3.1, §5.1

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

## Consequences

- Operators can run independent workflows for one repository without mutating
  the repository itself.
- Disjoint tracker mappings and branch namespaces prevent competing project
  dispatches and branch collisions.
- This is a repository-local extension: the upstream single-workflow model is
  preserved inside each project instance. It does not modify the upstream spec.
