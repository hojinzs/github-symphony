# isolated-symphony-runtime Specification

## Purpose
Define the isolated runtime contract for workspace execution, including repeatable workspace setup and renewable credentials for GitHub API access and repository writes.

## Requirements

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
