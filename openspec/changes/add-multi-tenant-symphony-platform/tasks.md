## 1. Symphony runtime foundation

- [ ] 1.1 Implement the GitHub tracker adapter read flow needed for Symphony workers to discover actionable issues from a dedicated GitHub Project.
- [ ] 1.2 Add runtime support for launching `codex app-server` and injecting the `github_graphql` tool into the worker execution environment.
- [ ] 1.3 Add and validate the `hooks.after_create` workflow that clones the task's target repository only when it belongs to the workspace allowlist.
- [ ] 1.4 Add unit and integration coverage for workspace path isolation, scheduling/retry behavior, tracker reads, and hook-driven repository preparation.

## 2. Control-plane backend and provisioning

- [ ] 2.1 Add the Prisma/PostgreSQL schema for `Workspace`, linked repositories, credentials references, and `SymphonyInstance` runtime metadata.
- [ ] 2.2 Implement GitHub authentication handling and the control-plane API for creating a workspace with prompt guidelines and repository selections.
- [ ] 2.3 Implement GitHub Project scaffolding and issue/project association flows through the GitHub GraphQL API.
- [ ] 2.4 Implement the Dockerode-based provisioning module that generates per-workspace workflow artifacts, launches a dedicated Symphony container, and persists container mapping data.
- [ ] 2.5 Add reconciliation and lifecycle operations for provisioning failures, restart/status sync, and container teardown.

## 3. Workspace UX and issue submission

- [ ] 3.1 Build the Next.js UI for workspace creation, including repository multi-select and prompt-guideline authoring.
- [ ] 3.2 Build the issue creation flow that lets a user target one of the repositories linked to a workspace and submit the work item to GitHub.
- [ ] 3.3 Build the dashboard view that polls active worker `/api/v1/state` endpoints in parallel and renders workspace/runtime health.

## 4. End-to-end verification and rollout

- [ ] 4.1 Add conformance tests for core Symphony behavior, including workflow parsing, path isolation, and retry/backoff semantics.
- [ ] 4.2 Add integration tests for control-plane provisioning, GitHub API mediation, and runtime state aggregation.
- [ ] 4.3 Add end-to-end coverage for GitHub auth, workspace creation, issue submission, agent execution, and automatic transition of completed work to `Done`.
- [ ] 4.4 Document rollout and operational checks for enabling the platform behind an internal feature flag.
