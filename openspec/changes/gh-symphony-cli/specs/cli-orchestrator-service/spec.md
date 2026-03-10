## MODIFIED Requirements

### Requirement: Orchestrator SHALL expose CLI execution modes

The system SHALL provide CLI commands for long-running orchestration, a single reconciliation tick, targeted workspace dispatch, targeted issue dispatch, recovery, and status inspection. The `gh-symphony` CLI SHALL wrap these execution modes, constructing `OrchestratorService` instances from `~/.gh-symphony/` configuration and translating simplified CLI commands into orchestrator operations.

#### Scenario: Run-once reconciliation

- **WHEN** an operator runs the orchestrator in single-tick mode
- **THEN** the orchestrator performs one polling and reconciliation cycle for the requested scope
- **THEN** it exits with status output that identifies any dispatched, skipped, or failed runs

#### Scenario: Targeted issue dispatch

- **WHEN** an operator runs the orchestrator for a specific workspace and issue
- **THEN** the orchestrator evaluates only that issue against the workspace workflow rules
- **THEN** it either launches the assigned worker run or reports why the issue is not actionable

#### Scenario: CLI wrapper invokes orchestrator service

- **WHEN** the user runs `gh-symphony start`, `gh-symphony run`, or `gh-symphony recover`
- **THEN** the CLI loads workspace configuration from `~/.gh-symphony/workspaces/<activeWorkspace>/`
- **THEN** it constructs an `OrchestratorFsStore` pointing to the workspace runtime directory
- **THEN** it instantiates `OrchestratorService` with the loaded configuration
- **THEN** it delegates to the appropriate orchestrator execution mode

### Requirement: Orchestrator SHALL run independently of the control plane

The system SHALL provide a Symphony orchestrator process that can poll configured trackers, dispatch worker runs, reconcile active execution, and recover after restart without requiring the control-plane web application to be running. The `gh-symphony` CLI SHALL provide an alternative to control-plane-driven workspace provisioning by generating workspace configuration through the interactive `init` wizard.

#### Scenario: Headless orchestrator startup

- **WHEN** an operator starts the orchestrator from the CLI on a machine that has access to workspace metadata, tracker credentials, and the local runtime directory
- **THEN** the orchestrator begins polling configured workspaces without requiring any control-plane UI session
- **THEN** workspace dispatch decisions continue while the control plane is unavailable

#### Scenario: CLI-provisioned workspace startup

- **WHEN** a user runs `gh-symphony init` followed by `gh-symphony start`
- **THEN** the orchestrator starts using the CLI-generated workspace configuration
- **THEN** no control-plane database or web server is required
