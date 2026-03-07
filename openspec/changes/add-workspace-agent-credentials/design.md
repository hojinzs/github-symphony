## Context

The control plane already owns GitHub integration state, encrypts GitHub App secrets at rest, and brokers renewable GitHub credentials to long-lived worker runtimes. Agent authentication is the missing half of the runtime contract: `codex app-server` is launched as a subprocess inside the worker, but the platform has no first-class way to tell that subprocess which service identity to use.

Today an operator would have to solve agent authentication outside the product by mounting host credentials or injecting unmanaged environment variables into worker containers. That breaks the product boundary, makes workspace isolation weaker than the GitHub side, and prevents operators from choosing whether a workspace should inherit a platform-wide agent identity or use its own isolated budget and permissions.

This design must fit the existing trusted-operator deployment model, preserve the `codex app-server` subprocess contract, and avoid introducing a full end-user auth system or browser-driven OAuth lifecycle. It also needs to account for an important runtime constraint: unlike `github_graphql`, Codex authentication has to be available before the agent process starts, so the runtime must resolve agent credentials before spawning `codex app-server`.

## Goals / Non-Goals

**Goals:**
- Let operators register service credentials that can authenticate agent runtime execution without touching worker hosts manually.
- Support both a platform default credential and a workspace-specific override.
- Deliver agent credentials to the worker only at execution time through a control-plane broker path.
- Keep stored secrets encrypted at rest and out of workflow files, repository checkouts, and long-lived container environment where possible.
- Surface validation, degraded-state, and rotation workflows so operators can recover from invalid or revoked credentials.

**Non-Goals:**
- Adding a full per-user authentication and authorization model to the control plane.
- Supporting browser-based Codex/OpenAI OAuth as the primary runtime authentication model.
- Replacing the existing GitHub App bootstrap flow or changing GitHub runtime brokering behavior beyond shared implementation pieces.
- Supporting multiple agent providers in the initial release beyond a single OpenAI-compatible service credential shape.

## Decisions

### 1. Model agent credentials as first-class control-plane resources

The control plane will add a new persisted agent credential resource with encrypted secret material, provider type, operator-facing label, fingerprint, validation status, timestamps, and degraded reason. Workspaces will store whether they inherit the platform default credential or reference a specific override credential, and the control plane will store a singleton pointer to the current platform default.

Rationale: the workspace needs a stable binding to an operator-managed credential object, not raw secret material copied into the workspace row. The main alternative was storing a raw API key directly on each workspace, but that duplicates secrets, makes rotation expensive, and weakens auditability.

### 2. Start with one credential type but keep the model extensible

The first implementation will support one service credential type for agent runtime execution: an OpenAI-compatible API key that can be translated into the environment contract expected by `codex app-server`, such as `OPENAI_API_KEY`. The schema and broker response will still include provider and environment payload metadata so future credential types can be added without redesigning workspace binding.

Rationale: the runtime needs a concrete auth contract now, and API-key service credentials match the current trusted-operator model better than browser OAuth. The alternative was designing a provider-agnostic abstraction before any concrete implementation, but that would add shape without reducing current uncertainty.

### 3. Resolve agent credentials before spawning `codex app-server`

The worker runtime will gain an agent credential resolution step that runs before `buildCodexRuntimePlan` or `launchCodexAppServer` finalize the environment. The worker will authenticate to a new workspace-scoped control-plane broker endpoint by using the same derived runtime secret pattern already used for GitHub token refresh. The broker response will contain the environment variables required to launch the agent, optional cache metadata, and enough status information for the worker to degrade cleanly when credentials are unavailable.

Rationale: `codex app-server` cannot fetch its own credentials after startup if the process itself needs those credentials to start. The alternative was mounting persistent Codex configuration into the worker container, but that would move secret lifecycle back out of the product and reintroduce host coupling.

### 4. Reuse a shared secret-protection and runtime-auth foundation

