## ADDED Requirements

### Requirement: Worker planning SHALL hand work off for human approval
The system SHALL execute newly submitted work in a planning phase before implementation, publish the resulting plan or root-cause analysis to the GitHub issue as a comment, and transition the tracked item into a human-review handoff state.

#### Scenario: Planning run produces an approval handoff
- **WHEN** a tracked issue enters a workflow-defined planning-active state
- **THEN** the worker starts a planning run for that issue
- **THEN** the agent posts a GitHub issue comment containing the plan or root-cause analysis
- **THEN** the agent updates the tracked item to the workflow-defined human-review state

### Requirement: Human approval SHALL gate implementation
The system SHALL begin implementation only after a human moves the tracked item from the human-review handoff state into a workflow-defined implementation-active state.

#### Scenario: Approved issue resumes for implementation
- **WHEN** a human changes a tracked item from the human-review state to the implementation-active state
- **THEN** the worker treats the issue as actionable again
- **THEN** the worker starts a new implementation run for the same issue instead of reusing the prior planning run

### Requirement: Implementation runs SHALL report delivery through a pull request
The system SHALL have the agent create or update a pull request for implemented work and publish a completion report to the issue before moving the tracked item into an awaiting-merge handoff state.

#### Scenario: Implementation run produces a PR handoff
- **WHEN** an implementation run finishes with code changes ready for review
- **THEN** the agent pushes a branch for the issue
- **THEN** the agent creates or updates a pull request linked to the issue
- **THEN** the agent posts a GitHub issue comment containing the pull request URL and delivery summary
- **THEN** the agent updates the tracked item to the workflow-defined awaiting-merge state

### Requirement: Merged pull requests SHALL complete tracked work
The system SHALL complete tracked work after the linked pull request is merged by relying on GitHub-native issue closure and project completion signals or an explicitly configured equivalent reconciliation path.

#### Scenario: Linked PR merge completes the issue
- **WHEN** the pull request linked to a tracked issue is merged
- **THEN** the linked issue becomes closed through the configured completion mechanism
- **THEN** the tracked project item transitions to the completed state
- **THEN** the worker no longer treats the issue as actionable
