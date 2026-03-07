## ADDED Requirements

### Requirement: Users can create repository-targeted work items from the control plane
The system SHALL allow a user to create a GitHub issue from the control plane by entering the work description and selecting one of the repositories linked to the workspace.

#### Scenario: Successful issue creation
- **WHEN** a user submits a work item for a repository that belongs to the workspace
- **THEN** the control plane creates the GitHub issue in the selected repository
- **THEN** the issue is associated with the workspace's GitHub Project so the Symphony tracker can observe it

#### Scenario: Repository outside workspace scope
- **WHEN** a user attempts to create a work item for a repository that is not linked to the workspace
- **THEN** the control plane rejects the request
- **THEN** no GitHub issue is created

### Requirement: Symphony SHALL execute work from tracker state without backend-side tracker mutation
The system SHALL detect actionable issues by reading the configured GitHub Project state, prepare a workspace for the selected issue, and leave tracker mutation responsibilities to the agent instead of the orchestration backend.

#### Scenario: Worker picks up a new issue
- **WHEN** a linked GitHub Project contains a newly actionable issue
- **THEN** the Symphony worker detects the issue through tracker reads
- **THEN** it creates an isolated workspace and starts agent execution for that issue

### Requirement: Agent completion SHALL update GitHub state through `github_graphql`
The system SHALL inject a `github_graphql` tool into the agent runtime so the agent can update issue or project status, including moving completed work to `Done`, through GitHub GraphQL calls.

#### Scenario: Issue completed by the agent
- **WHEN** the agent finishes a task successfully
- **THEN** the agent uses the injected `github_graphql` tool to update the corresponding GitHub issue or project item state
- **THEN** the work item becomes visible as completed in the GitHub Project and the control-plane dashboard
