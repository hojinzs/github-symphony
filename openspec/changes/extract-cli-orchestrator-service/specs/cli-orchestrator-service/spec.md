## ADDED Requirements

### Requirement: Orchestrator SHALL run independently of the control plane
The system SHALL provide a Symphony orchestrator process that can poll configured trackers, dispatch worker runs, reconcile active execution, and recover after restart without requiring the control-plane web application to be running.

#### Scenario: Headless orchestrator startup
- **WHEN** an operator starts the orchestrator from the CLI on a machine that has access to workspace metadata, tracker credentials, and the local runtime directory
- **THEN** the orchestrator begins polling configured workspaces without requiring any control-plane UI session
- **THEN** workspace dispatch decisions continue while the control plane is unavailable

### Requirement: Orchestrator SHALL expose CLI execution modes
The system SHALL provide CLI commands for long-running orchestration, a single reconciliation tick, targeted workspace dispatch, targeted issue dispatch, recovery, and status inspection.

#### Scenario: Run-once reconciliation
- **WHEN** an operator runs the orchestrator in single-tick mode
- **THEN** the orchestrator performs one polling and reconciliation cycle for the requested scope
- **THEN** it exits with status output that identifies any dispatched, skipped, or failed runs

#### Scenario: Targeted issue dispatch
- **WHEN** an operator runs the orchestrator for a specific workspace and issue
- **THEN** the orchestrator evaluates only that issue against the workspace workflow rules
- **THEN** it either launches the assigned worker run or reports why the issue is not actionable

### Requirement: Orchestrator SHALL recover from tracker state and local filesystem state
The system SHALL treat live tracker state plus local orchestration state files as sufficient inputs to reconstruct active leases, worker runs, and recovery actions after restart, and SHALL NOT require a persistent database for orchestration correctness.

#### Scenario: Restart after orchestrator crash
- **WHEN** the orchestrator starts after an unexpected process termination
- **THEN** it reloads local orchestration state from the runtime directory
- **THEN** it reconciles that local state against the current tracker state before launching, resuming, or abandoning worker runs

### Requirement: Orchestrator SHALL coordinate worker assignment and reconciliation
The system SHALL select actionable issues, ensure that at most one active run exists per issue phase within a workspace, launch the required worker runtime, and reconcile worker health or completion into the next orchestration action.

#### Scenario: Duplicate planning run is prevented
- **WHEN** the tracker still shows a planning-active issue that already has a live planning run lease for the same workspace
- **THEN** the orchestrator does not launch a second planning run for that issue phase
- **THEN** it keeps observing the existing run until completion, failure, or recovery

#### Scenario: Crashed worker is recovered
- **WHEN** a worker assigned to an active issue run exits unexpectedly before the run completes
- **THEN** the orchestrator marks the run for reconciliation
- **THEN** it either relaunches the run or leaves the issue unassigned with an operator-visible recovery state according to its recovery policy

### Requirement: Orchestrator SHALL poll and reconcile on a bounded cadence
The system SHALL poll tracker adapters and reconcile active runs on a fixed configurable cadence, and SHALL enforce bounded concurrency so that the number of simultaneously active runs does not exceed the configured limit for the orchestrator or workspace scope.

#### Scenario: Poll tick respects concurrency limits
- **WHEN** a polling tick discovers more actionable issues than the configured concurrency limit allows
- **THEN** the orchestrator dispatches only up to the configured limit of new runs
- **THEN** the remaining actionable issues stay pending until a later reconciliation tick

### Requirement: Orchestrator SHALL stop or suppress ineligible runs
The system SHALL stop starting new runs for an issue when the tracker state or workflow semantics make that issue ineligible, and SHALL reconcile already-running work when the issue becomes ineligible after dispatch.

#### Scenario: Active issue becomes ineligible
- **WHEN** an issue that already has an active run transitions into a non-actionable workflow state
- **THEN** the orchestrator marks the run for stop or suppression according to the configured recovery policy
- **THEN** it does not dispatch a replacement run for that issue while the non-actionable state remains

### Requirement: Orchestrator SHALL apply retry backoff to failed runs
The system SHALL apply bounded retry policy with backoff to transient orchestration and worker failures so that repeated failures do not cause tight dispatch loops.

#### Scenario: Transient launch failure backs off
- **WHEN** a worker launch attempt fails with a retryable error
- **THEN** the orchestrator records the failed attempt in local run state
- **THEN** it delays the next retry according to the configured backoff policy before attempting the run again

### Requirement: Orchestrator SHALL emit structured logs and status
The system SHALL emit structured logs and machine-readable status output for polling decisions, worker dispatch, recovery actions, and terminal run outcomes so operators and extensions can observe orchestration behavior without parsing ad hoc console text.

#### Scenario: Dispatch decision is logged
- **WHEN** the orchestrator evaluates an actionable issue during a reconciliation tick
- **THEN** it emits structured log data that identifies the workspace, issue, decision, and resulting run state
- **THEN** CLI status or status-surface consumers can retrieve the current machine-readable view of that run

### Requirement: Orchestrator SHALL reload workflow semantics from repository state
The system SHALL load workflow semantics from the repository's `WORKFLOW.md` when preparing an assigned run, and SHALL use the current file contents for each new run instead of relying on stale control-plane-generated workflow artifacts.

#### Scenario: Updated workflow file changes dispatch behavior
- **WHEN** a repository's `WORKFLOW.md` changes before the next run for a workspace issue is prepared
- **THEN** the orchestrator or worker reloads the updated workflow semantics for that run
- **THEN** dispatch and execution decisions follow the new workflow definition
