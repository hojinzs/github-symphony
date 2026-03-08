## ADDED Requirements

### Requirement: GitHub Projects adapter SHALL bind a workspace to a GitHub-backed tracker
The system SHALL provide an optional GitHub-backed tracker adapter that can create or connect a workspace to a dedicated GitHub Project, validate repository access through the configured machine-user credential, and expose that project through the core tracker adapter contract used by the orchestrator.

#### Scenario: Workspace is bound to a new GitHub Project
- **WHEN** an operator creates a workspace with the GitHub Projects tracker adapter after machine-user setup is complete
- **THEN** the adapter creates or links the dedicated GitHub Project for that workspace by using the stored machine-user credential
- **THEN** the orchestrator can observe that GitHub Project through the same tracker adapter contract it uses for actionable issue discovery

### Requirement: GitHub Projects adapter SHALL support operator-assisted issue creation
The system SHALL allow an operator to create a GitHub issue for a repository linked to the workspace through the GitHub adapter flow, and SHALL associate that issue with the workspace's GitHub Project by using the stored machine-user credential instead of a per-request user-supplied token.

#### Scenario: Successful GitHub-backed issue creation
- **WHEN** the operator submits a work item for a repository that belongs to a workspace using the GitHub Projects adapter
- **THEN** the adapter creates the GitHub issue in the selected repository by using the stored machine-user credential
- **THEN** the adapter associates the issue with the workspace's GitHub Project so the orchestrator can observe it through the tracker adapter contract

#### Scenario: Repository outside workspace scope
- **WHEN** the operator attempts to create a GitHub-backed work item for a repository that is not linked to the workspace
- **THEN** the adapter rejects the request
- **THEN** no GitHub issue is created
