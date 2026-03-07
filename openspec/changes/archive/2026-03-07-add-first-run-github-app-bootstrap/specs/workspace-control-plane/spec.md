## MODIFIED Requirements

### Requirement: Users can provision a workspace from the control plane
The system SHALL allow a trusted operator to create a workspace by providing a workspace name, prompt guidelines, and one or more GitHub repositories after GitHub App bootstrap is complete, and SHALL provision the GitHub Project and Symphony runtime resources needed for that workspace by using app-backed GitHub credentials managed by the control plane.

#### Scenario: Successful workspace creation
- **WHEN** the operator submits a valid workspace creation request after GitHub App bootstrap is complete and selects at least one authorized repository
- **THEN** the control plane creates a workspace record and a runtime instance record
- **THEN** the control plane creates a dedicated GitHub Project for that workspace by using stored app-backed credentials
- **THEN** the control plane provisions a dedicated Symphony container mapped to that workspace

#### Scenario: Missing repository selection
- **WHEN** the operator submits a workspace creation request without selecting any repositories
- **THEN** the control plane rejects the request with a validation error
- **THEN** no GitHub Project or Symphony container is created

#### Scenario: Bootstrap incomplete
- **WHEN** the operator attempts to open or submit the workspace creation flow before GitHub App bootstrap is complete
- **THEN** the control plane blocks workspace provisioning and routes the operator to the setup flow
- **THEN** no GitHub Project or Symphony container is created
