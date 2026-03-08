## Context

The current control plane is intentionally single-tenant and trusted-operator oriented, but it does not yet define how an operator proves identity before accessing setup, workspace provisioning, or issue submission. At the same time, the GitHub App bootstrap flow now has two distinct branches: organization installs can mint installation credentials immediately, while personal-account installs also need a GitHub user authorization before user-owned Projects can be created or mutated.

This change crosses authentication, setup routing, GitHub integration state, and provisioning behavior. It also introduces a second GitHub-managed credential path in addition to installation tokens, so the design needs to separate operator authentication from GitHub App lifecycle management clearly.

## Goals / Non-Goals

**Goals:**
- Require an authenticated trusted operator session before setup, workspace creation, or issue creation can proceed.
- Make first-run setup deterministic by sequencing operator sign-in, GitHub App bootstrap, installation, and personal-owner authorization explicitly.
- Persist enough setup state to tell the operator which prerequisite is missing and how to recover.
- Ensure project-scoped GitHub mutations use installation tokens for organization installs and user access tokens for personal-account installs.

**Non-Goals:**
- Introduce multi-user collaboration, team RBAC, or fine-grained per-route authorization policies.
- Replace the system GitHub App model with per-workspace GitHub app registrations.
- Redesign repository discovery, runtime orchestration, or agent credential management beyond the gating required by the new setup flow.

## Decisions

### Use a dedicated GitHub OAuth operator sign-in separate from the managed GitHub App

Operator login happens before the system GitHub App exists, so it cannot rely on the app registration that the setup flow creates. The control plane should therefore use a separately configured GitHub OAuth client for operator authentication and keep the managed GitHub App focused on provisioning and repository/project access.

Alternative considered: authenticate operators with the same GitHub App after bootstrap.
Why not: it creates a bootstrap deadlock because no app exists on first run, and it conflates operator identity with the app credentials the platform manages.

### Model setup as an explicit prerequisite state machine

The UI and routing should treat first-run readiness as a sequence of independent checks:
1. operator session exists
2. GitHub App credentials are registered
3. GitHub App installation is validated
4. personal-owner authorization exists when installation target type is `User`

Each step should have a specific recovery path and status indicator, rather than collapsing every failure into a generic degraded integration state.

Alternative considered: keep a single `ready/degraded/pending` bootstrap flag and infer the missing step in the UI.
Why not: personal-owner authorization introduces a second credential family with different expiry and recovery semantics, and operators need an explicit explanation of which step is blocking them.

### Reuse the existing persisted GitHub integration record for personal-owner authorization material

The existing singleton GitHub integration record already stores encrypted app secret material and installation metadata. The design should extend that record with encrypted user access token, refresh token, authorized user identity, and token expiry fields so the setup and provisioning flows can reason about one system-level GitHub integration state.

Alternative considered: add a separate table for operator-approved GitHub user tokens immediately.
Why not: the first implementation only supports one active system GitHub App and one active trusted-operator authorization for personal-owner installs, so a separate table adds indirection without addressing a current requirement.

### Route project mutations through a project-credential broker

Workspace project creation, project item mutations, and runtime GraphQL access should no longer assume installation credentials are always sufficient. Instead, the control plane should resolve a project credential at call time:
- organization install -> short-lived installation token
- personal-account install -> refreshed GitHub user access token

Alternative considered: switch only workspace project creation to a user token and leave the rest on installation tokens.
Why not: issue-to-project linking and runtime project mutations would still fail for personal-account installs, producing a partially working setup.

### Keep operator authorization coarse-grained in the first iteration

The first iteration should treat GitHub-authenticated operators as trusted administrators once they satisfy a configured login allowlist or equivalent single-instance policy. That keeps setup simple while leaving room for later RBAC expansion.

Alternative considered: implement role management and invitation flows immediately.
Why not: that broadens the change substantially and is not required to stabilize the first-run setup story.

## Risks / Trade-offs

- [Two GitHub auth models increase cognitive load] → Separate UI copy and status messaging for operator sign-in, GitHub App installation, and personal-owner authorization.
- [Stored user refresh tokens become a sensitive system secret] → Reuse encrypted secret storage, short-lived access tokens, and explicit re-authorization messaging when refresh fails or expires.
- [Operator auth can block recovery if OAuth config is wrong] → Add a dedicated auth readiness check and make the setup screen unreachable only after the sign-in precondition, with actionable configuration errors.
- [Single authorized operator token may not reflect future multi-operator needs] → Document the limitation and keep the persistence model evolvable toward a separate operator-token table later.

## Migration Plan

1. Add operator authentication configuration and session handling ahead of the existing setup routes.
2. Extend the GitHub integration schema to store personal-owner authorization metadata and token expiry information.
3. Update setup routing/UI to surface the new prerequisite order and add the user-authorization callback flow for personal installs.
4. Switch project credential resolution for provisioning, issue flows, and runtime GraphQL access to choose between installation and user tokens.
5. Roll back by disabling operator auth gating and ignoring personal-owner authorization fields; existing GitHub App bootstrap data remains compatible.

## Open Questions

- Should the first operator-auth implementation support a static allowlist of GitHub logins, a single required login, or “any GitHub user who can reach the deployment”?
- Do we want operator sessions backed by signed cookies only, or should we persist session records for auditability and revocation?
- Should the setup UI expose token expiry timing for personal-owner authorization, or is a simple authorized / re-authorize state sufficient for the first release?
