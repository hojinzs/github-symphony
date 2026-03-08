## ADDED Requirements

### Requirement: Control-plane workflows SHALL remain optional to core orchestration
The system SHALL allow Symphony orchestration to continue when the control plane is unavailable, and SHALL treat control-plane workspace setup, issue creation, and dashboard flows as operator-facing extensions rather than as required runtime dependencies for orchestrator dispatch.

#### Scenario: Orchestrator continues without the control plane
- **WHEN** the control plane is unavailable after a workspace has already been configured
- **THEN** the orchestrator can continue polling trackers and dispatching assigned runs for that workspace
- **THEN** the absence of the control plane does not by itself stop active orchestration

## MODIFIED Requirements

### Requirement: Users can provision a workspace from the control plane
The system SHALL allow a trusted operator to create a workspace by providing a workspace name, prompt guidelines, one or more repositories, a tracker-binding extension configuration, and an agent credential source after required setup is complete, and SHALL persist the repository bindings and runtime metadata needed for that workspace by using the selected extension configuration and effective agent credential managed by the control plane.

#### Scenario: Successful workspace creation with platform default credential
- **WHEN** the operator submits a valid workspace creation request after required extension setup is complete, selects at least one authorized repository, supplies a supported tracker-binding configuration, and chooses the platform default agent credential
- **THEN** the control plane creates a workspace record and stores the platform-default credential binding for that workspace
- **THEN** the control plane persists the repository bindings and runtime metadata that the orchestrator and worker runtimes need for future execution
- **THEN** any extension-specific tracker resources are created by the selected tracker-binding extension, not by Symphony core orchestration itself

#### Scenario: Successful workspace creation with workspace-specific override credential
- **WHEN** the operator submits a valid workspace creation request with at least one authorized repository and assigns a ready workspace-specific agent credential
- **THEN** the control plane persists the workspace-to-credential binding for that override
- **THEN** the control plane creates the associated workspace execution metadata for that workspace

#### Scenario: Missing repository selection
- **WHEN** the operator submits a workspace creation request without selecting any repositories
- **THEN** the control plane rejects the request with a validation error
- **THEN** no workspace execution metadata is created

#### Scenario: Repository selection is no longer authorized
- **WHEN** the operator submits a workspace creation request with a repository that is no longer available to the selected extension configuration
- **THEN** the control plane rejects the request with a validation error explaining that the repository selection must be refreshed
- **THEN** no workspace execution metadata is created

#### Scenario: Missing usable agent credential
- **WHEN** the operator submits a workspace creation request that references the platform default but no ready default credential exists, or references a non-ready override credential
- **THEN** the control plane rejects the request with a validation error explaining that a usable agent credential is required
- **THEN** no workspace execution metadata is created

#### Scenario: Bootstrap incomplete
- **WHEN** the operator attempts to open or submit the workspace creation flow before the selected tracker-binding extension setup is complete
- **THEN** the control plane blocks workspace provisioning and routes the operator to the setup flow
- **THEN** no workspace execution metadata is created

### Requirement: Workspace metadata SHALL remain the source of truth for runtime management
The system SHALL persist the identifiers and configuration needed to manage each workspace runtime, including the workspace configuration, linked repositories, tracker-binding extension references, effective agent credential source, and status-surface discovery details, while leaving ephemeral orchestration leases, workflow semantics, and active run bookkeeping outside control-plane metadata.

#### Scenario: Runtime status lookup
- **WHEN** the control plane loads a workspace detail or dashboard view
- **THEN** it can resolve the workspace configuration, effective agent credential source, linked tracker identifiers, and orchestrator or worker status-surface addresses from persisted metadata
- **THEN** it uses that metadata to query the correct orchestration and worker state endpoints

### Requirement: The control plane SHALL expose aggregate workspace observability
The system SHALL provide a dashboard view that summarizes the live state of all active workspaces by combining persisted workspace metadata with orchestrator status snapshots and any active worker state endpoints.

#### Scenario: Dashboard state aggregation
- **WHEN** a user opens the workspace dashboard
- **THEN** the control plane queries all active workspace orchestration status surfaces in parallel
- **THEN** the response identifies each workspace, its orchestrator health, and any currently observed worker execution state