The implementation will generalize the current GitHub secret protection utilities into a platform secret-protection layer that can encrypt both GitHub App secrets and agent service credentials. The existing workspace-derived runtime authentication secret mechanism will also be reused for the new agent credential broker route so worker-to-control-plane authentication stays consistent.

Rationale: the platform already has a working encryption and runtime-auth pattern, and duplicating it for agent secrets would create parallel security code paths. The alternative was creating a second unrelated secret key and broker auth mechanism for agent credentials, but that would increase operator and code complexity without improving isolation.

### 5. Put credential selection in workspace provisioning, not in issue execution

Workspace creation and management will become the place where the operator chooses `platform default` or `workspace override`. Issue creation and runtime execution will consume that binding as immutable workspace metadata for a given run. Workspace provisioning will be blocked if the chosen credential source cannot produce a valid runtime credential.

Rationale: the workspace is already the isolation boundary for project, repositories, runtime container, and prompt guidance. The alternative was choosing credentials per issue or per run, but that would complicate operator mental models and make runtime behavior less predictable.

### 6. Validate on write and degrade on runtime failure

When an operator creates or rotates an agent credential, the control plane will perform a lightweight validation step against the target provider before marking the credential ready. Runtime broker failures will mark the affected credential or workspace runtime degraded and block new agent runs until recovery. Secret values will never be returned to the UI after initial submission.

Rationale: the platform should fail early on obviously invalid credentials while still treating revocation and provider-side failures as recoverable operational states. The alternative was deferring all validation to runtime launch, but that would make workspace creation appear successful while guaranteeing later execution failure.

## Risks / Trade-offs

- [Agent API keys are still long-lived provider secrets] -> Mitigation: encrypt at rest, disclose only through authenticated broker calls, avoid writing them to workflow files or repo checkouts, and support rotation.
- [Pre-launch broker resolution adds another control-plane dependency to runtime startup] -> Mitigation: keep the broker endpoint narrow, allow short in-worker caching for repeated launches, and mark runtimes degraded with explicit recovery states.
- [Generalizing the secret-protection layer touches existing GitHub secret code] -> Mitigation: preserve backward compatibility for current environment keys and migrate behind tests that cover both GitHub and agent secret paths.
- [Workspace default vs override adds more UI complexity] -> Mitigation: default to the platform credential, expose override only when needed, and show the effective credential source clearly on create and detail screens.
- [Future providers may not fit the initial API-key contract] -> Mitigation: store provider metadata and brokered env payload shape in a way that can be extended without changing workspace binding semantics.

## Migration Plan

1. Add the Prisma schema changes for agent credentials, workspace credential binding, and any singleton default-config record required for platform defaults.
2. Refactor the current GitHub secret protection helpers into a shared platform secret-protection utility with compatibility for existing encrypted GitHub data.
3. Add control-plane APIs and UI for creating, validating, listing, rotating, and selecting agent credentials, including workspace create-form updates.
4. Add the workspace-scoped agent credential broker endpoint and worker runtime code that resolves brokered agent environment before launching `codex app-server`.
5. Update runtime provisioning metadata and tests so worker containers receive the broker URL and runtime auth information required for agent credential lookup.
6. Roll out with no workspace breaking change by requiring operators to configure a platform default credential before creating new workspaces; existing workspaces can remain blocked from new runs until bound to a valid credential.

Rollback strategy: disable the new credential-aware workspace validation and runtime preflight, fall back to the previous host-managed worker auth approach for agent startup, and retain stored credential records for future re-enable rather than deleting them.

## Open Questions

- Should the broker return a simple env map such as `OPENAI_API_KEY`, or a richer provider contract that a runtime wrapper translates into env before launch?
- Should the platform allow existing workspaces to inherit the platform default automatically during migration, or force an explicit operator review before enabling new runs?
- Do we want a dedicated `PLATFORM_SECRETS_KEY` environment variable now, or should the first implementation continue using the existing GitHub secret key as the underlying encryption material?
