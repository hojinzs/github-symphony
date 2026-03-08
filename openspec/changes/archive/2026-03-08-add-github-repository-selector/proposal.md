## Why

The workspace allowlist flow currently depends on operators manually typing `owner`, `name`, and `cloneUrl`, which makes workspace creation fragile and hard to debug. The control plane already holds GitHub App installation credentials, so it should use that installation scope to show the repositories the app can actually access and let operators select from that list.

## What Changes

- Add a control-plane capability to fetch the repositories available to the configured GitHub App installation by using brokered installation credentials.
- Replace freeform repository allowlist entry in workspace creation with a selection flow backed by the installation repository inventory.
- Validate submitted repository selections against the current GitHub App installation scope before persisting the workspace.
- Persist canonical repository metadata returned by GitHub into the existing workspace repository records so runtime allowlist checks use normalized clone URLs.

## Capabilities

### New Capabilities
- `github-installation-repository-selection`: Discover repositories available to the installed GitHub App and expose them for workspace allowlist selection.

### Modified Capabilities
- `workspace-control-plane`: Workspace provisioning changes from manual repository entry to selecting one or more repositories from the GitHub App installation inventory.

## Impact

- Affected code: workspace creation UI, workspace creation API, GitHub installation broker helpers, and provisioning tests.
- Affected systems: control-plane GitHub API integration and runtime allowlist inputs.
- Dependencies: existing GitHub App installation token flow; no new external services are required.
