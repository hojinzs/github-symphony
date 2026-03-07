## Why

The platform can broker GitHub credentials for control-plane and worker operations, but it still assumes `codex app-server` authentication exists outside the product. That makes self-hosted setup incomplete, prevents workspace-level isolation of agent identity or spend, and forces operators to manage Codex credentials directly on worker hosts.

## What Changes

- Add control-plane support for registering and storing agent service credentials that can be used to authenticate `codex app-server` without relying on host-mounted personal logins.
- Add a platform default vs workspace-specific credential model so operators can share one agent credential across workspaces or isolate specific workspaces onto their own credential.
- Add runtime brokering for agent credentials so worker containers receive only execution-time credential material or environment values and do not persist long-lived agent secrets in workflow files or repository checkouts.
- Add validation, degraded-state handling, and rotation workflows for agent credentials so invalid, revoked, or removed credentials block new runs with operator-visible recovery paths.
- Update workspace creation and management flows to let operators choose the credential source for a workspace and understand whether the workspace is inheriting a platform default or using its own override.

## Capabilities

### New Capabilities
- `agent-service-credentials`: Register, validate, encrypt, broker, rotate, and revoke service credentials used to authenticate agent runtime execution.

### Modified Capabilities
- `workspace-control-plane`: Workspace provisioning requirements change to include selecting an agent credential source and persisting the workspace-to-credential binding needed for runtime execution.
- `isolated-symphony-runtime`: Runtime requirements change so `codex app-server` authentication is delivered through a control-plane broker instead of assuming host-level Codex login state or unmanaged environment injection.

## Impact

- Affects the control-plane Prisma schema, workspace creation UI, workspace management APIs, and secret persistence model.
- Adds an agent credential broker path parallel to the existing GitHub installation-token broker.
- Changes worker startup and runtime environment assembly so agent authentication can be resolved per workspace at execution time.
- Requires new operator-facing validation and recovery behavior for missing, invalid, rotated, or revoked agent credentials.
- Keeps GitHub App bootstrap unchanged while extending the trusted-operator control plane to manage non-GitHub runtime credentials as first-class platform state.
