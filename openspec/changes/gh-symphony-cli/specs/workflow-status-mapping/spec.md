## ADDED Requirements

### Requirement: Mapping SHALL fetch status field options from GitHub Project

The system SHALL query the GitHub Projects v2 GraphQL API to retrieve the status field (SingleSelectField) and its available options for the selected project.

#### Scenario: Project has a status field with options
- **WHEN** the system queries a GitHub Project that has a "Status" single-select field
- **THEN** it retrieves all option names and their internal IDs
- **THEN** it presents them as candidates for phase mapping

#### Scenario: Project has no status field
- **WHEN** the system queries a GitHub Project that has no single-select field named "Status"
- **THEN** the system lists all single-select fields and asks the user to choose which field represents workflow status

#### Scenario: Project has a custom-named status field
- **WHEN** the project uses a differently named field (e.g., "Stage", "Phase") as its workflow status
- **THEN** the user selects the correct field from the list of single-select fields
- **THEN** the system uses that field's options for mapping

### Requirement: Mapping SHALL apply smart defaults via pattern matching

The system SHALL match project status column names against known patterns to pre-select default role assignments, reducing user effort for common board layouts.

#### Scenario: All columns match known patterns
- **WHEN** a project has columns named "Backlog", "Todo", "In Progress", "Review", "Done"
- **THEN** the system pre-selects: "Backlog" → ignored, "Todo" → trigger, "In Progress" → working, "Review" → human-review, "Done" → done
- **THEN** the user can accept all defaults by pressing Enter through each prompt

#### Scenario: Partial pattern matches
- **WHEN** some columns match patterns and others do not (e.g., "Todo", "Developing", "QA", "Done")
- **THEN** the system pre-selects matches ("Todo" → trigger, "Done" → done)
- **THEN** unmatched columns ("Developing", "QA") require explicit user assignment or are left unmapped

#### Scenario: No columns match any pattern
- **WHEN** the project uses entirely custom column names
- **THEN** the system presents all columns without defaults
- **THEN** the user SHALL assign at minimum: trigger, working, and done roles

### Requirement: Mapping SHALL support configurable human-review modes

The system SHALL offer four human-review modes that control which Symphony phases require human intervention before proceeding.

#### Scenario: Plan-and-PR review mode
- **WHEN** the user selects `plan-and-pr` mode
- **THEN** the system maps `human-review` phase to a plan-review status
- **THEN** the system maps `awaiting-merge` phase to a PR-review status
- **THEN** both statuses may be the same column

#### Scenario: Plan-only review mode
- **WHEN** the user selects `plan-only` mode
- **THEN** the system maps `human-review` phase to a review status
- **THEN** the `awaiting-merge` phase uses the working status (no separate PR review gate)

#### Scenario: PR-only review mode
- **WHEN** the user selects `pr-only` mode
- **THEN** the `human-review` phase is skipped (planning proceeds directly to implementation)
- **THEN** the `awaiting-merge` phase maps to a review status

#### Scenario: No review mode (fully automatic)
- **WHEN** the user selects `none` mode
- **THEN** both `human-review` and `awaiting-merge` phases are skipped
- **THEN** the workflow proceeds from planning through implementation to completion without human gates

### Requirement: Mapping SHALL generate a valid WorkflowLifecycleConfig

The system SHALL transform the user's mapping selections into a `WorkflowLifecycleConfig` object that the orchestrator's existing lifecycle logic can consume without modification.

#### Scenario: Generated config matches orchestrator expectations
- **WHEN** the mapping is complete
- **THEN** the system produces a `WorkflowLifecycleConfig` with `stateFieldName`, `planningStates`, `humanReviewStates`, `implementationStates`, `awaitingMergeStates`, `completedStates`, `planningCompleteState`, `implementationCompleteState`, and `mergeCompleteState`
- **THEN** the config is written to `workflow-mapping.json` with both the user-facing mapping and the resolved `WorkflowLifecycleConfig`

#### Scenario: Mapping with skipped phases
- **WHEN** the user selects `none` for human-review mode
- **THEN** the generated `WorkflowLifecycleConfig` sets `humanReviewStates` and `awaitingMergeStates` to empty arrays
- **THEN** `planningCompleteState` transitions directly to the implementation status

### Requirement: Mapping SHALL validate completeness

The system SHALL validate that the mapping covers the minimum required roles before accepting it.

#### Scenario: Missing required mapping
- **WHEN** the user attempts to complete mapping without assigning trigger, working, or done roles
- **THEN** the system displays which required mappings are missing
- **THEN** the system re-prompts for the missing assignments

#### Scenario: Mapping confirmation with visual flow
- **WHEN** all mappings are assigned
- **THEN** the system displays a visual flow diagram showing the issue lifecycle from trigger through completion
- **THEN** the user confirms or revises the mapping before it is saved

### Requirement: Mapping SHALL track unmapped and ignored statuses

The system SHALL distinguish between ignored statuses (Symphony SHALL NOT process issues in these statuses) and unmapped statuses (not assigned to any Symphony phase, issues in these statuses are simply not picked up but not actively excluded).

#### Scenario: Issue in ignored status is never processed
- **WHEN** an issue is in a status marked as ignored (e.g., "Backlog")
- **THEN** the orchestrator SHALL NOT pick up or process that issue regardless of labels or other criteria

#### Scenario: Issue in unmapped status is passively skipped
- **WHEN** an issue is in a status that was not mapped to any role and not marked as ignored
- **THEN** the orchestrator does not pick it up in the current cycle
- **THEN** if the issue is later moved to the trigger status, the orchestrator picks it up normally
