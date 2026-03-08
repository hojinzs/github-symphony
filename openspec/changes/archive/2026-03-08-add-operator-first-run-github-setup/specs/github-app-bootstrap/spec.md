## MODIFIED Requirements

### Requirement: Control plane SHALL gate first-run use on GitHub App bootstrap state
The system SHALL inspect both operator authentication state and persisted system GitHub integration configuration before serving setup, workspace provisioning, or issue submission flows, and SHALL direct operators to the next required prerequisite whenever sign-in, GitHub App setup, installation, or personal-owner authorization is missing.

#### Scenario: First boot without operator session
- **WHEN** an unauthenticated browser session reaches the control plane on first boot
- **THEN** the control plane redirects the browser to the operator sign-in flow before exposing setup actions
- **THEN** it does not expose workspace or issue creation screens until the operator session exists

#### Scenario: First boot after operator sign-in without GitHub integration
- **WHEN** an authenticated operator reaches setup and no complete GitHub App configuration exists in the config database
- **THEN** the control plane directs the operator to the GitHub App setup flow before using workspace or issue creation screens
- **THEN** the UI explains which bootstrap step remains incomplete

#### Scenario: Personal-owner install still requires authorization
- **WHEN** an authenticated operator has completed GitHub App registration and installation into a personal account but has not completed the required GitHub user authorization
- **THEN** the control plane keeps the integration out of the fully ready state for project-backed provisioning
- **THEN** it directs the operator to complete the personal-owner authorization step before workspace or issue creation can proceed

#### Scenario: Configured instance skips setup
- **WHEN** the control plane starts with an authenticated operator session, a complete GitHub App configuration, a validated installation target, and any required personal-owner authorization already persisted
- **THEN** the control plane serves normal workspace and issue flows
- **THEN** it does not request manual GitHub credential input

### Requirement: Control plane SHALL register and install a GitHub App from the setup flow
The system SHALL allow an authenticated operator to create or connect the required GitHub App from the control-plane setup UI by using GitHub-supported registration and installation authorization flows, then SHALL persist the returned app metadata for future use.

#### Scenario: Successful organization setup flow
- **WHEN** the operator completes the GitHub App creation and installation steps and the installation target is an organization
- **THEN** the control plane exchanges the callback data for GitHub App metadata and secret material
- **THEN** it persists the app identifiers, secret material, and installation binding needed for future installation-token issuance

#### Scenario: Successful personal-account setup flow
- **WHEN** the operator completes the GitHub App creation and installation steps and the installation target is a GitHub user account
- **THEN** the control plane persists the app identifiers, secret material, and installation binding needed for future token issuance
- **THEN** it keeps the setup UI on the personal-owner authorization step until the user authorization callback completes successfully

#### Scenario: Setup flow fails before completion
- **WHEN** GitHub rejects the manifest conversion, installation authorization, personal-owner authorization, or callback verification step
- **THEN** the control plane keeps the integration out of the ready state
- **THEN** it shows an actionable recovery path that allows the operator to retry the failed step

## ADDED Requirements

### Requirement: Control plane SHALL persist personal-owner GitHub authorization for user-owned project access
The system SHALL collect and store the GitHub user authorization material required for personal-account installations so the control plane can create and mutate user-owned GitHub Projects after setup.

#### Scenario: Personal-owner authorization completes
- **WHEN** an authenticated operator finishes the GitHub user authorization callback for a personal-account installation
- **THEN** the control plane stores the authorized GitHub user identity, encrypted user access token material, and token expiry metadata
- **THEN** it marks the final setup prerequisite as complete for personal-owner provisioning flows

#### Scenario: Personal-owner authorization expires
- **WHEN** the control plane needs a personal-owner project credential and the stored user authorization is missing, expired, or refresh fails
- **THEN** the control plane marks the authorization step as requiring recovery
- **THEN** it directs the operator back to setup to re-authorize before project-backed flows continue
