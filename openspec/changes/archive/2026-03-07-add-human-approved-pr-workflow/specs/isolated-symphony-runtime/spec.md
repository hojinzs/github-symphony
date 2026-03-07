## ADDED Requirements

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
