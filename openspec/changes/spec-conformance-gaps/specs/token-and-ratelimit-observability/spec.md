## ADDED Requirements

### Requirement: Worker SHALL track and report token usage from codex sessions

The worker SHALL extract token usage data from codex app-server events during each turn. The worker SHALL prefer absolute thread-total token payloads (such as `thread/tokenUsage/updated` or `total_token_usage`) over delta-style payloads. Upon worker exit, the worker SHALL persist the final token counts (input_tokens, output_tokens, total_tokens) in the run state record.

#### Scenario: Token usage extracted from codex events

- **WHEN** the codex process emits a token usage event during a turn
- **THEN** the worker updates its in-memory token counters for the current session
- **THEN** the worker state server exposes the current token counts via its state API

#### Scenario: Final token counts persisted on worker exit

- **WHEN** a worker exits after completing one or more turns
- **THEN** the run state record includes the final cumulative token counts for that run
- **THEN** the orchestrator can aggregate these counts across runs

#### Scenario: Delta payloads are ignored for totals

- **WHEN** the codex process emits a delta-style token usage payload (such as `last_token_usage`)
- **THEN** the worker does not add it to cumulative totals
- **THEN** the worker relies only on absolute thread-total payloads for dashboard and API reporting

### Requirement: Orchestrator SHALL aggregate token totals across runs

The orchestrator SHALL maintain cumulative token totals (input_tokens, output_tokens, total_tokens) and aggregate runtime seconds across all completed and active runs. When a run completes, the orchestrator SHALL add the run's token counts and duration to the cumulative totals. The orchestrator SHALL expose these aggregates in the status API response.

#### Scenario: Token totals accumulate across runs

- **WHEN** multiple worker runs complete with token usage data
- **THEN** the orchestrator sums token counts across all completed runs into cumulative codex_totals
- **THEN** the status API response includes the aggregate totals

#### Scenario: Runtime seconds include active sessions

- **WHEN** an operator requests a status snapshot while runs are active
- **THEN** the seconds_running total includes elapsed time from active runs computed at snapshot time plus cumulative seconds from completed runs

### Requirement: Orchestrator SHALL track the latest rate-limit snapshot

The orchestrator SHALL track the most recent rate-limit payload received from any codex agent event and expose it in the status API. If no rate-limit data has been received, the field SHALL be null.

#### Scenario: Rate limit data surfaced in status API

- **WHEN** a codex session emits rate-limit information
- **THEN** the orchestrator stores the latest rate-limit payload
- **THEN** the status API includes the rate_limits field with the most recent data

#### Scenario: No rate-limit data returns null

- **WHEN** no codex session has emitted rate-limit information
- **THEN** the status API returns `rate_limits: null`

### Requirement: Structured events SHALL include issue_id and session_id fields

All structured orchestrator events related to issue execution SHALL include `issueId` (the stable tracker-internal ID) in addition to the existing `issueIdentifier`. Events related to active codex sessions SHALL additionally include `sessionId` (formatted as `<threadId>-<turnId>`).

#### Scenario: Dispatch event includes issueId

- **WHEN** the orchestrator emits a run-dispatched event
- **THEN** the event payload includes both `issueId` and `issueIdentifier` fields

#### Scenario: Session-related event includes sessionId

- **WHEN** a worker or orchestrator emits an event related to an active codex session
- **THEN** the event payload includes `sessionId` in the format `<threadId>-<turnId>`
