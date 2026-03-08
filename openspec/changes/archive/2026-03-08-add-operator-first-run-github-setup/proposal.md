## Why

The current first-run flow assumes any browser session can reach setup and provisioning screens once the control plane is available, which leaves operator identity undefined and makes the personal-account GitHub App authorization step feel bolted on. We need a single startup story that begins with authenticated operator access, then guides GitHub App bootstrap, personal-owner authorization when required, and only then opens workspace creation.

## What Changes

- Add an operator authentication flow for the control plane based on GitHub OAuth before setup, workspace provisioning, or issue creation can be used.
- Extend the first-run GitHub App setup experience so it explicitly sequences bootstrap, installation, and personal-account user authorization when the installation target is a GitHub user instead of an organization.
- Update workspace provisioning requirements so personal-account installs remain blocked until the required GitHub user authorization is complete, while organization installs proceed without the extra step.
- Clarify setup and recovery UX so operators can see which prerequisite is missing: sign-in, app bootstrap, app installation, or personal-owner authorization.

## Capabilities

### New Capabilities
- `control-plane-operator-authentication`: Authenticate trusted operators with GitHub OAuth and gate privileged control-plane flows on an active operator session.

### Modified Capabilities
- `github-app-bootstrap`: Expand first-run setup requirements to include authenticated access and a personal-owner authorization branch after GitHub App installation.
- `workspace-control-plane`: Change provisioning requirements so workspace creation depends on both GitHub App readiness and, for personal-account installs, a completed GitHub user authorization.

## Impact

- Affected code: control-plane entry routing, setup screens, authentication/session handling, GitHub setup callbacks, workspace provisioning orchestration, and related runtime credential brokering.
- Affected APIs: control-plane auth endpoints, GitHub setup callbacks, and any setup-status payloads consumed by the UI.
- Affected systems: GitHub OAuth for operator sign-in, GitHub App bootstrap/install flows, personal-owner project authorization, and workspace creation gating.
