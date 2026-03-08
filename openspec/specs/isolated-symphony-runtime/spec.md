# isolated-symphony-runtime Specification

## Purpose
Define the isolated runtime contract for workspace execution, including repeatable workspace setup and renewable credentials for GitHub API access and repository writes.

## Requirements

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

### Requirement: The runtime SHALL launch Codex through the native Symphony execution model
The system SHALL start the agent runtime by launching `codex app-server` as a subprocess inside the Symphony worker, SHALL communicate with it using the standard Symphony app-server interface, and SHALL assemble the required runtime authentication environment before launching the subprocess rather than relying on pre-mounted host login state.

#### Scenario: Worker startup
- **WHEN** a Symphony worker starts processing tasks for a workspace
- **THEN** it resolves the brokered runtime authentication environment required for that workspace
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

### Requirement: Runtime SHALL refresh GitHub credentials without operator re-entry
The system SHALL issue renewable GitHub credentials for each workspace runtime from the stored machine-user PAT configuration and SHALL refresh those credentials before expiry or revalidation windows without requiring the operator to re-enter GitHub secrets.

#### Scenario: Long-lived workspace refreshes credentials
- **WHEN** a workspace runtime needs GitHub access after its previous brokered credential approaches expiry or its PAT validation window has elapsed
- **THEN** the runtime obtains a refreshed brokered credential derived from the stored machine-user PAT configuration
- **THEN** workspace processing continues without manual operator credential input

#### Scenario: Credential refresh fails after installation revocation
- **WHEN** a workspace runtime cannot obtain a refreshed brokered credential because the stored machine-user PAT is revoked, expired, or no longer valid
- **THEN** the runtime enters a degraded or failed state for that workspace
- **THEN** the control plane indicates that GitHub integration recovery is required

### Requirement: Workflow artifacts SHALL describe phase-aware execution states
The system SHALL generate per-workspace workflow artifacts that define the tracker states used for planning, human review, implementation, awaiting merge, and completion so the runtime can execute the approval-gated lifecycle without hard-coded status names.

#### Scenario: Workspace workflow includes lifecycle states
- **WHEN** the control plane provisions a workspace for approval-gated execution
- **THEN** it writes workflow artifacts that identify the planning-active, human-review, implementation-active, awaiting-merge, and completed tracker states for that workspace
- **THEN** the worker reads those workflow artifacts to decide which issues are actionable

### Requirement: Runtime setup SHALL be repeatable across multiple runs for the same issue
The system SHALL prepare a fresh isolated workspace for each active phase of an issue so that planning and implementation runs can occur as separate resumable executions.

#### Scenario: Approved issue gets a fresh implementation workspace
- **WHEN** an issue re-enters the worker in the implementation-active state after human approval
- **THEN** the runtime prepares a new isolated workspace for that run
- **THEN** the runtime clones the target repository again through the workspace hook before execution starts

### Requirement: Runtime credentials SHALL support renewable repository write access
The system SHALL provide the worker with renewable workspace-scoped credentials that support both GitHub API mutation and authenticated repository write operations without persisting long-lived secrets in workflow files or cloned repositories.

#### Scenario: Worker pushes an implementation branch
- **WHEN** the agent needs to push a branch during an implementation run
- **THEN** the runtime resolves a short-lived workspace-scoped credential through the runtime broker
- **THEN** the branch push succeeds without storing a long-lived GitHub token in the repository checkout
