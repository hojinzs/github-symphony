## MODIFIED Requirements

### Requirement: Orchestrator SHALL coordinate worker assignment and reconciliation
The system SHALL act as the authoritative Symphony coordinator by selecting actionable issues from the active tracker adapter, loading workflow semantics from the assigned repository's `WORKFLOW.md`, ensuring that at most one active issue-phase lease exists for a canonical workspace issue subject, launching a worker against the persistent issue workspace, and reconciling completion, retry, suppression, stall, or terminal cleanup into the next orchestration action.

#### Scenario: Duplicate planning run is prevented
- **WHEN** the tracker still shows a planning-active issue that already has a live planning run lease for the same workspace
- **THEN** the orchestrator does not launch a second planning run for that issue phase
- **THEN** it keeps observing the existing run until completion, failure, suppression, or recovery

#### Scenario: Terminal transition cleans up active work
- **WHEN** an actively leased issue transitions into a workflow-defined terminal state
- **THEN** the orchestrator stops the running worker for that issue if one exists
- **THEN** it releases the issue-phase lease and triggers terminal workspace cleanup according to the configured lifecycle hooks

### Requirement: Orchestrator SHALL poll and reconcile on a bounded cadence
The system SHALL poll tracker adapters and reconcile active runs on a fixed configurable cadence derived from the effective workflow configuration, SHALL re-apply updated workflow polling settings to future ticks without restart, and SHALL enforce bounded concurrency so that active dispatch never exceeds the configured orchestrator or workflow limits.

#### Scenario: Poll tick respects concurrency limits
- **WHEN** a polling tick discovers more actionable issues than the configured concurrency limit allows
- **THEN** the orchestrator dispatches only up to the configured limit of new runs
- **THEN** the remaining actionable issues stay pending until a later reconciliation tick

#### Scenario: Workflow poll interval changes at runtime
- **WHEN** a repository workflow update changes the configured polling interval
- **THEN** the orchestrator uses the new interval for future poll scheduling
- **THEN** a service restart is not required to apply the new cadence

### Requirement: Orchestrator SHALL apply retry backoff to failed runs
The system SHALL apply Symphony retry semantics by distinguishing continuation retry after normal worker exit, exponential-backoff failure retry after retryable errors, and recovery retry after crash, heartbeat loss, or stall recovery, and SHALL release or fail the claim when the issue is no longer eligible or retry policy is exhausted.

#### Scenario: Transient launch failure backs off
- **WHEN** a worker launch attempt fails with a retryable error
- **THEN** the orchestrator records the failed attempt in local run state
- **THEN** it delays the next retry according to the configured exponential backoff policy before attempting the run again

#### Scenario: Normal worker exit schedules continuation
- **WHEN** a worker exits normally after completing its current session while the issue remains actionable
- **THEN** the orchestrator records a continuation retry for that issue
- **THEN** it re-checks the issue on the next continuation attempt before relaunching work

#### Scenario: Recovery path is tracked separately from failure retry
- **WHEN** the orchestrator detects a worker crash, lost heartbeat, or stall for an otherwise actionable issue
- **THEN** it records a recovery retry instead of a failure retry
- **THEN** status surfaces distinguish that degraded recovery path from normal continuation and retryable launch failure

### Requirement: Orchestrator SHALL expose a status API for optional extensions
The system SHALL expose a machine-readable Symphony status API for optional extensions, including a spec-aligned state snapshot endpoint and workspace-scoped inspection endpoints, so that extensions can observe orchestration state without depending on internal filesystem layout.

#### Scenario: Extension reads current Symphony state
- **WHEN** the control plane or another optional extension needs the latest orchestration state
- **THEN** it queries the orchestrator status API
- **THEN** it receives a machine-readable snapshot derived from authoritative orchestrator state rather than from internal files

#### Scenario: Status API surfaces cleanup and handoff blockers
- **WHEN** the orchestrator encounters a blocked cleanup or extension-verified handoff failure
- **THEN** the status API includes an operator-visible failure classification for that issue workspace
- **THEN** extensions can surface the blocker without reading implementation logs directly
