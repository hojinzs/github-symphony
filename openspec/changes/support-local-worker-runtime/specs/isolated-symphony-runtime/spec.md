## RENAMED Requirements

### Requirement: Each workspace SHALL run in an isolated Symphony container
FROM: `Each workspace SHALL run in an isolated Symphony container`
TO: `Each workspace SHALL run in an isolated Symphony runtime`

## MODIFIED Requirements

### Requirement: Each workspace SHALL run in an isolated Symphony runtime
The system SHALL map exactly one GitHub Project and one Symphony worker runtime to each workspace, where the runtime MAY be a Docker container or a dedicated local host process selected by the configured runtime driver, so that workflow configuration, credentials, and filesystem state are isolated between workspaces, and SHALL scope runtime GitHub and agent credential access to the specific workspace instead of assuming shared host-level authentication state.

#### Scenario: Dedicated container allocation
- **WHEN** the control plane provisions a new workspace while configured for the Docker runtime driver
- **THEN** it creates a worker container dedicated to that workspace only
- **THEN** the worker container receives only the workflow configuration and broker access needed for that workspace's GitHub and agent credentials

#### Scenario: Dedicated local process allocation
- **WHEN** the control plane provisions a new workspace while configured for the local runtime driver
- **THEN** it starts a dedicated worker host process for that workspace without requiring Docker
- **THEN** the worker host process uses only that workspace's runtime directory, workflow artifacts, and broker access

#### Scenario: Separate workspace execution
- **WHEN** two workspaces are active at the same time under the same or different runtime drivers
- **THEN** work performed for one workspace does not reuse the other workspace's runtime instance, workflow files, repository checkout, or effective agent credential binding
- **THEN** credential issuance for one workspace does not expose reusable long-lived credentials for the other workspace
