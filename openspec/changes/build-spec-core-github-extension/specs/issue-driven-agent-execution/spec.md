## MODIFIED Requirements

### Requirement: Symphony SHALL execute work from tracker state without backend-side tracker mutation
The system SHALL detect actionable issues through the configured tracker adapter, load workflow semantics from the assigned repository's `WORKFLOW.md`, render the issue prompt from the workflow prompt template and runtime variables, start the appropriate Symphony execution for that issue in its persistent workspace, and keep normal tracker mutation responsibilities on the runtime side instead of the orchestration backend.

#### Scenario: Orchestrator picks up a planning issue
- **WHEN** the configured tracker adapter exposes an issue in a workflow-defined planning-active state
- **THEN** the Symphony orchestrator detects the issue through tracker reads
- **THEN** it assigns a worker run that reuses the issue workspace and starts a planning execution for that issue using the rendered Symphony prompt

#### Scenario: Orchestrator picks up an approved issue
- **WHEN** the configured tracker adapter exposes an issue in a workflow-defined implementation-active state
- **THEN** the Symphony orchestrator detects the issue through tracker reads
- **THEN** it assigns a worker run that reuses the issue workspace and starts an implementation execution for that issue using the rendered Symphony prompt

### Requirement: Agent completion SHALL update GitHub state through `github_graphql`
When the active tracker extension is GitHub Project, the system SHALL inject a `github_graphql` runtime tool so the agent can publish planning comments, report pull request results, and update issue or project status to workflow-defined handoff or completed states through GitHub API calls without requiring backend-owned business logic for normal tracker mutation.

#### Scenario: Planning run enters human review
- **WHEN** the agent finishes a planning run successfully for a GitHub-backed issue
- **THEN** the agent uses the injected `github_graphql` tool to post the planning comment to the GitHub issue
- **THEN** the agent uses the injected `github_graphql` tool to update the corresponding issue or project item into the human-review state

#### Scenario: Implementation run enters awaiting merge
- **WHEN** the agent finishes an implementation run successfully for a GitHub-backed issue
- **THEN** the agent uses the injected `github_graphql` tool to post a completion comment with the pull request reference
- **THEN** the agent uses the injected `github_graphql` tool to update the corresponding issue or project item into the awaiting-merge state

### Requirement: Non-active tracker states SHALL pause worker execution
The system SHALL treat workflow-defined human-review and awaiting-merge states as non-actionable so that the orchestrator waits for human or tracker-side progression before assigning another worker run, while preserving the issue workspace for later continuation.

#### Scenario: Human review state is not actionable
- **WHEN** a tracked issue is in the workflow-defined human-review state
- **THEN** the orchestrator does not dispatch an execution for that issue
- **THEN** the issue workspace remains available for the next actionable phase

#### Scenario: Awaiting merge state is not actionable
- **WHEN** a tracked issue is in the workflow-defined awaiting-merge state
- **THEN** the orchestrator does not dispatch another execution for that issue
- **THEN** the issue workspace remains available until the issue becomes actionable again or terminal
