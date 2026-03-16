# @gh-symphony/cli

Interactive CLI for GitHub Symphony — a multi-tenant AI coding agent orchestration platform.

## Requirements

The following tools must be installed before using the CLI:

- **[Node.js](https://nodejs.org/)** (v24+) with npm
- **[Git](https://git-scm.com/)**
- **[GitHub CLI (`gh`)](https://cli.github.com/)** — authenticated with required scopes:
  ```bash
  gh auth login --scopes repo,read:org,project
  ```

## 1. Install Package

```bash
npm install -g @gh-symphony/cli
```

Verify the installation:

```bash
gh-symphony --version
```

Enable shell completion:

```bash
gh-symphony completion bash >> ~/.bashrc
gh-symphony completion zsh >> ~/.zshrc
gh-symphony completion fish > ~/.config/fish/completions/gh-symphony.fish
```

## 2. Set Repository

Navigate to the repository you want to orchestrate, then run:

```bash
gh-symphony init
```

The interactive wizard will:

1. Authenticate via `gh` CLI
2. Let you select a **GitHub Project** to bind
3. Map project status columns to workflow phases (active / wait / terminal)
4. Generate `WORKFLOW.md` and supporting files in the repository

### Customizing Agent Behavior

`gh-symphony init` generates skill files under `.codex/skills/` (or `.claude/skills/` for Claude Code). These skills define how the AI agent handles commits, pushes, pulls, and project status transitions.

You can further customize the agent's behavior by editing `WORKFLOW.md` — this is the policy layer that controls what the agent does at each workflow phase.

> Currently supported runtimes: **Codex**, **Claude Code**

## 3. Set Orchestrator Runner (Project)

On the machine where you want the orchestrator to run, register a project:

```bash
gh-symphony project add
```

The interactive wizard will:

1. Authenticate via `gh` CLI
2. Let you select a **GitHub Project**
3. Select repositories to orchestrate
4. Optionally limit processing to issues assigned to the authenticated user
5. Configure the workspace root directory
6. Write project configuration to `~/.gh-symphony/`

### Project Management

```bash
gh-symphony project list             # List all configured projects
gh-symphony project remove <id>      # Remove a project
```

## 4. Run the Orchestrator

### Foreground

```bash
gh-symphony start
```

### Background (daemon)

```bash
gh-symphony start --daemon          # Start in background
gh-symphony stop                    # Stop the daemon
```

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

## Command Reference

```
Setup:
  init                Interactive repository setup wizard
  config show         Show current configuration
  config set          Set a configuration value
  config edit         Open config in $EDITOR

Orchestration:
  start               Start the orchestrator (foreground)
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

Global Options:
  --config <dir>      Config directory (default: ~/.gh-symphony)
  --verbose           Enable verbose output
  --json              Output in JSON format
  --no-color          Disable color output
  --help, -h          Show help
  --version, -V       Show version
```
