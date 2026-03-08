## MODIFIED Requirements

### Requirement: Control plane SHALL gate first-run use on GitHub bootstrap state
The system SHALL inspect persisted system GitHub integration configuration before serving workspace provisioning or issue submission flows and SHALL direct operators to PAT setup whenever the GitHub integration is missing, incomplete, or degraded.

#### Scenario: First boot without GitHub integration
- **WHEN** the control plane starts and no complete system GitHub integration exists in the config database
- **THEN** the operator is directed to the setup flow before using workspace or issue creation screens
- **THEN** the UI explains that GitHub integration setup is required before projects can be started

#### Scenario: Configured instance skips setup
- **WHEN** the control plane starts and a complete machine-user PAT integration is persisted
- **THEN** the control plane serves normal workspace and issue flows
- **THEN** it does not request manual per-request GitHub credential input

### Requirement: Control plane SHALL store and validate a machine-user PAT from the setup flow
The system SHALL allow an operator to submit the machine-user PAT plus intended organization owner from the control-plane setup UI, validate the token against the required GitHub capabilities, and persist the encrypted token material for future use.

#### Scenario: Successful setup flow
- **WHEN** the operator submits a valid machine-user PAT and organization owner from the setup UI
- **THEN** the control plane validates PAT authentication, organization access, repository inventory, and Project capability
- **THEN** it persists the encrypted token plus validated actor and owner metadata needed for future GitHub operations

#### Scenario: Setup flow fails before completion
- **WHEN** GitHub rejects PAT authentication, organization access, repository inventory, or Project capability validation
- **THEN** the control plane keeps the integration out of the ready state
- **THEN** it shows an actionable recovery path that allows the operator to retry PAT setup

### Requirement: Control plane SHALL detect revoked or degraded GitHub integration state
The system SHALL validate that the persisted machine-user PAT can still satisfy the required GitHub operations and SHALL move the integration into a degraded state when required metadata is missing or GitHub rejects the PAT-backed credential flow.

#### Scenario: Revoked PAT detected
- **WHEN** the control plane attempts to use the stored PAT and GitHub reports that the token is missing, revoked, expired, or otherwise invalid
- **THEN** the control plane marks the integration as degraded
- **THEN** it directs the operator to replace the PAT before new provisioning can continue

#### Scenario: Incomplete persisted configuration detected
- **WHEN** the control plane starts and finds only partial PAT metadata or secret material in the config database
- **THEN** it treats the instance as not ready for normal operation
- **THEN** it resumes the setup or recovery flow instead of allowing silent GitHub API failures

## ADDED Requirements

### Requirement: Control plane SHALL require organization-backed PAT owners
The system SHALL prevent operators from treating unsupported PAT owner targets as fully ready for project-backed provisioning when the required GitHub Project operations are known to fail.

#### Scenario: Personal-account PAT cannot satisfy project provisioning
- **WHEN** the operator submits a PAT that cannot validate the required organization-backed project capability for the selected owner
- **THEN** the control plane keeps the integration out of the fully ready state for workspace provisioning
- **THEN** it directs the operator toward a supported organization-backed machine-user PAT
