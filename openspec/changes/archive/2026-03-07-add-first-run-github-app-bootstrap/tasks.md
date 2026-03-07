## 1. System config and bootstrap state

- [x] 1.1 Add Prisma models and enums for singleton GitHub integration state, bootstrap attempts, installation metadata, and encrypted secret fields.
- [x] 1.2 Implement control-plane persistence and validation helpers that load the singleton GitHub integration, classify it as `unconfigured`, `pending`, `ready`, or `degraded`, and expose recovery-safe reads.
- [x] 1.3 Add secret-protection utilities and tests for storing and retrieving GitHub App secret material without relying on `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, or `GITHUB_APP_TOKEN` env values.

## 2. First-run GitHub App setup flow

- [x] 2.1 Implement setup routes for manifest generation, callback handling, manifest conversion exchange, installation completion, and bootstrap retry state cleanup.
- [x] 2.2 Build the first-run setup UI and degraded-state recovery screens that guide the operator through GitHub App registration, installation, and reconnect flows.
- [x] 2.3 Add startup and page-gating logic that redirects workspace and issue creation flows to setup whenever the GitHub integration is missing, incomplete, or degraded.

## 3. Control-plane GitHub credential migration

- [x] 3.1 Implement a GitHub App credential broker that mints installation tokens on demand, validates installation health, and caches tokens within safe expiry windows.
- [x] 3.2 Refactor workspace provisioning, GitHub Project creation, and issue creation services to use broker-issued installation tokens instead of request-scoped bearer tokens.
- [x] 3.3 Remove manual GitHub token inputs from the workspace and issue forms and update API handlers to operate in trusted-operator mode after bootstrap is complete.

## 4. Runtime credential refresh

- [x] 4.1 Define and implement a workspace-scoped runtime credential refresh contract so workers can request short-lived installation tokens without receiving the app private key.
- [x] 4.2 Update workspace provisioning, worker runtime launch, and the `github_graphql` tool path to consume renewable installation credentials instead of a static `GITHUB_TOKEN` or `GITHUB_GRAPHQL_TOKEN` env value.
- [x] 4.3 Add failure handling that marks workspaces or the system integration degraded when runtime credential refresh fails because the installation is revoked or invalid.

## 5. Verification and rollout documentation

- [x] 5.1 Add unit and integration coverage for setup-state evaluation, manifest/install callbacks, token brokering, and degraded-state recovery.
- [x] 5.2 Add end-to-end coverage for first boot redirect, successful GitHub App bootstrap, workspace creation without manual token entry, and issue submission after setup.
- [x] 5.3 Update `README`, self-hosting, and local-development documentation to describe the first-run GitHub App bootstrap flow, required non-GitHub secrets, and operator recovery steps.
