## ADDED Requirements

### Requirement: Control plane SHALL gate first-run use on GitHub App bootstrap state
The system SHALL inspect persisted system GitHub integration configuration before serving workspace provisioning or issue submission flows and SHALL direct operators to a GitHub App setup experience whenever the integration is missing, incomplete, or degraded.

#### Scenario: First boot without GitHub integration
- **WHEN** the control plane starts and no complete GitHub App configuration exists in the config database
- **THEN** the operator is directed to the GitHub App setup flow before using workspace or issue creation screens
- **THEN** the UI explains that GitHub integration setup is required before projects can be started

#### Scenario: Configured instance skips setup
- **WHEN** the control plane starts and a complete GitHub App configuration with an installed target is persisted
- **THEN** the control plane serves normal workspace and issue flows
- **THEN** it does not request manual GitHub credential input

### Requirement: Control plane SHALL register and install a GitHub App from the setup flow
The system SHALL allow an operator to create or connect the required GitHub App from the control-plane setup UI by using GitHub-supported registration and installation authorization flows, then SHALL persist the returned app metadata for future use.

#### Scenario: Successful setup flow
- **WHEN** the operator completes the GitHub App creation and installation steps from the setup UI
- **THEN** the control plane exchanges the callback data for GitHub App metadata and secret material
- **THEN** it persists the app identifiers, secret material, and installation binding needed for future token issuance

#### Scenario: Setup flow fails before completion
- **WHEN** GitHub rejects the manifest conversion, installation authorization, or callback verification step
- **THEN** the control plane keeps the integration out of the ready state
- **THEN** it shows an actionable recovery path that allows the operator to retry setup

### Requirement: Control plane SHALL detect revoked or degraded GitHub integration state
The system SHALL validate that the persisted GitHub App installation can still issue credentials and SHALL move the integration into a degraded state when required metadata is missing or GitHub rejects installation-token issuance.

#### Scenario: Revoked installation detected
- **WHEN** the control plane attempts to issue an installation token and GitHub reports that the installation is missing or revoked
- **THEN** the control plane marks the integration as degraded
- **THEN** it directs the operator to reconnect or re-run setup before new provisioning can continue

#### Scenario: Incomplete persisted configuration detected
- **WHEN** the control plane starts and finds only partial GitHub App metadata or secret material in the config database
- **THEN** it treats the instance as not ready for normal operation
- **THEN** it resumes the setup or recovery flow instead of allowing silent GitHub API failures
