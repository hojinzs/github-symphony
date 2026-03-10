## ADDED Requirements

### Requirement: Start SHALL launch the orchestrator in foreground or daemon mode

The system SHALL start the `OrchestratorService` using the active workspace configuration. In foreground mode, it SHALL display a live log stream. In daemon mode, it SHALL write a PID file and detach from the terminal.

#### Scenario: Foreground start
- **WHEN** the user runs `gh-symphony start` without the `--daemon` flag
- **THEN** the system starts the orchestrator in the foreground
- **THEN** it displays a startup banner with project name, active repos, poll interval, and status API URL
- **THEN** it streams structured log lines to stdout until the user presses Ctrl+C

#### Scenario: Daemon start
- **WHEN** the user runs `gh-symphony start --daemon`
- **THEN** the system starts the orchestrator as a detached background process
- **THEN** it writes the process PID to `~/.gh-symphony/daemon.pid`
- **THEN** it writes logs to `~/.gh-symphony/logs/orchestrator.log`
- **THEN** it displays the PID and log file path, then exits

#### Scenario: Start when already running
- **WHEN** the user runs `gh-symphony start` while a daemon is already running (valid PID file and live process)
- **THEN** the system displays a message that the orchestrator is already running with its PID
- **THEN** the system does not start a second instance

#### Scenario: Start without init
- **WHEN** the user runs `gh-symphony start` before running `gh-symphony init`
- **THEN** the system exits with code 2 and a message to run `gh-symphony init` first

### Requirement: Stop SHALL terminate the daemon gracefully

The system SHALL send a termination signal to the running daemon process, wait for active workers to complete (graceful) or force-kill immediately (force), and clean up the PID file.

#### Scenario: Graceful stop
- **WHEN** the user runs `gh-symphony stop`
- **THEN** the system sends SIGTERM to the daemon process
- **THEN** the orchestrator stops accepting new dispatches and waits for active workers to complete
- **THEN** the PID file is removed after the process exits

#### Scenario: Force stop
- **WHEN** the user runs `gh-symphony stop --force`
- **THEN** the system sends SIGKILL to the daemon process and all child worker processes
- **THEN** the PID file is removed immediately

#### Scenario: Stop when not running
- **WHEN** the user runs `gh-symphony stop` and no daemon is running
- **THEN** the system displays a message that no orchestrator is running

### Requirement: Status SHALL display current orchestration state

The system SHALL query the orchestrator state (from filesystem or status API) and display a formatted table of active issues, their phases, worker states, and aggregate statistics.

#### Scenario: Status with active workers
- **WHEN** the user runs `gh-symphony status` while the orchestrator has active runs
- **THEN** the system displays a table with columns: issue identifier, phase, worker status, and additional info
- **THEN** it displays aggregate counts: active workers, concurrency limit, total runs

#### Scenario: Status with watch mode
- **WHEN** the user runs `gh-symphony status --watch`
- **THEN** the system refreshes the status display every 2 seconds until interrupted

#### Scenario: Status in JSON format
- **WHEN** the user runs `gh-symphony status --json`
- **THEN** the system outputs the raw status snapshot as JSON to stdout

### Requirement: Run SHALL dispatch a single issue immediately

The system SHALL accept an issue identifier (`owner/repo#number`), validate it against the workspace configuration, and dispatch a worker for that specific issue.

#### Scenario: Successful single-issue dispatch
- **WHEN** the user runs `gh-symphony run owner/repo#42`
- **THEN** the system dispatches a worker for the specified issue
- **THEN** it displays the assigned branch, phase, and worker PID

#### Scenario: Run with watch mode
- **WHEN** the user runs `gh-symphony run owner/repo#42 --watch`
- **THEN** the system streams the worker's progress in real-time until completion
- **THEN** it displays the final outcome (PR created, error, etc.)

#### Scenario: Issue not in managed repository
- **WHEN** the user specifies an issue from a repository not in the active workspace
- **THEN** the system exits with an error identifying the repository as unmanaged

### Requirement: Recover SHALL detect and restart stalled runs

The system SHALL scan for runs whose workers have died, exceeded the stuck timeout, or have inconsistent state, and offer to restart them.

#### Scenario: Recovery with dry-run
- **WHEN** the user runs `gh-symphony recover --dry-run`
- **THEN** the system lists all stalled or stuck runs without taking action

#### Scenario: Recovery execution
- **WHEN** the user runs `gh-symphony recover` and stalled runs exist
- **THEN** the system prompts for confirmation before restarting each stalled run
- **THEN** it restarts confirmed runs and displays the new attempt number

### Requirement: Logs SHALL display orchestration and worker logs

The system SHALL read log files and event streams, supporting filtering by issue, run, and log level, with optional real-time follow mode.

#### Scenario: Follow logs in real-time
- **WHEN** the user runs `gh-symphony logs --follow`
- **THEN** the system tails the orchestrator log file and displays new entries as they arrive

#### Scenario: Filter logs by issue
- **WHEN** the user runs `gh-symphony logs --issue owner/repo#42`
- **THEN** the system displays only log entries and events related to the specified issue
