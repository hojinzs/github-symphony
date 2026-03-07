## Why

The current control plane depends on a manually supplied GitHub token or pre-seeded GitHub App environment variables before a user can create a workspace or submit work. That blocks self-serve first-run setup and makes the initial experience brittle for operators who expect the product to bootstrap its own GitHub integration through the UI.

## What Changes

- Add a first-run bootstrap flow that checks persisted system configuration on control-plane startup and routes unconfigured instances to a GitHub App integration setup experience.
- Add a GitHub App registration flow that uses GitHub's manifest and installation authorization flow to create or connect the app from the control-plane UI, then persist the returned app metadata and secrets in the config database.
- Replace manual per-form GitHub token entry for workspace and issue creation with app-backed credentials issued from the stored GitHub App configuration after setup is complete.
- Add runtime credential issuance and refresh boundaries so worker execution and control-plane GitHub API calls use short-lived installation tokens instead of a long-lived `GITHUB_APP_TOKEN` env value.
- Add setup state handling, validation, and operator-visible recovery paths for incomplete app registration, failed installation, and expired or revoked credentials.
- Update installation and onboarding documentation so `README` and self-hosting guidance describe the first-run GitHub App bootstrap flow instead of manual token and env-based setup.

## Capabilities

### New Capabilities
- `github-app-bootstrap`: Detect missing system GitHub integration config, guide the operator through first-run GitHub App registration and installation, and persist the resulting app metadata needed for ongoing token issuance.

### Modified Capabilities
- `workspace-control-plane`: Workspace creation requirements change from manual token entry to gated app-backed setup, including first-run redirects and setup-complete validation before provisioning.
- `issue-driven-agent-execution`: Issue creation and project interaction requirements change to use stored GitHub App credentials instead of per-request user-supplied PATs once bootstrap is complete.
- `isolated-symphony-runtime`: Runtime credential handling changes from static injected GitHub tokens to renewable installation-token issuance based on stored GitHub App configuration.

## Impact

- Affects the control-plane Prisma schema, startup routing, setup UI, GitHub auth flows, and secret persistence model.
- Changes GitHub API integration from direct token passthrough to app metadata storage plus on-demand installation token exchange.
- Requires worker/runtime changes so long-lived workspaces can continue operating after installation tokens expire.
- Adds new failure and recovery paths for bootstrap state, revoked app installations, and credential refresh errors.
- Requires documentation updates in the top-level installation path and self-hosting setup guides.
