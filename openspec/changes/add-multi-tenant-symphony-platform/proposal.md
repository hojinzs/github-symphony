## Why

The current repository has no product-level implementation for turning the Symphony specification into a usable multi-tenant coding agent platform. We need a change that adds the control plane, isolated runtime provisioning, and issue-driven execution flow required to operate Symphony as a real product while preserving the spec's read-only orchestration model.

## What Changes

- Add a Next.js-based control plane for GitHub authentication, workspace creation, repository selection, issue authoring, and runtime observability.
- Add workspace provisioning that creates a dedicated GitHub Project and a dedicated Symphony Docker container per workspace, with persisted metadata for lifecycle management.
- Add a Symphony runtime contract that launches `codex app-server` as the agent subprocess, injects the `github_graphql` tool, and uses runtime hooks to clone the target repository dynamically.
- Add an issue execution flow where the control plane creates GitHub issues, Symphony reads tracker state, and the agent updates issue/project status through GitHub GraphQL instead of backend-side tracker writes.
- Add phased validation coverage for Symphony core conformance, control-plane integration, and end-to-end workspace execution.

## Capabilities

### New Capabilities
- `workspace-control-plane`: Manage GitHub-linked workspaces, project scaffolding, repository selection, container provisioning, and runtime status visibility.
- `isolated-symphony-runtime`: Run one Symphony worker container per workspace with isolated workflow configuration, `codex app-server` integration, and hook-based repository preparation.
- `issue-driven-agent-execution`: Create repository-targeted issues from the control plane and drive them through the Symphony tracker/agent lifecycle until the agent marks work complete.

### Modified Capabilities

None.

## Impact

- Adds product-level requirements for Next.js, Prisma, PostgreSQL, Dockerode, and Docker-based Symphony workers.
- Defines new API, persistence, and provisioning boundaries between the control plane and execution plane.
- Establishes the contract for GitHub OAuth/PAT usage, GitHub GraphQL project scaffolding, issue creation, and agent-driven status updates.
- Requires end-to-end validation for workspace creation, isolated execution, and automated issue completion.
