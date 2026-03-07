## 1. Repository bootstrap

- [x] 1.1 Create the monorepo foundation for the control plane, worker runtime, and shared packages, including workspace tooling and root scripts.
- [x] 1.2 Bootstrap the Next.js control-plane app, worker package, shared TypeScript configuration, and environment templates.
- [x] 1.3 Add baseline developer tooling for linting, testing, formatting, and local orchestration documentation so later tasks have a stable foundation.

## 2. Symphony runtime foundation

- [x] 2.1 Implement the GitHub tracker adapter read flow needed for Symphony workers to discover actionable issues from a dedicated GitHub Project.
- [x] 2.2 Add runtime support for launching `codex app-server` and injecting the `github_graphql` tool into the worker execution environment.
- [x] 2.3 Add and validate the `hooks.after_create` workflow that clones the task's target repository only when it belongs to the workspace allowlist.
- [x] 2.4 Add unit and integration coverage for workspace path isolation, scheduling/retry behavior, tracker reads, and hook-driven repository preparation.

## 3. Control-plane backend and provisioning

- [x] 3.1 Add the Prisma/PostgreSQL schema for `Workspace`, linked repositories, credentials references, and `SymphonyInstance` runtime metadata.
- [x] 3.2 Implement GitHub authentication handling and the control-plane API for creating a workspace with prompt guidelines and repository selections.
- [x] 3.3 Implement GitHub Project scaffolding and issue/project association flows through the GitHub GraphQL API.
- [x] 3.4 Implement the Dockerode-based provisioning module that generates per-workspace workflow artifacts, launches a dedicated Symphony container, and persists container mapping data.
- [x] 3.5 Add reconciliation and lifecycle operations for provisioning failures, restart/status sync, and container teardown.

## 4. Workspace UX and issue submission

- [x] 4.1 Build the Next.js UI for workspace creation, including repository multi-select and prompt-guideline authoring.
- [x] 4.2 Build the issue creation flow that lets a user target one of the repositories linked to a workspace and submit the work item to GitHub.
- [x] 4.3 Build the dashboard view that polls active worker `/api/v1/state` endpoints in parallel and renders workspace/runtime health.

## 5. End-to-end verification and rollout

- [x] 5.1 Add conformance tests for core Symphony behavior, including workflow parsing, path isolation, and retry/backoff semantics.
- [x] 5.2 Add integration tests for control-plane provisioning, GitHub API mediation, and runtime state aggregation.
- [x] 5.3 Add end-to-end coverage for GitHub auth, workspace creation, issue submission, agent execution, and automatic transition of completed work to `Done`.
- [x] 5.4 Document rollout and operational checks for enabling the platform behind an internal feature flag.
