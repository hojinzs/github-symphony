# issue-driven-agent-execution Specification

## Purpose
Define how Symphony turns GitHub Project issues into agent work while keeping tracker mutation inside the runtime and supporting approval-gated execution.

## Requirements

### Requirement: Users can create repository-targeted work items from the control plane
The system SHALL allow a trusted operator to create a GitHub issue from the control plane by entering the work description and selecting one of the repositories linked to the workspace, and SHALL perform the GitHub mutation by using the stored GitHub App installation credentials instead of a per-request user-supplied token.

#### Scenario: Successful issue creation
- **WHEN** the operator submits a work item for a repository that belongs to the workspace after GitHub App bootstrap is complete
- **THEN** the control plane creates the GitHub issue in the selected repository by using app-backed credentials
- **THEN** the issue is associated with the workspace's GitHub Project so the Symphony tracker can observe it

#### Scenario: Repository outside workspace scope
- **WHEN** the operator attempts to create a work item for a repository that is not linked to the workspace
- **THEN** the control plane rejects the request
- **THEN** no GitHub issue is created

#### Scenario: Bootstrap incomplete
- **WHEN** the operator attempts to open or submit the issue creation flow before GitHub App bootstrap is complete
- **THEN** the control plane blocks issue submission and routes the operator to the setup flow
- **THEN** no GitHub issue is created

### Requirement: Symphony SHALL execute work from tracker state without backend-side tracker mutation
The system SHALL detect actionable issues by reading the configured GitHub Project state, prepare a workspace for the selected issue, infer whether the issue is in planning or implementation phase from workflow-defined active states, and leave normal tracker mutation responsibilities to the agent instead of the orchestration backend.

#### Scenario: Worker picks up a planning issue
- **WHEN** a linked GitHub Project contains an issue in a workflow-defined planning-active state
- **THEN** the Symphony worker detects the issue through tracker reads
- **THEN** it creates an isolated workspace and starts a planning execution for that issue

#### Scenario: Worker picks up an approved issue
- **WHEN** a linked GitHub Project contains an issue in a workflow-defined implementation-active state
- **THEN** the Symphony worker detects the issue through tracker reads
- **THEN** it creates an isolated workspace and starts an implementation execution for that issue

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
The system SHALL treat workflow-defined human-review and awaiting-merge states as non-actionable so that the worker waits for human or GitHub-side progression before starting another run.

#### Scenario: Human review state is not actionable
- **WHEN** a tracked issue is in the workflow-defined human-review state
- **THEN** the worker does not start an execution for that issue

#### Scenario: Awaiting merge state is not actionable
- **WHEN** a tracked issue is in the workflow-defined awaiting-merge state
- **THEN** the worker does not start another execution for that issue
