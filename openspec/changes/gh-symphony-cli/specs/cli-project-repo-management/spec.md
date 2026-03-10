## ADDED Requirements

### Requirement: Project list SHALL display configured projects

The system SHALL display all workspaces with their associated GitHub Project names, active repository counts, and which workspace is currently active.

#### Scenario: List with multiple workspaces
- **WHEN** the user runs `gh-symphony project list` with multiple workspaces configured
- **THEN** the system displays each workspace with its project title, repository count, and active/inactive marker

### Requirement: Project switch SHALL change the active workspace

The system SHALL present configured workspaces for selection and update the active workspace reference in `config.json`.

#### Scenario: Interactive project switch
- **WHEN** the user runs `gh-symphony project switch`
- **THEN** the system presents all configured workspaces as a selection list
- **THEN** upon selection, it updates `config.json` `activeWorkspace` to the chosen workspace ID

#### Scenario: Switch while orchestrator is running
- **WHEN** the user runs `gh-symphony project switch` while the daemon is running
- **THEN** the system warns that the running orchestrator will continue using its current workspace
- **THEN** the system advises restarting the orchestrator to apply the switch

### Requirement: Project status SHALL display board-level overview

The system SHALL query the GitHub Project and cross-reference with orchestrator state to display per-status-column counts, active worker assignments, and Symphony processing statistics.

#### Scenario: Board overview display
- **WHEN** the user runs `gh-symphony project status`
- **THEN** the system displays a table with each project status column, total issue count, Symphony-labeled issue count, and active worker count

### Requirement: Repo list SHALL display managed repositories

The system SHALL list all repositories in the active workspace with their enabled/disabled status.

#### Scenario: List repositories
- **WHEN** the user runs `gh-symphony repo list`
- **THEN** the system displays each repository with owner/name and active/disabled status

### Requirement: Repo add SHALL enable a repository for orchestration

The system SHALL validate that the repository exists and is accessible with the configured PAT, add it to the active workspace's repository list, and confirm the addition.

#### Scenario: Add a valid repository
- **WHEN** the user runs `gh-symphony repo add owner/repo` with a valid, accessible repository
- **THEN** the system validates the repository via GitHub API
- **THEN** the system adds it to the workspace configuration
- **THEN** the system confirms the repository will be included in the next poll cycle

#### Scenario: Add an inaccessible repository
- **WHEN** the user runs `gh-symphony repo add owner/repo` and the PAT lacks access to that repository
- **THEN** the system displays an access error and does not modify the workspace configuration

### Requirement: Repo remove SHALL disable a repository

The system SHALL remove a repository from the active workspace's managed list, warn if active workers exist for that repository, and confirm the removal.

#### Scenario: Remove with active workers
- **WHEN** the user runs `gh-symphony repo remove owner/repo` and there are active workers for issues in that repository
- **THEN** the system warns about active workers and asks for confirmation before proceeding

#### Scenario: Remove without active workers
- **WHEN** the user runs `gh-symphony repo remove owner/repo` with no active workers
- **THEN** the system removes the repository from the configuration and confirms

### Requirement: Config show SHALL display current settings

The system SHALL display all configuration values with sensitive values (tokens) masked.

#### Scenario: Show configuration
- **WHEN** the user runs `gh-symphony config show`
- **THEN** the system displays all settings including poll interval, concurrency, runtime, and active workspace
- **THEN** the GitHub token is displayed in masked form (e.g., `ghp_****xxxx`)

### Requirement: Config set SHALL update individual settings

The system SHALL validate and persist individual configuration changes.

#### Scenario: Set poll interval
- **WHEN** the user runs `gh-symphony config set poll-interval 60s`
- **THEN** the system validates the duration format
- **THEN** the system updates the configuration and confirms the change

#### Scenario: Set invalid value
- **WHEN** the user runs `gh-symphony config set concurrency abc`
- **THEN** the system displays a validation error explaining the expected format
