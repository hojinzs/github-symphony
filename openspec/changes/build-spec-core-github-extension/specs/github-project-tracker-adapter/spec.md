## MODIFIED Requirements

### Requirement: GitHub Projects adapter SHALL bind a workspace to a GitHub-backed tracker
The system SHALL provide GitHub Project support as an optional tracker extension that binds a workspace to GitHub-backed issue discovery and status refresh while conforming to the core Symphony tracker contract used by the orchestrator.

#### Scenario: Workspace is bound to a new GitHub Project
- **WHEN** an operator creates a workspace with the GitHub Projects tracker adapter after machine-user setup is complete
- **THEN** the adapter creates or links the dedicated GitHub Project for that workspace by using the stored machine-user credential
- **THEN** the orchestrator can observe that GitHub Project through the same core tracker adapter contract it uses for other tracker integrations

### Requirement: GitHub Projects adapter SHALL support operator-assisted issue creation
The system SHALL allow an operator to create a GitHub issue for a repository linked to the workspace through the GitHub extension flow, and SHALL associate that issue with the workspace's GitHub Project by using the stored machine-user credential instead of a per-request user-supplied token.

#### Scenario: Successful GitHub-backed issue creation
- **WHEN** the operator submits a work item for a repository that belongs to a workspace using the GitHub Projects tracker adapter
- **THEN** the adapter creates the GitHub issue in the selected repository by using the stored machine-user credential
- **THEN** the adapter associates the issue with the workspace's GitHub Project so the orchestrator can observe it through the tracker adapter contract

#### Scenario: Repository outside workspace scope
- **WHEN** the operator attempts to create a GitHub-backed work item for a repository that is not linked to the workspace
- **THEN** the adapter rejects the request
- **THEN** no GitHub issue is created

### Requirement: GitHub Projects adapter SHALL remain outside core workflow semantics
The system SHALL keep GitHub Project field mapping, GitHub issue normalization, and GitHub mutation tooling inside the GitHub extension boundary so that core Symphony scheduling, workspace lifecycle, and runtime behavior do not depend on GitHub-specific identifiers or status field assumptions.

#### Scenario: Core orchestration reads normalized GitHub issues
- **WHEN** the GitHub Project extension returns actionable work to the orchestrator
- **THEN** it provides the issue through the normalized core tracker contract
- **THEN** the orchestrator makes dispatch and reconciliation decisions without depending on raw GitHub Project payload shapes
