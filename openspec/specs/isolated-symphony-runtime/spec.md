# isolated-symphony-runtime Specification

## Purpose

Define the isolated runtime contract for assigned issue execution, including brokered credentials, repository-owned workflow semantics, and workspace-scoped runtime isolation.

## Requirements

### Requirement: Runtime SHALL resolve agent credentials before starting Codex

The system SHALL resolve the effective agent credential for an assigned workspace run through a control-plane broker before spawning `codex app-server`, and SHALL translate the broker response into the runtime environment contract required by the agent process.

#### Scenario: Runtime starts Codex with the platform default credential

- **WHEN** a worker runtime launches an assigned issue execution for a workspace that inherits the platform default credential
- **THEN** the worker authenticates to the control-plane broker with its workspace-scoped runtime secret before process start
- **THEN** the worker launches `codex app-server` with the brokered agent authentication environment for that assigned run

#### Scenario: Runtime starts Codex with a workspace override credential

- **WHEN** a worker runtime launches an assigned issue execution for a workspace that uses a workspace-specific override credential
- **THEN** the worker resolves that workspace's override through the control-plane broker before process start
- **THEN** the worker launches `codex app-server` with the brokered authentication environment for that assigned run

#### Scenario: Agent credential resolution fails

- **WHEN** the worker cannot resolve a valid effective agent credential for the workspace before launch
- **THEN** the worker does not start `codex app-server` for that run
- **THEN** the assigned run is marked degraded or failed with an operator-visible recovery state

### Requirement: Each workspace SHALL run in an isolated Symphony container

The system SHALL ensure that each assigned issue run executes in a runtime isolated to its workspace and issue context, while still preserving the issue-scoped workspace filesystem across retries and continuation runs for that issue so workflow configuration, credentials, and repository state are isolated across workspaces but durable within an issue lifecycle.

#### Scenario: Dedicated runtime allocation

- **WHEN** the orchestrator dispatches a new issue run for a workspace
- **THEN** it launches a worker runtime dedicated to that workspace and assigned issue context only
- **THEN** the worker runtime receives only the workflow configuration and broker access needed for that workspace's GitHub and agent credentials

#### Scenario: Separate workspace execution

- **WHEN** two workspaces are active at the same time
- **THEN** work performed for one workspace does not reuse the other workspace's runtime, workflow files, repository checkout, or effective agent credential binding
- **THEN** credential issuance for one workspace does not expose reusable long-lived credentials for the other workspace

#### Scenario: Retry preserves issue workspace state

- **WHEN** the same issue is retried or continued after a prior worker session exits
- **THEN** the new worker runtime attaches to the same issue-scoped workspace filesystem
- **THEN** it does not require a brand-new repository checkout to continue execution

### Requirement: The runtime SHALL launch Codex through the native Symphony execution model

The system SHALL start the agent runtime for an assigned issue run by launching `codex app-server` as a subprocess inside the Symphony worker, SHALL communicate with it using the standard Symphony app-server interface, SHALL render prompt input before starting work, and SHALL capture runtime session state needed for reconciliation, retry, and observability through a stable minimal session snapshot.

#### Scenario: Worker startup

- **WHEN** the orchestrator assigns a Symphony worker to process an issue for a workspace
- **THEN** the worker resolves the brokered runtime authentication environment required for that workspace
- **THEN** it launches `codex app-server` through the configured worker command in the issue workspace
- **THEN** Symphony communicates with the agent over the expected subprocess interface without an additional protocol bridge

#### Scenario: Worker reports session state

- **WHEN** a worker is running an assigned issue session
- **THEN** it reports machine-readable runtime state that identifies the assigned run, current status, retry kind, and session-level failure or progress details
- **THEN** the orchestrator can use that state for status surfaces and reconciliation decisions

#### Scenario: Transport detail stays outside the stable core contract

- **WHEN** the worker exchanges detailed app-server events or transport frames during execution
- **THEN** those raw protocol details may be logged or persisted outside the core snapshot
- **THEN** the canonical runtime state exposed to orchestrator consumers remains the stable minimal session snapshot

### Requirement: Workflow artifacts SHALL describe phase-aware execution states

The system SHALL load workflow semantics from the assigned repository's `WORKFLOW.md`, and that workflow file SHALL define tracker states, runtime settings, and hook configuration required for planning, human review, implementation, awaiting merge, completion, and runtime lifecycle decisions so the orchestrator and worker do not depend on hard-coded GitHub-first defaults. Running sessions keep the launch-time workflow snapshot, while future launches and hook executions use the latest valid workflow definition.

#### Scenario: Repository workflow includes lifecycle states and runtime config

- **WHEN** the worker prepares a repository for an assigned issue run
- **THEN** it reads `WORKFLOW.md` from that repository to identify phase states, runtime behavior, and workspace lifecycle hooks
- **THEN** the orchestrator and worker use that workflow definition to decide how the issue should progress and how the runtime should behave
