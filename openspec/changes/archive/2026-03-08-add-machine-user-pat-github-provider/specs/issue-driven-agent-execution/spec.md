## MODIFIED Requirements

### Requirement: Users can create repository-targeted work items from the control plane
The system SHALL allow a trusted operator to create a GitHub issue from the control plane by entering the work description and selecting one of the repositories linked to the workspace, and SHALL perform the GitHub mutation by using the selected system GitHub credential provider instead of a per-request user-supplied token.

#### Scenario: Successful issue creation
- **WHEN** the operator submits a work item for a repository that belongs to the workspace after system GitHub setup is complete
- **THEN** the control plane creates the GitHub issue in the selected repository by using the selected system GitHub credential provider
- **THEN** the issue is associated with the workspace's GitHub Project so the Symphony tracker can observe it

#### Scenario: Repository outside workspace scope
- **WHEN** the operator attempts to create a work item for a repository that is not linked to the workspace
- **THEN** the control plane rejects the request
- **THEN** no GitHub issue is created

#### Scenario: Bootstrap incomplete
- **WHEN** the operator attempts to open or submit the issue creation flow before system GitHub setup is complete
- **THEN** the control plane blocks issue submission and routes the operator to the setup flow
- **THEN** no GitHub issue is created

### Requirement: Agent completion SHALL update GitHub state through `github_graphql`
The system SHALL inject a `github_graphql` tool into the agent runtime so the agent can publish plan comments, report pull request results, and update issue or project status to workflow-defined handoff or completed states through GitHub API calls by using the selected system GitHub credential provider.

#### Scenario: Planning run enters human review
- **WHEN** the agent finishes a planning run successfully
- **THEN** the agent uses the injected `github_graphql` tool to post the planning comment to the GitHub issue
- **THEN** the agent uses the injected `github_graphql` tool to update the corresponding issue or project item into the human-review state

#### Scenario: Implementation run enters awaiting merge
- **WHEN** the agent finishes an implementation run successfully
- **THEN** the agent uses the injected `github_graphql` tool to post a completion comment with the pull request reference
- **THEN** the agent uses the injected `github_graphql` tool to update the corresponding issue or project item into the awaiting-merge state
