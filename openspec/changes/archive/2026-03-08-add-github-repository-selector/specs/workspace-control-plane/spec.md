## MODIFIED Requirements

### Requirement: Users can provision a workspace from the control plane
The system SHALL allow a trusted operator to create a workspace by providing a workspace name, prompt guidelines, selecting one or more repositories from the repositories currently authorized for the configured GitHub App installation, and choosing an agent credential source after GitHub App bootstrap is complete, and SHALL provision the GitHub Project and Symphony runtime resources needed for that workspace by using app-backed GitHub credentials and the selected effective agent credential managed by the control plane.

#### Scenario: Successful workspace creation with platform default credential
- **WHEN** the operator submits a valid workspace creation request after GitHub App bootstrap is complete, selects at least one currently authorized repository from the installation inventory, and chooses the platform default agent credential
- **THEN** the control plane creates a workspace record and a runtime instance record with the platform-default credential binding
- **THEN** the control plane creates a dedicated GitHub Project for that workspace by using stored app-backed credentials
- **THEN** the control plane provisions a dedicated Symphony container mapped to that workspace

#### Scenario: Successful workspace creation with workspace-specific override credential
- **WHEN** the operator submits a valid workspace creation request with at least one currently authorized repository from the installation inventory and assigns a ready workspace-specific agent credential
- **THEN** the control plane persists the workspace-to-credential binding for that override
- **THEN** the control plane creates the GitHub Project and dedicated Symphony container for that workspace

#### Scenario: Missing repository selection
- **WHEN** the operator submits a workspace creation request without selecting any repositories
- **THEN** the control plane rejects the request with a validation error
- **THEN** no GitHub Project or Symphony container is created

#### Scenario: Repository selection is no longer authorized
- **WHEN** the operator submits a workspace creation request with a repository that is no longer available to the configured GitHub App installation
- **THEN** the control plane rejects the request with a validation error explaining that the repository selection must be refreshed
- **THEN** no GitHub Project or Symphony container is created

#### Scenario: Missing usable agent credential
- **WHEN** the operator submits a workspace creation request that references the platform default but no ready default credential exists, or references a non-ready override credential
- **THEN** the control plane rejects the request with a validation error explaining that a usable agent credential is required
- **THEN** no GitHub Project or Symphony container is created

#### Scenario: Bootstrap incomplete
- **WHEN** the operator attempts to open or submit the workspace creation flow before GitHub App bootstrap is complete
- **THEN** the control plane blocks workspace provisioning and routes the operator to the setup flow
- **THEN** no GitHub Project or Symphony container is created
