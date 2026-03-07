## ADDED Requirements

### Requirement: Runtime SHALL resolve agent credentials before starting Codex
The system SHALL resolve the effective agent credential for a workspace through a control-plane broker before spawning `codex app-server`, and SHALL translate the broker response into the runtime environment contract required by the agent process.

#### Scenario: Runtime starts Codex with the platform default credential
- **WHEN** a worker runtime launches agent execution for a workspace that inherits the platform default credential
- **THEN** the worker authenticates to the control-plane broker with its workspace-scoped runtime secret before process start
- **THEN** the worker launches `codex app-server` with the brokered agent authentication environment for that workspace

#### Scenario: Runtime starts Codex with a workspace override credential
- **WHEN** a worker runtime launches agent execution for a workspace that uses a workspace-specific override credential
- **THEN** the worker resolves that workspace's override through the control-plane broker before process start
- **THEN** the worker launches `codex app-server` with the brokered authentication environment for that workspace

#### Scenario: Agent credential resolution fails
- **WHEN** the worker cannot resolve a valid effective agent credential for the workspace before launch
- **THEN** the worker does not start `codex app-server` for that run
- **THEN** the workspace runtime is marked degraded or failed with an operator-visible recovery state

## MODIFIED Requirements

### Requirement: Each workspace SHALL run in an isolated Symphony container
The system SHALL map exactly one GitHub Project and one Symphony worker container to each workspace so that workflow configuration, credentials, and filesystem state are isolated between workspaces, and SHALL scope runtime GitHub and agent credential access to the specific workspace instead of assuming shared host-level authentication state.

#### Scenario: Dedicated runtime allocation
- **WHEN** the control plane provisions a new workspace
- **THEN** it creates a worker container dedicated to that workspace only
- **THEN** the worker container receives only the workflow configuration and broker access needed for that workspace's GitHub and agent credentials

#### Scenario: Separate workspace execution
- **WHEN** two workspaces are active at the same time
- **THEN** work performed for one workspace does not reuse the other workspace's container, workflow files, repository checkout, or effective agent credential binding
- **THEN** credential issuance for one workspace does not expose reusable long-lived credentials for the other workspace

### Requirement: The runtime SHALL launch Codex through the native Symphony execution model
The system SHALL start the agent runtime by launching `codex app-server` as a subprocess inside the Symphony worker, SHALL communicate with it using the standard Symphony app-server interface, and SHALL assemble the required runtime authentication environment before launching the subprocess rather than relying on pre-mounted host login state.

#### Scenario: Worker startup
- **WHEN** a Symphony worker starts processing tasks for a workspace
- **THEN** it resolves the brokered runtime authentication environment required for that workspace
- **THEN** it launches `codex app-server` through the configured worker command
- **THEN** Symphony communicates with the agent over the expected subprocess interface without an additional protocol bridge
