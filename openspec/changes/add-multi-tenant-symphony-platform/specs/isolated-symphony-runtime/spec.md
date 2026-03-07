## ADDED Requirements

### Requirement: Each workspace SHALL run in an isolated Symphony container
The system SHALL map exactly one GitHub Project and one Symphony worker container to each workspace so that workflow configuration, credentials, and filesystem state are isolated between workspaces.

#### Scenario: Dedicated runtime allocation
- **WHEN** the control plane provisions a new workspace
- **THEN** it creates a worker container dedicated to that workspace only
- **THEN** the worker container receives only the workflow configuration and credentials required for that workspace

#### Scenario: Separate workspace execution
- **WHEN** two workspaces are active at the same time
- **THEN** work performed for one workspace does not reuse the other workspace's container, workflow files, or repository checkout

### Requirement: The runtime SHALL launch Codex through the native Symphony execution model
The system SHALL start the agent runtime by launching `codex app-server` as a subprocess inside the Symphony worker and SHALL communicate with it using the standard Symphony app-server interface.

#### Scenario: Worker startup
- **WHEN** a Symphony worker starts processing tasks for a workspace
- **THEN** it launches `codex app-server` through the configured worker command
- **THEN** Symphony communicates with the agent over the expected subprocess interface without an additional protocol bridge

### Requirement: Repository preparation SHALL be resolved through runtime hooks
The system SHALL use an `after_create` hook to determine the target repository for a task and clone that repository dynamically into the ephemeral workspace before agent execution begins.

#### Scenario: Allowed repository clone
- **WHEN** a task references a repository that belongs to the workspace's configured repository allowlist
- **THEN** the `after_create` hook clones that repository into the new workspace directory
- **THEN** the agent begins execution against the cloned repository

#### Scenario: Disallowed repository clone
- **WHEN** a task references a repository outside the workspace's configured repository allowlist
- **THEN** the `after_create` hook fails the workspace preparation step
- **THEN** the worker does not start agent execution for that task
