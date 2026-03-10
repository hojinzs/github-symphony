## ADDED Requirements

### Requirement: Orchestrator SHALL sort dispatch candidates by priority, age, and identifier

The orchestrator SHALL sort dispatch-eligible issues in the following order before selecting which to dispatch: priority ascending (lower number = higher priority; null/unknown sorts last), then created_at oldest first, then identifier lexicographic ascending as tie-breaker. This ensures deterministic, priority-respecting dispatch order.

#### Scenario: Higher priority issue dispatches first

- **WHEN** the orchestrator evaluates two actionable issues where issue A has priority 1 and issue B has priority 3
- **THEN** the orchestrator dispatches issue A before issue B regardless of creation time

#### Scenario: Null priority sorts after numbered priorities

- **WHEN** the orchestrator evaluates two actionable issues where issue A has priority 2 and issue B has priority null
- **THEN** the orchestrator dispatches issue A before issue B

#### Scenario: Same priority resolves by creation time

- **WHEN** the orchestrator evaluates two actionable issues with equal priority where issue A was created before issue B
- **THEN** the orchestrator dispatches issue A before issue B

#### Scenario: Same priority and creation time resolves by identifier

- **WHEN** the orchestrator evaluates two actionable issues with equal priority and equal creation time where issue A has identifier "ABC-1" and issue B has identifier "ABC-2"
- **THEN** the orchestrator dispatches issue A before issue B

### Requirement: Orchestrator SHALL enforce per-state concurrency limits

The orchestrator SHALL support an optional `maxConcurrentByPhase` configuration map that limits the number of concurrent active runs per workflow execution phase. When a phase-specific limit is configured, dispatch for that phase SHALL NOT exceed the phase limit even if global concurrency slots remain available. Phase keys SHALL be normalized (trim + lowercase) for lookup. Invalid entries (non-positive or non-numeric) SHALL be ignored.

#### Scenario: Phase limit prevents over-dispatch

- **WHEN** the workflow configuration sets `maxConcurrentByPhase.planning = 2` and 2 planning runs are already active
- **THEN** the orchestrator does not dispatch additional planning-phase issues even if global slots are available
- **THEN** issues in other phases with available slots can still be dispatched

#### Scenario: No phase limit falls back to global limit

- **WHEN** a workflow execution phase has no entry in `maxConcurrentByPhase`
- **THEN** that phase is limited only by the global `concurrency` setting

#### Scenario: Phase limit changes at runtime

- **WHEN** a workflow reload changes a phase concurrency limit
- **THEN** the orchestrator applies the new limit to future dispatch ticks without restart

### Requirement: Orchestrator SHALL block dispatch for planning issues with non-terminal blockers

The orchestrator SHALL NOT dispatch an issue in the planning phase when any entry in its `blockedBy` list references an issue that is not in a terminal workflow state. When all blockers are terminal (or the `blockedBy` list is empty), the issue is eligible for dispatch.

#### Scenario: Planning issue with active blocker is held

- **WHEN** a planning-phase issue has a `blockedBy` entry referencing an issue in a non-terminal state
- **THEN** the orchestrator skips that issue during dispatch
- **THEN** it remains eligible for dispatch on a future tick if the blocker resolves

#### Scenario: Planning issue with all terminal blockers is eligible

- **WHEN** a planning-phase issue has `blockedBy` entries that all reference issues in terminal states
- **THEN** the orchestrator treats the issue as dispatch-eligible

#### Scenario: Empty blockedBy list does not block dispatch

- **WHEN** a planning-phase issue has an empty `blockedBy` array
- **THEN** the orchestrator treats the issue as dispatch-eligible based on other eligibility rules
