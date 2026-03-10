## ADDED Requirements

### Requirement: Init SHALL authenticate and validate GitHub PAT

The system SHALL prompt the user for a GitHub Personal Access Token, validate it against the GitHub API, verify required scopes (`repo`, `project`, `read:org`), and display the authenticated user identity before proceeding.

#### Scenario: Valid PAT with sufficient scopes
- **WHEN** the user provides a PAT with `repo`, `project`, and `read:org` scopes
- **THEN** the system displays the authenticated username and confirms scope validation
- **THEN** the system proceeds to project selection

#### Scenario: PAT with insufficient scopes
- **WHEN** the user provides a PAT missing required scopes
- **THEN** the system displays which scopes are missing
- **THEN** the system prompts the user to create a new token with the required scopes and re-enter it

#### Scenario: Invalid or expired PAT
- **WHEN** the user provides a PAT that fails GitHub API authentication
- **THEN** the system displays an authentication error message
- **THEN** the system allows the user to re-enter a valid token

#### Scenario: PAT provided via --token flag
- **WHEN** the user passes `--token <token>` as a CLI argument
- **THEN** the system skips the interactive token prompt and validates the provided token directly

### Requirement: Init SHALL fetch and present GitHub Projects for selection

The system SHALL query the GitHub GraphQL API for the authenticated user's Projects (v2), display them with open item counts, and allow the user to select one project or enter a project URL manually.

#### Scenario: User selects from project list
- **WHEN** the user has one or more GitHub Projects
- **THEN** the system displays each project with its title and open item count
- **THEN** the user selects one project from the list

#### Scenario: User enters project URL manually
- **WHEN** the user chooses to enter a project URL instead of selecting from the list
- **THEN** the system accepts a GitHub Project URL, extracts the project identifier, and validates it via the API

#### Scenario: User has no GitHub Projects
- **WHEN** the authenticated user has no GitHub Projects
- **THEN** the system displays a message explaining that a GitHub Project is required
- **THEN** the system provides guidance on creating one

#### Scenario: Organization projects are included
- **WHEN** the user belongs to organizations with Projects
- **THEN** the system includes those organization Projects in the selection list alongside personal Projects

### Requirement: Init SHALL detect repositories linked to the selected project

The system SHALL query the selected GitHub Project for items with linked repositories, deduplicate the repository list, and present them as a multi-select checkbox for the user to choose which repositories Symphony should manage.

#### Scenario: Project has items with linked repositories
- **WHEN** the selected project contains items linked to repositories
- **THEN** the system lists each unique repository with the count of items from that repository
- **THEN** repositories with actionable items are pre-selected by default

#### Scenario: Project has no linked repositories
- **WHEN** the selected project contains no items with repository links
- **THEN** the system prompts the user to add repositories manually by entering `owner/repo` identifiers

### Requirement: Init SHALL guide workflow status mapping

The system SHALL fetch the status field options from the selected GitHub Project, guide the user through mapping statuses to Symphony workflow phases (trigger, working, human-review, done, ignored), and generate a `WorkflowLifecycleConfig`-compatible mapping.

#### Scenario: Interactive status mapping with smart defaults
- **WHEN** the project has status columns with recognizable names (e.g., "Todo", "In Progress", "Review", "Done")
- **THEN** the system pre-selects default mappings based on column name pattern matching
- **THEN** the user can accept defaults or override each mapping

#### Scenario: Status mapping without recognizable names
- **WHEN** the project has status columns with custom names that do not match any pattern
- **THEN** the system presents all columns without defaults and requires the user to explicitly assign each mapping

#### Scenario: Human review mode selection
- **WHEN** the user reaches the human-review mapping step
- **THEN** the system offers four modes: `plan-and-pr` (both plan review and PR review), `plan-only`, `pr-only`, and `none` (fully automatic)
- **THEN** the selected mode determines which Symphony phases map to human-review statuses

#### Scenario: Same status column mapped to multiple phases
- **WHEN** the user maps the same status column to both plan-review and PR-review phases
- **THEN** the system accepts the mapping and generates a valid `WorkflowLifecycleConfig` where both `humanReviewStates` and `awaitingMergeStates` reference the same status string

### Requirement: Init SHALL select AI runtime

The system SHALL prompt the user to select an AI runtime (Codex, Claude Code, or custom command) and store the selection in the workspace configuration.

#### Scenario: Default runtime selection
- **WHEN** the user selects "Codex" (default)
- **THEN** the system sets the worker command to the default Codex app-server command

#### Scenario: Custom runtime command
- **WHEN** the user selects "Custom command"
- **THEN** the system prompts for the custom agent command string
- **THEN** the system stores it as the worker runtime command

### Requirement: Init SHALL generate workspace configuration files

The system SHALL create the `~/.gh-symphony/` directory structure, write `config.json`, `workspace.json`, and `workflow-mapping.json` files, and display a summary of the completed setup.

#### Scenario: Successful init completion
- **WHEN** all init steps complete successfully
- **THEN** the system creates the config directory at `~/.gh-symphony/`
- **THEN** the system writes `config.json` with global settings and active workspace reference
- **THEN** the system writes workspace-specific files under `~/.gh-symphony/workspaces/<id>/`
- **THEN** the system displays a summary showing project, repositories, mapping, and runtime
- **THEN** the system prompts the user to run `gh-symphony start`

#### Scenario: Re-running init with existing config
- **WHEN** the user runs `gh-symphony init` and `~/.gh-symphony/config.json` already exists
- **THEN** the system asks whether to overwrite the existing configuration or create an additional workspace
- **THEN** existing workspace data is preserved unless the user explicitly chooses to overwrite

### Requirement: Init SHALL support non-interactive mode

The system SHALL accept all configuration values via CLI flags and environment variables for scripted or CI-driven setup.

#### Scenario: Fully non-interactive init
- **WHEN** the user runs `gh-symphony init --non-interactive --token <token> --project <url> --runtime codex`
- **THEN** the system uses the provided values without prompting
- **THEN** the system applies smart defaults for any values not explicitly provided (e.g., workflow mapping)
- **THEN** the system exits with code 0 on success or non-zero with an error message on failure
