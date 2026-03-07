## Context

The target product extends Symphony from a single-project orchestration spec into a multi-tenant platform where each customer workspace maps to one GitHub Project and one isolated Symphony worker container. The control plane owns all user interaction and provisioning side effects, while the Symphony runtime remains a read-only orchestrator over tracker state and filesystem state. This split is necessary to preserve the Symphony philosophy from `SPEC.md` while still giving users a practical UI for creating workspaces and authoring work.

The repository is currently at proposal stage, so this design defines the initial architecture, data boundaries, and rollout order. The design must support multiple repositories per workspace, dynamic runtime cloning, and agent-side tracker mutations through `github_graphql`, not backend-side orchestration writes.

## Goals / Non-Goals

**Goals:**
- Provide a control plane that lets users connect GitHub, create workspaces, select multiple repositories, and submit work items without editing tracker state manually.
- Provision one isolated Symphony container per workspace, with deterministic mapping between workspace metadata, GitHub Project, and runtime container identity.
- Preserve the Symphony execution contract by launching `codex app-server` as a subprocess and keeping orchestration logic tracker-read-only.
- Support multi-repo execution by cloning the repository referenced by each issue at runtime through hooks instead of pre-baking repositories into container images.
- Define a phased implementation path with conformance, integration, and end-to-end verification.

**Non-Goals:**
- Adding a persistent database to the Symphony core runtime.
- Introducing alternative agent protocols or runtimes beyond `codex app-server` for MVP.
- Moving issue state mutation or comment-writing logic into the orchestration backend.
- Designing billing, quota enforcement, or enterprise admin features in this change.

## Decisions

### 1. Use a three-plane architecture with explicit ownership boundaries

The system will be split into a control plane, execution plane, and integration layer.

- The control plane is a Next.js application backed by Prisma and PostgreSQL. It handles user authentication, workspace lifecycle, GitHub Project scaffolding, issue creation, and status aggregation.
- The execution plane is a fleet of stateless Symphony containers. Each container watches one GitHub Project, prepares a workspace, and launches `codex app-server`.
- The integration layer is the contract between Symphony and GitHub: tracker reads come from the GitHub adapter, tracker writes happen through the agent's `github_graphql` tool, and repository setup happens via `hooks.after_create`.

Rationale: This keeps user-facing complexity and mutable product state out of the Symphony core, which matches the base spec. The main alternative was embedding provisioning and GitHub writes into the orchestration service, but that would couple the runtime to product-specific state transitions and erode the read-only orchestration model.

### 2. Model workspace and runtime lifecycle in the control-plane database

The control plane will persist `Workspace` and `SymphonyInstance` records. `Workspace` stores tenancy-level configuration such as name, GitHub owner context, prompt guidelines, linked repositories, and GitHub Project identifiers. `SymphonyInstance` stores runtime metadata such as container ID, exposed port, workflow path, status, and last heartbeat.

Rationale: Product state such as which container belongs to which workspace does not belong in Symphony core. The alternative was deriving runtime state only from Docker labels and GitHub metadata, but that would complicate dashboard queries, retry flows, and auditing.

### 3. Generate per-workspace workflow artifacts at provision time

When a workspace is created, the control plane will generate the minimal `WORKFLOW.md`, environment variables, hook scripts, and container launch parameters needed for that workspace. Those artifacts will be mounted into the worker container instead of maintaining a single static workflow for all tenants.

Rationale: Workspace-specific GitHub Project IDs, repository allowlists, and prompt guidelines must be isolated and reproducible. The alternative was a global workflow template plus runtime branching logic inside Symphony, but that would make tenancy boundaries implicit and harder to audit.

### 4. Use hook-driven repository preparation for multi-repo support

The runtime will use an `after_create` hook to inspect tracker metadata, determine the target repository clone URL, and clone only the needed repository into the ephemeral workspace. The hook will fail fast if the issue references a repository outside the workspace allowlist.

Rationale: This matches the Symphony extension model and keeps the execution image generic. The alternative was pre-cloning all repositories into each workspace container, which would increase startup cost, storage use, and cross-repository exposure.

### 5. Keep tracker writes agent-driven through `github_graphql`

The control plane will create GitHub issues and scaffold GitHub Projects, but once an issue is in the execution flow, the orchestration backend remains read-only. The runtime injects a `github_graphql` tool so the agent can move cards to `Done` and perform any needed tracker mutation directly against GitHub.

Rationale: This preserves the base Symphony contract and makes completion behavior part of agent execution, not hidden backend automation. The alternative was letting the worker service update GitHub status directly after command completion, but that would violate the design constraint in the PRD and blur ownership.

### 6. Poll worker state through container-local APIs and aggregate in the dashboard

Each worker container will expose its Symphony state endpoint, and the control plane dashboard will poll the mapped `/api/v1/state` endpoints in parallel for all active workspaces. The control plane will combine that live state with persisted metadata from PostgreSQL.

Rationale: This provides near-real-time visibility without making the runtime stateful. The alternative was pushing worker events into the database, but that would require additional streaming or synchronization infrastructure before the core workflow is stable.

## Risks / Trade-offs

- [Docker daemon coupling] -> The control plane depends on local or remote Docker daemon availability. Mitigation: isolate provisioning logic behind a module interface and persist failure states for retryable recovery.
- [GitHub API rate limits and permission variance] -> OAuth/PAT scopes may differ across users and organizations. Mitigation: validate required scopes during workspace creation and surface actionable setup errors before provisioning.
- [Cross-repository data leakage] -> Multi-repo dynamic clone is a security boundary. Mitigation: enforce a workspace repository allowlist in both control-plane issue creation and runtime hook validation.
- [Container sprawl] -> One workspace per container increases operational overhead. Mitigation: keep workers stateless, expose health metadata, and add lifecycle operations for suspend/restart/delete.
- [State drift between DB, Docker, and GitHub] -> Provisioning may partially succeed. Mitigation: use explicit status transitions, idempotent reconciliation jobs, and rollback of partially created resources where possible.

## Migration Plan

1. Establish the Symphony runtime extensions in a single-workspace development environment: GitHub tracker reads, `github_graphql` tool injection, and hook-based cloning.
2. Add the control-plane data model and provisioning module, then prove workspace creation can create a GitHub Project and launch an isolated worker.
3. Add UI flows for workspace creation, issue submission, and aggregated status viewing.
4. Add conformance, integration, and end-to-end test coverage before broadening rollout.
5. Roll out behind an internal feature flag until container lifecycle stability and GitHub permission handling are verified.

Rollback strategy: disable new workspace provisioning in the control plane, stop affected worker containers, and preserve database records plus GitHub Projects for investigation. Because Symphony workers are stateless, rollback focuses on the control-plane release and runtime image version rather than data migration reversal.

## Open Questions

- Should GitHub authentication for MVP be OAuth only, PAT only, or allow both with a normalized credential abstraction?
- Will workspace-level prompt guidelines be stored verbatim in generated workflow artifacts or transformed into a stricter template before runtime injection?
- How should the control plane reconcile orphaned GitHub Projects or containers if provisioning fails after external resource creation?
