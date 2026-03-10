## ADDED Requirements

### Requirement: Worker SHALL execute multiple turns within a single run

The worker SHALL support multi-turn execution within a single worker process lifetime. After a successful turn completion, the worker SHALL re-check the issue's tracker state. If the issue remains in an actionable workflow state and the turn count has not reached `max_turns` (default 20), the worker SHALL start a continuation turn on the same codex thread. The first turn SHALL use the full rendered prompt. Continuation turns SHALL send only continuation guidance to the existing thread. When max_turns is reached or the issue is no longer actionable, the worker SHALL stop the codex session and exit normally.

#### Scenario: Worker continues after first turn when issue is still active

- **WHEN** a worker's first turn completes successfully and the tracker confirms the issue is still in an actionable state
- **THEN** the worker starts a continuation turn on the same codex thread with continuation guidance instead of the original prompt
- **THEN** the worker does not exit between turns

#### Scenario: Worker stops at max_turns

- **WHEN** a worker has completed the configured max_turns number of turns
- **THEN** the worker stops the codex session and exits normally regardless of issue state
- **THEN** the orchestrator may schedule a continuation retry for the issue

#### Scenario: Worker stops when issue becomes non-actionable between turns

- **WHEN** a worker completes a turn and re-checks the tracker state to find the issue is no longer actionable
- **THEN** the worker stops the codex session and exits normally
- **THEN** no further turns are started for that issue in this worker run

#### Scenario: Tracker state refresh failure during turn loop terminates the worker

- **WHEN** a worker fails to refresh the issue state from the tracker between turns
- **THEN** the worker stops the codex session and exits with an error
- **THEN** the orchestrator handles the failure through its normal retry mechanism

### Requirement: Worker SHALL enforce read timeout on codex protocol requests

The worker SHALL enforce a configurable `read_timeout_ms` (default 5000ms) on synchronous codex protocol requests (initialize, thread/start, turn/start). If a response is not received within the timeout, the worker SHALL terminate the codex process and fail the current run attempt.

#### Scenario: Initialize response times out

- **WHEN** the codex process does not respond to the initialize request within read_timeout_ms
- **THEN** the worker terminates the codex process and exits with a response_timeout error
- **THEN** the orchestrator schedules a failure retry

#### Scenario: Thread start response times out

- **WHEN** the codex process does not respond to thread/start within read_timeout_ms
- **THEN** the worker terminates the codex process and exits with a response_timeout error

### Requirement: Worker SHALL enforce turn timeout on active turns

The worker SHALL enforce a configurable `turn_timeout_ms` (default 3600000ms / 1 hour) on each active turn. The timeout starts when turn/start is sent and ends when turn/completed, turn/failed, or turn/cancelled is received. If the turn does not complete within the timeout, the worker SHALL terminate the codex process and fail the current run attempt with a turn_timeout error.

#### Scenario: Turn exceeds timeout

- **WHEN** a codex turn has been running for longer than turn_timeout_ms without completing
- **THEN** the worker terminates the codex process
- **THEN** the worker exits with a turn_timeout error
- **THEN** the orchestrator handles the failure through its normal retry mechanism

#### Scenario: Turn completes within timeout

- **WHEN** a codex turn completes before turn_timeout_ms elapses
- **THEN** the timeout timer is cancelled
- **THEN** the worker proceeds normally (either to the next turn or to exit)

### Requirement: Worker SHALL treat user input requests as hard failure

The worker SHALL detect user_input_required signals from the codex session, including explicit `item/tool/requestUserInput` method calls and turn methods or flags indicating input is required. Upon detection, the worker SHALL immediately terminate the codex session and exit with a `turn_input_required` error. The worker SHALL NOT attempt to satisfy or prompt for user input.

#### Scenario: Codex requests user input during turn

- **WHEN** the codex process emits a user_input_required signal during an active turn
- **THEN** the worker terminates the codex process immediately
- **THEN** the worker exits with a turn_input_required error
- **THEN** the orchestrator treats this as a run failure and applies its retry policy

#### Scenario: Approval policy prevents most input requests

- **WHEN** the worker starts a codex session with approvalPolicy set to auto-approve
- **THEN** standard approval requests are handled automatically without triggering the user_input_required path
- **THEN** only unexpected input requests that bypass approval policy trigger hard failure
