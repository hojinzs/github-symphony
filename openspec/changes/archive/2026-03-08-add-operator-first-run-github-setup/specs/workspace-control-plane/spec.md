## MODIFIED Requirements

### Requirement: Users can provision a workspace from the control plane
The system SHALL allow a trusted, authenticated operator to create a workspace by providing a workspace name, prompt guidelines, selecting one or more repositories authorized for the configured GitHub App installation, and choosing an agent credential source after all required setup steps are complete, and SHALL provision the GitHub Project and Symphony runtime resources needed for that workspace by using installation-backed credentials for organization installs or authorized user-backed project credentials for personal-account installs.

#### Scenario: Successful workspace creation for organization install with platform default credential
- **WHEN** an authenticated operator submits a valid workspace creation request after GitHub App bootstrap is complete for an organization installation, selects at least one currently authorized repository, and chooses the platform default agent credential
- **THEN** the control plane creates a workspace record and a runtime instance record with the platform-default credential binding
- **THEN** the control plane creates a dedicated GitHub Project for that workspace by using installation-backed GitHub credentials
- **THEN** the control plane provisions a dedicated Symphony container mapped to that workspace

#### Scenario: Successful workspace creation for personal-account install
- **WHEN** an authenticated operator submits a valid workspace creation request after GitHub App bootstrap is complete for a personal-account installation, selects at least one currently authorized repository, and the required GitHub user authorization is ready
- **THEN** the control plane creates the workspace record and runtime instance record
- **THEN** the control plane creates the dedicated GitHub Project for that workspace by using the stored personal-owner user authorization
- **THEN** the control plane provisions a dedicated Symphony container mapped to that workspace

#### Scenario: Missing repository selection
- **WHEN** the operator submits a workspace creation request without selecting any repositories
- **THEN** the control plane rejects the request with a validation error
- **THEN** no GitHub Project or Symphony container is created

#### Scenario: Missing usable agent credential
- **WHEN** the operator submits a workspace creation request that references the platform default but no ready default credential exists, or references a non-ready override credential
- **THEN** the control plane rejects the request with a validation error explaining that a usable agent credential is required
- **THEN** no GitHub Project or Symphony container is created

#### Scenario: Setup incomplete because operator is not authenticated
- **WHEN** an unauthenticated browser session attempts to open or submit the workspace creation flow
- **THEN** the control plane blocks workspace provisioning and routes the operator to sign in first
- **THEN** no GitHub Project or Symphony container is created

#### Scenario: Setup incomplete because personal-owner authorization is missing
- **WHEN** an authenticated operator attempts to open or submit the workspace creation flow for a personal-account installation before the required GitHub user authorization is complete
- **THEN** the control plane blocks workspace provisioning and routes the operator to the remaining setup step
- **THEN** no GitHub Project or Symphony container is created
