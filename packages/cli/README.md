# @gh-symphony/cli

Interactive CLI for GitHub Symphony — a multi-tenant AI coding agent orchestration platform.

## Requirements

The following tools must be installed before using the CLI:

- **[Node.js](https://nodejs.org/)** (v24+) with npm
- **[Git](https://git-scm.com/)**
- One GitHub auth source with required scopes (`repo`, `read:org`, `project`):
  - **[GitHub CLI (`gh`)](https://cli.github.com/)**:
    ```bash
    gh auth login --scopes repo,read:org,project
    ```
  - Or `GITHUB_GRAPHQL_TOKEN` for CI or minimal shells:
    ```bash
    export GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token
    ```

## 1. Install Package

```bash
npm install -g @gh-symphony/cli
```

Verify the installation:

```bash
gh-symphony --version
```

Validate the machine and repo prerequisites before first use:

```bash
gh-symphony doctor
gh-symphony doctor --fix
gh-symphony doctor --json
GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token gh-symphony doctor --json
```

Enable shell completion:

```bash
gh-symphony completion bash >> ~/.bashrc
gh-symphony completion zsh >> ~/.zshrc
gh-symphony completion fish > ~/.config/fish/completions/gh-symphony.fish
```

If your `zsh` config does not already initialize completion, add this before the generated script line:

```bash
autoload -Uz compinit && compinit
```

## 2. Set Repository

Navigate to the repository you want to orchestrate, then run:

```bash
gh-symphony workflow init
gh-symphony workflow init --dry-run
gh-symphony workflow validate
gh-symphony workflow preview --issue owner/repo#123
```

The interactive wizard will:

1. Authenticate via `GITHUB_GRAPHQL_TOKEN` or fall back to `gh` CLI
2. Let you select a **GitHub Project** to bind
3. Map project status columns to workflow phases (active / wait / terminal)
4. Generate `WORKFLOW.md` and supporting files in the repository

Token-only interactive setup is supported:

```bash
export GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token
gh-symphony workflow init
```

Use `--dry-run` to preview the generated write plan first. The preview reports
whether `WORKFLOW.md`, `.gh-symphony/context.yaml`,
`.gh-symphony/reference-workflow.md`, and runtime skill files would be created,
updated, or left unchanged, and then exits without modifying the repository.

### Customizing Agent Behavior

`gh-symphony workflow init` generates skill files under `.codex/skills/` (or `.claude/skills/` for Claude Code). These skills define how the AI agent handles commits, pushes, pulls, and project status transitions.

You can further customize the agent's behavior by editing `WORKFLOW.md` — this is the policy layer that controls what the agent does at each workflow phase.

> Currently supported runtimes: **Codex**, **Claude Code**

### Project `.env` Mapping

If your hooks or worker runs need staging hosts, database URLs, Playwright base URLs, or other runtime-only values, store them in the project runtime directory instead of hardcoding them in `WORKFLOW.md`.

1. Find the project id from `gh-symphony project list`.
2. Create the runtime env file:

```bash
mkdir -p ~/.gh-symphony/projects/<project-id>
cat > ~/.gh-symphony/projects/<project-id>/.env <<'EOF'
STAGING_API_HOST=https://staging.example.com
DATABASE_URL=postgres://user:pass@staging-db:5432/app
PLAYWRIGHT_BASE_URL=http://localhost:3000
EOF
```

3. Reference those variables from `WORKFLOW.md` hooks or repository setup scripts:

```yaml
hooks:
  after_create: 'echo "API_HOST=$STAGING_API_HOST" >> .env.development'
  before_run: 'echo "BASE_URL=$PLAYWRIGHT_BASE_URL" > playwright.env'
```

Env precedence during hook execution and worker spawn is:

- `project .env` as the base
- system env as the override layer
- Symphony context vars such as `SYMPHONY_*` as the highest-priority layer

If you use `--config <dir>`, replace `~/.gh-symphony` with that directory.

## 3. Set Orchestrator Runner (Project)

On the machine where you want the orchestrator to run, register a project:

```bash
gh-symphony project add
```

The interactive wizard will:

1. Authenticate via `GITHUB_GRAPHQL_TOKEN` or fall back to `gh` CLI
2. Let you select a **GitHub Project**
3. Optionally limit processing to issues assigned to the authenticated user
4. Optionally customize advanced settings for repository filtering and workspace root directory
5. Write project configuration to `~/.gh-symphony/`

Token-only non-interactive setup:

```bash
GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token \
  gh-symphony workflow init --non-interactive --project PVT_xxx --output WORKFLOW.md

GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token \
  gh-symphony project add --non-interactive --project PVT_xxx --workspace-dir ~/.gh-symphony/workspaces
```

Token-only project registration is also supported:

```bash
export GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token
gh-symphony project add
```

If the selected GitHub Project is brand new and has no linked repositories yet, the setup still succeeds. The completion message reports `0 repositories` and suggests either `gh-symphony repo add <owner/name>` or adding a repo-linked issue to the GitHub Project.

### Project Management

```bash
gh-symphony doctor                   # Validate local prerequisites, auth, config, WORKFLOW.md, and runtime command
gh-symphony doctor --fix             # Apply safe fixes and guide/launch follow-up recovery commands
gh-symphony project list             # List all configured projects
gh-symphony project remove <id>      # Remove a project
gh-symphony repo add owner/name      # Validate and save a repo target manually
gh-symphony repo sync                # Add newly linked repositories from the GitHub Project
gh-symphony repo sync --dry-run      # Preview linked repository drift
gh-symphony repo sync --prune        # Remove local repositories no longer linked
```

Use `gh-symphony repo add owner/name` as the onboarding safety check when a
project starts empty or when you want to register a repository before it is
linked on the GitHub Project board. Successful validation stores the canonical
clone URL from the GitHub API. If auth is unavailable or the API is offline,
the CLI still saves the repo with the fallback HTTPS clone URL and prints a
warning that validation was skipped.

Use `gh-symphony repo sync` when the GitHub Project board has gained or lost
linked repositories since the project was first added locally. Default sync is
additive; `--prune` switches to strict alignment, and `--json` prints the added,
removed, unchanged, and final repository sets.

For empty projects, use `gh-symphony repo add owner/name` after setup to seed the local repository list without re-running the whole wizard.

## 4. Run the Orchestrator

### Foreground

```bash
gh-symphony start
gh-symphony start --once            # Run startup cleanup + one orchestration tick, then exit
gh-symphony project start --once    # Same one-shot flow for an explicit project
```

### Background (daemon)

```bash
gh-symphony start --daemon          # Start in background
gh-symphony stop                    # Stop the daemon
```

Use `start --once` for the first real managed-project run or a CI smoke check. It reuses the configured GitHub Project binding and `WORKFLOW.md` and performs exactly one poll/reconcile/dispatch cycle instead of entering the long-running orchestration loop. `--daemon --once` is rejected because the modes conflict. If you add `--http`, the dashboard/API remains available after that one-shot tick completes, and the process stays up until you interrupt it with `Ctrl+C`.

### Monitor

```bash
gh-symphony status                  # Show current status
gh-symphony status --watch          # Live dashboard
gh-symphony logs                    # View event logs
gh-symphony logs --follow           # Stream logs in real-time
```

### Dispatch a Single Issue

```bash
gh-symphony run org/repo#123
```

### Recover Stalled Runs

```bash
gh-symphony recover                 # Recover stalled runs
gh-symphony recover --dry-run       # Preview what would be recovered
```

## Diagnostics

`gh-symphony doctor` validates the most common first-run prerequisites in one pass. `gh-symphony doctor --fix` extends that flow with safe remediation and guided follow-up:

- creates missing config/runtime/workspace directories
- launches `gh auth login` or `gh auth refresh` when a TTY is available, otherwise prints the exact command to run
- launches `gh-symphony init` when `WORKFLOW.md` is missing or invalid
- launches `gh-symphony project add` when managed project setup or GitHub Project binding must be repaired
- prints concrete runtime install guidance when the configured command is missing on `PATH`

The diagnostic checks cover:

- the active GitHub auth source (`GITHUB_GRAPHQL_TOKEN` first, otherwise `gh`) and required scopes
- Node.js runtime version against the documented minimum (`v24+`) and the current `process.version`
- Git installation availability on `PATH`, including `git --version` when available
- GitHub authentication via `GITHUB_GRAPHQL_TOKEN` or `gh`, including required scopes
- managed project selection plus GitHub Project binding resolution
- config/runtime/workspace path writability
- repository `WORKFLOW.md` presence and parse validity
- runtime command availability on `PATH`

Use JSON output for scripts and CI smoke checks. `--fix --json` includes a remediation section where each step is reported as `applied`, `skipped`, or `manual`.

```bash
gh-symphony doctor --json
gh-symphony doctor --fix --json
gh-symphony start --once
```

JSON output includes the resolved auth source as `env` or `gh`.

## Command Reference

```
Setup:
  workflow init       Interactive repository setup wizard
  workflow validate   Parse and strictly validate WORKFLOW.md
  workflow preview    Render the final worker prompt from a sample or live issue
  doctor              Run diagnostics and optional first-run remediation
  config show         Show current configuration
  config set          Set a configuration value
  config edit         Open config in $EDITOR

Orchestration:
  start               Start the orchestrator (foreground)
  start --once        Run a single orchestration tick and exit
  start --daemon      Start the orchestrator (background)
  stop                Stop the background orchestrator
  status              Show orchestrator status
  run <issue>         Dispatch a single issue
  recover             Recover stalled runs
  logs                View orchestrator logs
  completion <shell>  Print shell completion for bash/zsh/fish

Project Management:
  project add          Add a new project (interactive wizard)
  project list         List all configured projects
  project remove       Remove a project
  repo sync            Refresh repositories from the linked GitHub Project

Global Options:
  --config <dir>      Config directory (default: ~/.gh-symphony)
  --verbose           Enable verbose output
  --json              Output in JSON format
  --no-color          Disable color output
  --help, -h          Show help
  --version, -V       Show version
```
