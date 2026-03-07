## ADDED Requirements

### Requirement: Runtime SHALL refresh GitHub credentials without operator re-entry
The system SHALL issue renewable GitHub installation credentials for each workspace runtime from the stored GitHub App configuration and SHALL refresh those credentials before expiry without requiring the operator to re-enter GitHub secrets.

#### Scenario: Long-lived workspace refreshes credentials
- **WHEN** a workspace runtime needs GitHub access after its previous installation token approaches expiry or has expired
- **THEN** the runtime obtains a refreshed installation token derived from the stored GitHub App configuration
- **THEN** workspace processing continues without manual operator credential input

#### Scenario: Credential refresh fails after installation revocation
- **WHEN** a workspace runtime cannot obtain a refreshed installation token because the GitHub App installation is revoked or invalid
- **THEN** the runtime enters a degraded or failed state for that workspace
- **THEN** the control plane indicates that GitHub integration recovery is required

## MODIFIED Requirements

### Requirement: Each workspace SHALL run in an isolated Symphony container
The system SHALL map exactly one GitHub Project and one Symphony worker container to each workspace so that workflow configuration, credentials, and filesystem state are isolated between workspaces, and SHALL scope runtime GitHub credentials to short-lived workspace-authorized installation tokens instead of a shared long-lived static token.

#### Scenario: Dedicated runtime allocation
- **WHEN** the control plane provisions a new workspace
- **THEN** it creates a worker container dedicated to that workspace only
- **THEN** the worker container receives only the workflow configuration and the renewable credential access needed for that workspace

#### Scenario: Separate workspace execution
- **WHEN** two workspaces are active at the same time
- **THEN** work performed for one workspace does not reuse the other workspace's container, workflow files, or repository checkout
- **THEN** GitHub credential issuance for one workspace does not expose reusable long-lived credentials for the other workspace
