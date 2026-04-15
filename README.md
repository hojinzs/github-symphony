# GitHub Symphony

GitHub Symphony is a multi-tenant AI coding agent orchestration platform built on the [OpenAI Symphony specification](https://github.com/openai/symphony). A CLI-first orchestrator polls GitHub Projects for open issues, dispatches worker runs per repository, and resolves all workflow policy from each repository's `WORKFLOW.md` at runtime.

## Requirements

- **[Node.js](https://nodejs.org/)** (v24+) with npm
- **[Git](https://git-scm.com/)**
- One GitHub auth source with required scopes (`repo`, `read:org`, `project`):
  - **[GitHub CLI (`gh`)](https://cli.github.com/)**:
    ```bash
    gh auth login --scopes repo,read:org,project
    ```
  - Or `GITHUB_GRAPHQL_TOKEN` for CI, containers, or token-only shells:
    ```bash
    export GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token
    ```

## Getting Started

### 1. Install Package

```bash
npm install -g @gh-symphony/cli
```

Verify the installation:

```bash
gh-symphony --version
```

Validate the local prerequisites before setup:

```bash
gh-symphony doctor
gh-symphony doctor --fix
gh-symphony doctor --json
```

Token-only validation works without `gh`:

```bash
GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token gh-symphony doctor --json
```

### 2. Run Setup

Navigate to the repository you want to orchestrate, then run:

```bash
cd your-repo
gh-symphony setup
```

The one-command setup flow will:

1. Authenticate via `gh` CLI
2. Let you select a **GitHub Project**
3. Map project status columns to workflow phases (active / wait / terminal)
4. Configure managed-project settings for the orchestrator
5. Generate the following files:

| File                                    | Description                                                       |
| --------------------------------------- | ----------------------------------------------------------------- |
| `WORKFLOW.md`                           | Workflow policy — the agent prompt template with lifecycle config |
| `.gh-symphony/context.yaml`             | Project metadata and environment context                          |
| `.gh-symphony/reference-workflow.md`    | Reference workflow documentation                                  |
| `.codex/skills/` (or `.claude/skills/`) | Agent skill definitions                                           |

Before writing anything, the interactive wizard shows a final summary that combines the workflow file preview and the managed-project configuration that will be saved under `~/.gh-symphony/`.

Non-interactive mode:

```bash
gh-symphony setup --non-interactive --project PVT_xxx --workspace-dir ~/.gh-symphony/workspaces
```

### 3. Set Repository Only

Navigate to the repository you want to orchestrate, then run:

```bash
cd your-repo
gh-symphony workflow init
```

Preview the generated files without writing anything:

```bash
gh-symphony workflow init --dry-run
gh-symphony workflow validate
gh-symphony workflow preview --issue owner/repo#123
```

The interactive wizard will:

1. Authenticate via `GITHUB_GRAPHQL_TOKEN` or fall back to `gh` CLI
2. Let you select a **GitHub Project** to bind
3. Map project status columns to workflow phases (active / wait / terminal)
4. Generate the following files:

| File                                    | Description                                                       |
| --------------------------------------- | ----------------------------------------------------------------- |
| `WORKFLOW.md`                           | Workflow policy — the agent prompt template with lifecycle config |
| `.gh-symphony/context.yaml`             | Project metadata and environment context                          |
| `.gh-symphony/reference-workflow.md`    | Reference workflow documentation                                  |
| `.codex/skills/` (or `.claude/skills/`) | Agent skill definitions                                           |

Project discovery is pagination-aware for larger GitHub accounts, so personal projects, organization pages, and organization-owned projects are fetched across multiple API pages before selection. If the CLI hits a discovery safety cap, it keeps the partial list and prints a warning before you choose a board.

`gh-symphony workflow init --dry-run` resolves the same generated outputs, shows whether each path would be created, updated, or left unchanged, and prints the detected environment inputs that shaped the preview.

Those detected inputs are also threaded into the generated artifacts themselves: `WORKFLOW.md`, `.gh-symphony/reference-workflow.md`, and the runtime skill templates all include repository-aware validation guidance based on the detected package manager, monorepo shape, and `test` / `lint` / `build` scripts when present.

Token-only interactive setup is supported:

```bash
export GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token
gh-symphony workflow init
```

#### Customizing Agent Behavior

The generated skill files (under `.codex/skills/` or `.claude/skills/`) define how the AI agent handles commits, pushes, pulls, and project status transitions. You can further customize the agent's behavior by editing `WORKFLOW.md` — this is the policy layer that controls what the agent does at each workflow phase.

> Currently supported runtimes: **Codex**, **Claude Code**

### 4. Set Orchestrator Runner (Project)

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

Project discovery is pagination-aware here as well, so large personal and organization-backed GitHub accounts can browse across multiple project pages. If discovery stops at a safety limit, the wizard warns that the visible list may be incomplete.

Token-only project registration is supported too:

```bash
export GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token
gh-symphony project add
```

If the selected GitHub Project does not have any linked repositories yet, `gh-symphony project add` still saves the project. The CLI reports `0 repositories` and points to the two supported follow-up paths:

- run `gh-symphony repo add <owner/name>` to register a repository immediately
- add a repo-linked issue to the GitHub Project, then re-run setup later if you want the local repository list refreshed

Non-interactive mode:

```bash
GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token gh-symphony workflow init --non-interactive --project PVT_xxx --output WORKFLOW.md
GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token gh-symphony project add --non-interactive --project PVT_xxx --workspace-dir ~/.gh-symphony/workspaces
```

Managing projects:

```bash
gh-symphony doctor                   # Validate local prerequisites, auth, config, WORKFLOW.md, and runtime command
gh-symphony doctor --fix             # Create safe missing paths and print/run remediation follow-ups
gh-symphony project list             # List all configured projects
gh-symphony project remove <id>      # Remove a project
gh-symphony project switch           # Switch the active project
gh-symphony project status           # Show status for a specific project
gh-symphony project start            # Start a specific project
gh-symphony project start --once     # Run one orchestration tick for a specific project
gh-symphony project stop             # Stop a specific project
```

### 5. Run the Orchestrator

```bash
gh-symphony start                   # Start (foreground)
gh-symphony start --once            # First managed-project smoke run, then exit
gh-symphony start --daemon          # Start (background)
gh-symphony stop                    # Stop the daemon
gh-symphony stop --force            # Force stop with SIGKILL
```

Monitor:

```bash
gh-symphony status                  # Show current status
gh-symphony status --watch          # Live dashboard
gh-symphony logs                    # View event logs
gh-symphony logs --follow           # Stream logs in real-time
gh-symphony logs --issue org/repo#1 # Filter by issue
gh-symphony logs --run <run-id>     # Read events for a specific run
gh-symphony logs --level <level>    # Filter by log level
```

Dispatch a single issue:

```bash
gh-symphony run org/repo#123
gh-symphony run org/repo#123 --watch  # Watch status after dispatch
```

Recover stalled runs:

```bash
gh-symphony recover                 # Recover stalled runs
gh-symphony recover --dry-run       # Preview what would be recovered
```

### Managing Repositories

```bash
gh-symphony repo list               # List repositories in active project
gh-symphony repo add owner/name     # Validate and add a repository
gh-symphony repo remove owner/name  # Remove a repository
gh-symphony repo sync               # Add newly linked repositories from GitHub Project
gh-symphony repo sync --dry-run     # Preview linked repository changes
gh-symphony repo sync --prune       # Fully realign with linked repositories
```

`gh-symphony repo add owner/name` is the safest onboarding path when a project is
still empty. It validates the target repository against the GitHub API before
saving config and stores the canonical clone URL returned by GitHub. If
authentication is unavailable or the network is offline, the CLI keeps the
current fallback behavior but prints an explicit warning that the repository was
saved without validation.

`gh-symphony repo sync` refreshes the active managed project's repository list
from the current GitHub Project `linkedRepositories`. The default mode is
additive: newly linked repositories are added, while existing local-only
entries stay in place until you opt into `--prune`.

This is also the intended first-run recovery path when a newly created GitHub Project is still empty.

### Configuration

```bash
gh-symphony config show             # Show configuration
gh-symphony config set <key> <val>  # Set a configuration value
gh-symphony config edit             # Open config in $EDITOR
```

### Diagnostics

`gh-symphony doctor` runs a single first-run diagnostic pass and exits non-zero if any required prerequisite is missing. `gh-symphony doctor --fix` adds a remediation pass on top of the same checks. It can:

- create missing config, runtime, and workspace directories
- launch `gh auth login` / `gh auth refresh` in TTY environments, or print the exact command in non-interactive environments
- launch `gh-symphony init` when `WORKFLOW.md` is missing or invalid
- launch `gh-symphony project add` when the managed project or GitHub Project binding must be reconfigured
- print environment-specific runtime install guidance when the configured command is missing from `PATH`

The diagnostic checks cover:

- the active GitHub auth source (`GITHUB_GRAPHQL_TOKEN` first, otherwise `gh`) and required scopes (`repo`, `read:org`, `project`)
- Node.js runtime version against the documented minimum (`v24+`) and the current `process.version`
- Git installation availability on `PATH`, including `git --version` when available
- active managed project resolution and GitHub Project binding lookup
- config directory, runtime root, and managed workspace writability
- repository `WORKFLOW.md` presence and parse validity
- configured runtime command availability on `PATH`

Use `--json` for setup automation and smoke checks. When combined with `--fix`, the JSON report also includes a structured remediation step list with `applied`, `skipped`, or `manual` outcomes.

```bash
gh-symphony doctor --json
gh-symphony doctor --fix --json
gh-symphony start --once
```

Repository sync also supports structured output:

```bash
gh-symphony repo sync --json
```

JSON output includes the resolved auth source as `env` or `gh`.

### Shell Completion

```bash
gh-symphony completion bash         # Print bash completion script
gh-symphony completion zsh          # Print zsh completion script
gh-symphony completion fish         # Print fish completion script
```

## Concepts

- **Project** — one GitHub Project bound to a set of repositories. Each project gets its own config, leases, and status snapshot. A single orchestrator manages multiple projects.
- **WORKFLOW.md** — the per-repository (or per-project fallback) workflow policy file. Contains YAML front matter for lifecycle config and a Markdown body used as the agent prompt template.

## Authentication

GitHub Symphony supports two authentication paths.

1. `GITHUB_GRAPHQL_TOKEN` for local shells, containers, and CI-like environments
2. `gh` CLI for interactive developer machines

Run `gh` setup once if you want to use the CLI-managed path:

```bash
gh auth login --scopes repo,read:org,project
```

Or if you need to add scopes to an existing login:

```bash
gh auth refresh --scopes repo,read:org,project
```

Use `GITHUB_GRAPHQL_TOKEN` when `gh` is unavailable or undesirable:

```bash
export GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token
```

`GITHUB_GRAPHQL_TOKEN` takes priority over `gh` CLI. Interactive `gh-symphony workflow init` and `gh-symphony project add` will use the env token first when it is present and valid, and only fall back to `gh` when no usable env token is available. `gh-symphony doctor` also reports the resolved auth source as `env` or `gh`.

## WORKFLOW.md

`WORKFLOW.md` contains YAML front matter for lifecycle configuration and a Markdown body used as the agent prompt template.

The generated file includes:

- **Lifecycle**: `active_states`, `terminal_states`, `blocker_check_states` derived from the status column mapping
- **Runtime**: `agent_command` derived from `gh-symphony workflow init`
- **Hooks**: `after_create` hook path
- **Scheduler**: `poll_interval_ms`
- **Retry**: `base_delay_ms`, `max_delay_ms`
- **Status Map**: visual mapping of status columns to roles
- **Agent Instructions**: prompt template with `{{issue.*}}` and `{{guidelines}}` variables

Available template variables:

| Variable                | Description                              |
| ----------------------- | ---------------------------------------- |
| `{{issue.identifier}}`  | e.g. `acme/platform#42`                  |
| `{{issue.title}}`       | Issue title                              |
| `{{issue.state}}`       | Current tracker state                    |
| `{{issue.description}}` | Issue body                               |
| `{{issue.url}}`         | Issue URL                                |
| `{{issue.repository}}`  | `owner/name`                             |
| `{{issue.number}}`      | Issue number                             |
| `{{attempt}}`           | Retry attempt number (null on first run) |
| `{{guidelines}}`        | Prompt guidelines from WORKFLOW.md       |

### Generating WORKFLOW.md

`gh-symphony workflow init` generates a `WORKFLOW.md` in the current directory.

With a project already registered:

```bash
cd my-repo
gh-symphony workflow init        # generates ./WORKFLOW.md from active project config
gh-symphony workflow init --dry-run
gh-symphony workflow validate
gh-symphony workflow preview --issue owner/repo#123
```

`--dry-run` resolves the same generated `WORKFLOW.md`, `.gh-symphony/context.yaml`,
`.gh-symphony/reference-workflow.md`, and runtime skill files, then prints whether
each path would be created, updated, or left unchanged without writing anything.

When `gh-symphony workflow init` detects repository scripts, it bakes that information back into the generated policy files so the out-of-the-box workflow already tells agents which test/lint/build commands to prefer and whether workspace-aware validation is expected.

Without a project (standalone):

```bash
gh-symphony workflow init --non-interactive --project PVT_xxx --output WORKFLOW.md
gh-symphony workflow init --non-interactive --project PVT_xxx --dry-run
```

`gh-symphony workflow validate` parses the target file, strictly renders the prompt body and continuation guidance with canonical sample variables, and prints a compact runtime/lifecycle summary.

`gh-symphony workflow preview --issue owner/repo#123` is the fastest validation step after `workflow init`: it resolves the active managed project (or `--project-id`) and renders the exact worker prompt from the live GitHub Project issue. Keep `--sample <path-to-json>` for fixture-based debugging, and use `--attempt <n>` to inspect retry prompts before changing policy files.

### Resolution order

The orchestrator resolves the workflow policy using this fallback chain:

1. **Repository WORKFLOW.md** — if the target repository has a `WORKFLOW.md` at its root, use it.
2. **Project WORKFLOW.md** — if the repository has no `WORKFLOW.md`, fall back to the project-level `WORKFLOW.md`.
3. **Hardcoded defaults** — if neither file exists, use built-in defaults (`Todo`, `In Progress` as active; `Done` as terminal).

This means you can:

- Run without any `WORKFLOW.md` and rely on defaults
- Use a single project-level `WORKFLOW.md` for all repositories
- Override per-repository by committing a `WORKFLOW.md` to the repo root

### Environment Variables

#### Project `.env` File

For project-specific secrets or staging settings, place a `.env` file under the orchestrator runtime project directory instead of committing values into `WORKFLOW.md` or repository scripts.

- Default path: `~/.gh-symphony/projects/<project-id>/.env`
- If you run the CLI with a custom `--config <dir>`, the path becomes `<dir>/projects/<project-id>/.env`
- The file is loaded as base env for workspace hooks and worker processes

```bash
# ~/.gh-symphony/projects/my-project/.env
STAGING_API_HOST=https://staging.example.com
PLAYWRIGHT_BASE_URL=http://localhost:3000
API_SECRET_KEY=sk-secret-xxx
```

#### Merge Order

Environment variables are merged from three sources (later overrides earlier):

| Priority    | Source             | Description                                 |
| ----------- | ------------------ | ------------------------------------------- |
| 1 (lowest)  | Project `.env`     | `~/.gh-symphony/projects/<project-id>/.env` |
| 2           | System environment | Orchestrator process's `process.env`        |
| 3 (highest) | Symphony context   | Auto-injected `SYMPHONY_*` variables        |

In CI, regular process env can override the project `.env` without changing `WORKFLOW.md`.

#### Auto-injected Hook Variables

All hooks (`after_create`, `before_run`, `after_run`, `before_remove`) automatically receive the following variables in addition to the merged environment above:

| Variable                       | Description                                      |
| ------------------------------ | ------------------------------------------------ |
| `SYMPHONY_PROJECT_ID`          | Orchestrator project ID                          |
| `SYMPHONY_ISSUE_WORKSPACE_KEY` | Workspace key for the issue                      |
| `SYMPHONY_ISSUE_SUBJECT_ID`    | Issue subject ID (tracker-specific)              |
| `SYMPHONY_ISSUE_IDENTIFIER`    | e.g. `acme/platform#42`                          |
| `SYMPHONY_WORKSPACE_PATH`      | Absolute path to the issue workspace             |
| `SYMPHONY_REPOSITORY_PATH`     | Absolute path to the cloned repository           |
| `SYMPHONY_RUN_ID`              | Current run ID (absent in `after_create`)        |
| `SYMPHONY_ISSUE_STATE`         | Current tracker state (absent in `after_create`) |

#### Example: Inline Hook

Keep the mapping logic in versioned hook code while actual values stay in the runtime-only project `.env`:

```yaml
# WORKFLOW.md
hooks:
  after_create: |
    echo "API_HOST=$STAGING_API_HOST" >> .env.development
    echo "SECRET=$API_SECRET_KEY" >> .env.development
  before_run: |
    echo "BASE_URL=$PLAYWRIGHT_BASE_URL" > playwright.env
```

`$STAGING_API_HOST` and `$API_SECRET_KEY` are resolved from the project `.env` at runtime — nothing secret is committed to the repository.

#### Example: External Script File

For complex setup logic, point the hook to a shell script committed in the repository. Hook commands containing a `/` (without spaces) are automatically prefixed with `bash ./`, so a repository-relative path works as-is.

```yaml
# WORKFLOW.md
hooks:
  after_create: hooks/after_create.sh
```

```bash
# hooks/after_create.sh
#!/usr/bin/env bash
set -euo pipefail

# cwd is the repository root
# Project .env variables are available as environment variables

echo "API_HOST=$STAGING_API_HOST" >> .env.development
echo "SECRET=$API_SECRET_KEY" >> .env.development

# Use auto-injected SYMPHONY_* variables
echo "Setting up workspace at $SYMPHONY_WORKSPACE_PATH"
echo "Issue: $SYMPHONY_ISSUE_IDENTIFIER"
```

> Hooks always run with `cwd` set to the repository root. Script paths are relative to that root.

## Headless orchestration

The orchestrator runs independently as long as project config exists under `~/.gh-symphony/`.

```bash
# Via the CLI daemon
gh-symphony start                    # continuous polling + status API on 127.0.0.1:4680
gh-symphony start --once             # run startup cleanup + one poll/reconcile/dispatch tick
gh-symphony start --once --http      # keep the dashboard/API available after the one-shot tick until Ctrl+C
gh-symphony run beta/api#42          # dispatch a single issue

# Via the orchestrator package directly
pnpm --filter @gh-symphony/orchestrator start -- run
pnpm --filter @gh-symphony/orchestrator start -- run-once
pnpm --filter @gh-symphony/orchestrator start -- dispatch --project-id <id>
pnpm --filter @gh-symphony/orchestrator start -- run-issue --project-id <id> --issue <owner/repo#number>
pnpm --filter @gh-symphony/orchestrator start -- recover
pnpm --filter @gh-symphony/orchestrator start -- status
```

Runtime state lives under `.runtime/orchestrator/`:

| Path                          | Contents                                      |
| ----------------------------- | --------------------------------------------- |
| `projects/<id>/config.json`   | Project metadata                              |
| `projects/<id>/WORKFLOW.md`   | Project-level workflow policy (repo fallback) |
| `projects/<id>/leases.json`   | Active or released issue-phase leases         |
| `projects/<id>/status.json`   | Latest project status snapshot                |
| `runs/<run-id>/run.json`      | Run snapshot, retry state, worker assignment  |
| `runs/<run-id>/events.ndjson` | Structured orchestration events               |

Read orchestration state via the status API (`/api/v1/projects/<id>/status`) rather than reading status files directly.

`gh-symphony start --once` is the safest first production-like run when you want to validate the real GitHub Project binding, repository `WORKFLOW.md`, and dispatch eligibility without immediately starting a long-lived poller. It is also a useful CI smoke check for a managed project. Add `--http` when you want the dashboard/API available; with `--once --http`, the one-shot tick still completes, but the HTTP server stays up afterward and the process keeps the project lock until you stop it with `Ctrl+C`.

## Verification

Before shipping a change:

```bash
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

## License

This project is released under the [MIT License](LICENSE).
