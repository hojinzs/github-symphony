# issue-driven-agent-execution Specification

## Purpose
Define how Symphony turns tracker issues into assigned agent work while keeping normal tracker mutation inside the runtime and supporting approval-gated execution.

## Requirements

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

### Requirement: Agent completion SHALL update GitHub state through `github_graphql`
The system SHALL inject a `github_graphql` tool into the agent runtime so the agent can publish plan comments, report pull request results, and update issue or project status to workflow-defined handoff or completed states through GitHub API calls.

#### Scenario: Planning run enters human review
- **WHEN** the agent finishes a planning run successfully
- **THEN** the agent uses the injected `github_graphql` tool to post the planning comment to the GitHub issue
- **THEN** the agent uses the injected `github_graphql` tool to update the corresponding issue or project item into the human-review state

#### Scenario: Implementation run enters awaiting merge
- **WHEN** the agent finishes an implementation run successfully
- **THEN** the agent uses the injected `github_graphql` tool to post a completion comment with the pull request reference
- **THEN** the agent uses the injected `github_graphql` tool to update the corresponding issue or project item into the awaiting-merge state

### Requirement: Non-active tracker states SHALL pause worker execution
The system SHALL treat workflow-defined human-review and awaiting-merge states as non-actionable so that the orchestrator waits for human or GitHub-side progression before assigning another worker run.

#### Scenario: Human review state is not actionable
- **WHEN** a tracked issue is in the workflow-defined human-review state
- **THEN** the orchestrator does not dispatch an execution for that issue

#### Scenario: Awaiting merge state is not actionable
- **WHEN** a tracked issue is in the workflow-defined awaiting-merge state
- **THEN** the orchestrator does not dispatch another execution for that issue
