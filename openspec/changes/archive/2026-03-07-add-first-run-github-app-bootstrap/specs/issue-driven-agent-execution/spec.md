## MODIFIED Requirements

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
