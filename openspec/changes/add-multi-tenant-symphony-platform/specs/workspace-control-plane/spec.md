## ADDED Requirements

### Requirement: Users can provision a workspace from the control plane
The system SHALL allow an authenticated user to create a workspace by providing a workspace name, prompt guidelines, and one or more GitHub repositories, and SHALL provision the GitHub Project and Symphony runtime resources needed for that workspace.

#### Scenario: Successful workspace creation
- **WHEN** an authenticated user submits a valid workspace creation request with at least one authorized repository
- **THEN** the control plane creates a workspace record and a runtime instance record
- **THEN** the control plane creates a dedicated GitHub Project for that workspace
- **THEN** the control plane provisions a dedicated Symphony container mapped to that workspace

#### Scenario: Missing repository selection
- **WHEN** an authenticated user submits a workspace creation request without selecting any repositories
- **THEN** the control plane rejects the request with a validation error
- **THEN** no GitHub Project or Symphony container is created

### Requirement: Workspace metadata SHALL remain the source of truth for runtime management
The system SHALL persist the identifiers and status needed to manage each workspace runtime, including the workspace configuration, linked repositories, GitHub Project identifiers, container identity, port mapping, and last known lifecycle state.

#### Scenario: Runtime status lookup
- **WHEN** the control plane loads a workspace detail or dashboard view
- **THEN** it can resolve the workspace configuration and mapped runtime instance from persisted metadata
- **THEN** it uses that metadata to query the correct worker state endpoint

### Requirement: The control plane SHALL expose aggregate workspace observability
The system SHALL provide a dashboard view that summarizes the live state of all active workspaces by combining persisted metadata with each worker container's state endpoint.

#### Scenario: Dashboard state aggregation
- **WHEN** a user opens the workspace dashboard
- **THEN** the control plane queries all active workspace state endpoints in parallel
- **THEN** the response identifies each workspace, its runtime health, and its currently observed execution state
