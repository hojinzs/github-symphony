# github-pat-bootstrap Specification

## Purpose
Define how the control plane bootstraps, validates, and recovers the system machine-user PAT used for GitHub operations.

## Requirements

### Requirement: Control plane SHALL allow machine-user PAT bootstrap for system GitHub integration
The system SHALL allow a trusted operator to configure a system GitHub Personal Access Token for a dedicated machine user from the setup flow and SHALL persist the encrypted token material and validated actor metadata needed for future GitHub operations.

#### Scenario: Successful PAT bootstrap
- **WHEN** the operator submits a valid GitHub Personal Access Token and intended organization owner from the setup flow
- **THEN** the control plane validates the token against the required GitHub REST and GraphQL capabilities
- **THEN** it stores the encrypted token material, token fingerprint, validated actor login, and validated owner metadata in the config database

#### Scenario: PAT bootstrap fails validation
- **WHEN** the submitted token cannot authenticate, cannot access the intended organization, or cannot perform the required project capability checks
- **THEN** the control plane keeps the GitHub integration out of the ready state
- **THEN** it shows an actionable validation error that explains which capability is missing

### Requirement: Control plane SHALL use PAT-only setup for first-run onboarding
The system SHALL guide operators toward organization-backed machine-user credentials as the only supported first-run setup path whenever GitHub integration is missing or reset.

#### Scenario: First boot shows PAT setup
- **WHEN** the control plane starts without a ready system GitHub integration
- **THEN** the setup UI presents machine-user PAT configuration
- **THEN** it explains that organization-backed credentials are required for workspace project provisioning

#### Scenario: Operator reaches setup without prior GitHub state
- **WHEN** the operator reaches setup without a ready GitHub integration
- **THEN** the control plane presents only the machine-user PAT bootstrap flow
- **THEN** the UI explains that PAT is the required GitHub integration path

### Requirement: Control plane SHALL detect degraded PAT integration state
The system SHALL validate that the persisted machine-user PAT still supports the required GitHub operations and SHALL move the integration into a degraded state when authentication fails, access is revoked, or required project permissions are no longer available.

#### Scenario: PAT revoked or expired
- **WHEN** the control plane attempts a GitHub operation with the stored PAT and GitHub rejects the token as invalid, expired, or revoked
- **THEN** the control plane marks the system GitHub integration as degraded
- **THEN** it directs the operator to setup to replace the token before new provisioning or issue work continues

#### Scenario: PAT loses project capability
- **WHEN** the control plane validates the stored PAT and discovers that the token can no longer create or mutate the required organization-owned Projects
- **THEN** the control plane marks the integration as degraded
- **THEN** it explains that the machine-user credential no longer satisfies the required project permissions
