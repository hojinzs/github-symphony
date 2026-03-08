## ADDED Requirements

### Requirement: Symphony core SHALL use the specification workflow contract
The system SHALL treat repository-owned `WORKFLOW.md` as the canonical workflow contract by parsing YAML front matter into typed runtime configuration, treating the Markdown body as the prompt template, and reloading changed workflow configuration for future dispatch and execution decisions without requiring a service restart.

#### Scenario: Repository workflow changes are re-applied
- **WHEN** a repository's `WORKFLOW.md` changes after the orchestrator has already started
- **THEN** Symphony reloads the updated workflow definition before future dispatch, retry, hook, and runtime-launch decisions
- **THEN** already-running sessions may continue under their existing configuration until they exit

#### Scenario: Invalid workflow reload preserves prior good state
- **WHEN** Symphony detects a changed `WORKFLOW.md` that fails schema or parsing validation
- **THEN** Symphony keeps using the last known valid workflow definition for future scheduling decisions
- **THEN** Symphony emits an operator-visible validation error instead of replacing the effective configuration with invalid state

### Requirement: Symphony core SHALL manage persistent per-issue workspaces
The system SHALL derive a canonical workspace path from the sanitized issue identifier, keep that workspace under the configured workspace root, reuse it across retries and continuation runs for the same issue, and execute configured workspace hooks according to the Symphony lifecycle contract.

#### Scenario: Retry reuses the existing issue workspace
- **WHEN** an issue run fails and is scheduled for retry
- **THEN** the next attempt uses the same per-issue workspace path instead of creating a new run-scoped checkout
- **THEN** the worker can continue from the filesystem state preserved in that issue workspace

#### Scenario: Terminal issue cleanup removes the issue workspace
- **WHEN** an issue enters a workflow-defined terminal state during startup cleanup or active reconciliation
- **THEN** Symphony runs the configured `before_remove` hook if present
- **THEN** Symphony removes the issue workspace while preserving orchestration logs and run records outside that workspace

### Requirement: Symphony core SHALL own prompt rendering and app-server session lifecycle
The system SHALL render the issue prompt from the workflow prompt template and runtime variables, start an app-server session in the issue workspace, drive thread and turn lifecycle according to the Symphony execution contract, and use continuation plus retry semantics to decide whether to resume work after a worker exit.

#### Scenario: First run uses the full issue prompt
- **WHEN** Symphony starts the first execution attempt for an actionable issue
- **THEN** it renders the prompt template with the normalized issue payload and `attempt = null`
- **THEN** it starts an app-server thread and turn for that prompt in the issue workspace

#### Scenario: Continuation run resumes an active issue
- **WHEN** a worker exits normally after exhausting its in-process turn loop while the issue remains actionable
- **THEN** the orchestrator schedules a short continuation retry for that issue
- **THEN** the next worker session continues the issue on the same workspace instead of treating it as a brand-new dispatch

### Requirement: Symphony core SHALL expose spec-level orchestration observability
The system SHALL expose structured logs and a machine-readable runtime snapshot that reports running sessions, retry queue state, aggregate runtime totals, and operator-visible failure information in a form consistent with the Symphony specification.

#### Scenario: Snapshot reports active and retrying work
- **WHEN** an operator or extension requests the current Symphony state snapshot
- **THEN** the response includes active issue execution rows, retry queue rows, and aggregate status fields derived from orchestrator-owned state
- **THEN** consumers do not need to inspect internal implementation files to determine orchestration health
