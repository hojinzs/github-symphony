## ADDED Requirements

### Requirement: Control plane SHALL expose the GitHub App installation repository inventory for workspace selection
The system SHALL provide a control-plane API that uses the configured GitHub App installation credentials to list the repositories currently accessible to that installation and SHALL return canonical repository metadata suitable for workspace allowlist selection.

#### Scenario: Repository inventory is available after bootstrap
- **WHEN** the operator opens the workspace creation flow after GitHub App bootstrap is complete
- **THEN** the control plane can return the repositories accessible to the configured GitHub App installation
- **THEN** each repository entry includes canonical owner, repository name, and clone URL values from GitHub

#### Scenario: GitHub integration is not ready
- **WHEN** the operator requests the installation repository inventory before GitHub App bootstrap is complete or while the integration is degraded
- **THEN** the control plane rejects the request with a setup or recovery error
- **THEN** it does not return partial repository data

### Requirement: Workspace creation SHALL validate selected repositories against the current installation inventory
The system SHALL verify that each repository submitted for a new workspace still belongs to the current GitHub App installation scope before persisting the workspace and SHALL reject stale or invalid selections.

#### Scenario: Selected repositories remain authorized
- **WHEN** the operator submits a workspace creation request with repositories selected from the current installation inventory
- **THEN** the control plane accepts the selection
- **THEN** it persists the canonical owner, name, and clone URL values for each selected repository

#### Scenario: Repository selection becomes stale before submission
- **WHEN** a repository was previously shown in the picker but is no longer accessible to the GitHub App installation when the workspace creation request is submitted
- **THEN** the control plane rejects the request with a validation error describing that the repository selection is no longer valid
- **THEN** no workspace, project, or runtime is created
