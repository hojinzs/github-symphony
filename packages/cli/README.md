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

If your `zsh` config does not already initialize completion, add this before the generated script line:

```bash
autoload -Uz compinit && compinit
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

1. Authenticate via `gh` CLI
2. Let you select a **GitHub Project**
3. Optionally limit processing to issues assigned to the authenticated user
4. Optionally customize advanced settings for repository filtering and workspace root directory
5. Write project configuration to `~/.gh-symphony/`

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
