## REMOVED Requirements

### Requirement: Users can create repository-targeted work items from the control plane
**Reason**: GitHub issue creation and project association are tracker-adapter-specific operator workflows, not part of the core Symphony orchestration contract.
**Migration**: Move GitHub-backed issue creation behavior to the `github-project-tracker-adapter` capability and keep core issue-driven execution focused on tracker-agnostic dispatch semantics.

## MODIFIED Requirements

### Requirement: Symphony SHALL execute work from tracker state without backend-side tracker mutation
The system SHALL detect actionable issues by having the orchestrator read the configured tracker adapter state, load workflow semantics from the assigned repository's `WORKFLOW.md`, prepare an assigned run for the selected issue, infer whether the issue is in planning or implementation phase from workflow-defined active states, and leave normal tracker mutation responsibilities to the agent instead of the orchestration backend.

#### Scenario: Orchestrator picks up a planning issue
- **WHEN** the configured tracker adapter exposes an issue in a workflow-defined planning-active state
- **THEN** the Symphony orchestrator detects the issue through tracker reads
- **THEN** it assigns a worker run that creates an isolated workspace and starts a planning execution for that issue

#### Scenario: Orchestrator picks up an approved issue
- **WHEN** the configured tracker adapter exposes an issue in a workflow-defined implementation-active state
- **THEN** the Symphony orchestrator detects the issue through tracker reads
- **THEN** it assigns a worker run that creates an isolated workspace and starts an implementation execution for that issue

### Requirement: Non-active tracker states SHALL pause worker execution
The system SHALL treat workflow-defined human-review and awaiting-merge states as non-actionable so that the orchestrator waits for human or GitHub-side progression before assigning another worker run.

#### Scenario: Human review state is not actionable
- **WHEN** a tracked issue is in the workflow-defined human-review state
- **THEN** the orchestrator does not dispatch an execution for that issue

#### Scenario: Awaiting merge state is not actionable
- **WHEN** a tracked issue is in the workflow-defined awaiting-merge state
- **THEN** the orchestrator does not dispatch another execution for that issue
