# GitHub Symphony

GitHub Symphony is a multi-tenant AI coding agent orchestration platform built on the [OpenAI Symphony specification](https://github.com/openai/symphony). A CLI-first orchestrator polls GitHub Projects for open issues, dispatches worker runs per repository, and resolves all workflow policy from each repository's `WORKFLOW.md` at runtime.

## Requirements

- **[Node.js](https://nodejs.org/)** (v24+) with npm
- **[Git](https://git-scm.com/)**
- At least one AI agent runtime on `PATH` before `gh-symphony repo start`:
  - **[Codex CLI](https://developers.openai.com/codex/cli/)** (`codex`) - install from the official Codex CLI guide, then authenticate with `codex login`.
  - **[Claude Code](https://code.claude.com/docs/en/quickstart)** (`claude`) - install from the official Claude Code quickstart, then authenticate with `ANTHROPIC_API_KEY` or a local Claude login for non-bare runs.
- One GitHub auth source with required scopes (`repo`, `read:org`, `project`):
  - **[GitHub CLI (`gh`)](https://cli.github.com/)**:
    ```bash
    gh auth login --scopes repo,read:org,project
    ```
  - Or `GITHUB_GRAPHQL_TOKEN` for CI, containers, or token-only shells:
    ```bash
    export GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token
    ```

## Quickstart

Prerequisites: Node.js 24+, Git, GitHub auth through `gh` or `GITHUB_GRAPHQL_TOKEN`, one authenticated agent runtime such as `codex` or `claude`, and an existing GitHub Project.

```bash
npm install -g @gh-symphony/cli
gh-symphony doctor
cd your-repo
gh-symphony setup
gh-symphony repo start --once
```

If `doctor` reports a fixable local issue, run `gh-symphony doctor --fix`, then repeat the command that failed.

## Getting Started

### 1. Install the CLI

```bash
npm install -g @gh-symphony/cli
```

Verify the installation and local prerequisites:

```bash
gh-symphony --version
gh-symphony doctor
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

1. Authenticate via `GITHUB_GRAPHQL_TOKEN` or fall back to `gh` CLI
2. Let you select a **GitHub Project**
3. Map project status columns to workflow phases (active / wait / terminal)
4. Configure the repository runtime for the orchestrator
5. Generate the following files:

| File                                    | Description                                                       |
| --------------------------------------- | ----------------------------------------------------------------- |
| `WORKFLOW.md`                           | Workflow policy — the agent prompt template with lifecycle config |
| `.codex/skills/` (or `.claude/skills/`) | Agent skill definitions, including `/gh-symphony` references      |

Before writing anything, the interactive wizard shows a final summary that combines the workflow file preview and the repository runtime that will be saved under `.runtime/orchestrator/`.

Token-only setup is supported when exactly one GitHub Project is visible to the token:

```bash
export GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token
gh-symphony setup
```

If non-interactive setup needs an explicit GitHub Project selection, run the two commands directly:

```bash
GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token gh-symphony workflow init --non-interactive --project PVT_xxx --output WORKFLOW.md
GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token gh-symphony repo init
```

### 3. Run One Smoke Tick

Run a one-shot orchestration tick before leaving the orchestrator on:

```bash
gh-symphony doctor --smoke
gh-symphony repo start --once
```

`doctor --smoke` validates the live GitHub Project binding, repository access, `WORKFLOW.md`, runtime command, workspace root, and configured hook paths without dispatching a worker. `repo start --once` performs one poll/reconcile/dispatch tick and exits.

Use an explicit issue when you want a deterministic preflight:

```bash
gh-symphony doctor --smoke --issue owner/repo#123
gh-symphony repo run owner/repo#123 --watch
```

### 4. Start the Orchestrator

After the smoke tick succeeds, start continuous orchestration:

```bash
gh-symphony repo start             # foreground
gh-symphony repo start --daemon    # background
gh-symphony repo stop
```

Monitor:

```bash
gh-symphony repo status                  # Show current status
gh-symphony repo status --watch          # Live dashboard
gh-symphony repo logs                    # View event logs
gh-symphony repo logs --follow           # Stream logs in real-time
gh-symphony repo logs --issue org/repo#1 # Filter by issue
gh-symphony repo logs --run <run-id>     # Read events for a specific run
gh-symphony repo logs --level <level>    # Filter by log level
```

## End-to-End Walkthrough

This is the normal happy path for one repository already connected by `gh-symphony setup`.

1. Create or choose a GitHub Project issue in a status that your generated `WORKFLOW.md` maps to an active phase, such as `Ready`.
2. Run `gh-symphony doctor --smoke --issue owner/repo#123` to verify the issue, project item, status mapping, repository checkout, workflow prompt rendering, and agent runtime.
3. Run `gh-symphony repo start --once` for a single production-like orchestration tick.
4. Symphony reads the active issue from the GitHub Project, creates or reuses the issue workspace under `.runtime/orchestrator/`, and dispatches the configured runtime command.
5. The worker follows `WORKFLOW.md`, updates the issue with workpad/status comments according to your policy, creates a branch, commits changes, pushes it, and opens a PR linked to the issue.
6. Review the opened PR. When your workflow policy moves the issue into a wait/review state, the orchestrator leaves it for human review instead of starting more work.

For a deterministic single issue run, use:

```bash
gh-symphony repo run owner/repo#123 --watch
```

When the PR is open, use `gh-symphony repo logs --issue owner/repo#123` or `gh-symphony repo status --watch` to inspect the run without digging through runtime files.

## Advanced Setup

### Workflow-Only Initialization

Use `workflow init` when you want to generate or preview repository policy files without binding the repository runtime in the same command:

```bash
gh-symphony workflow init
gh-symphony workflow init --dry-run
gh-symphony workflow validate
gh-symphony workflow preview --issue owner/repo#123
```

The interactive wizard authenticates through `GITHUB_GRAPHQL_TOKEN` or `gh`, lets you select a GitHub Project, maps project status columns to active / wait / terminal phases, and writes `WORKFLOW.md` plus runtime skill definitions under `.codex/skills/` or `.claude/skills/`.

Project discovery is pagination-aware for larger GitHub accounts, so personal projects, organization pages, and organization-owned projects are fetched across multiple API pages before selection. If the CLI hits a discovery safety cap, it keeps the partial list and prints a warning before you choose a board.

`workflow init` is not limited to Node repositories. The detector recognizes conservative validation signals for JavaScript / TypeScript, Python, Go, Rust, `Makefile`, and `justfile` repositories. When the repository exposes an unambiguous entry point, the generated guidance will prefer commands such as `make test`, `just lint`, `uv run pytest`, `go test ./...`, or `cargo test`. When signals conflict at the same confidence level, the generator falls back to generic validation guidance instead of guessing.

### Customizing Agent Behavior

The generated skill files define how the AI agent handles commits, pushes, pulls, and project status transitions. The `/gh-symphony` skill also includes `references/` files for workflow schema details and prompt-body postures (`implement`, `review`, and `maintain`) that can be composed when designing or refining `WORKFLOW.md`.

You can further customize the agent's behavior by editing `WORKFLOW.md` or by adding repository-specific reference markdown under the `/gh-symphony` skill's `references/` directory. `WORKFLOW.md` remains the policy layer that controls what the agent does at each workflow phase.

> Currently supported runtimes: **[Codex CLI](https://developers.openai.com/codex/cli/)** and **[Claude Code](https://code.claude.com/docs/en/quickstart)**. The selected runtime command must be installed and authenticated before `gh-symphony repo start` can dispatch worker runs.

### Explicit GitHub Priority Mapping

GitHub Project V2 priority is repository policy in `WORKFLOW.md`. The runtime uses exactly one configured source and never falls back or guesses renamed labels, Project fields, or option values. Anything unmapped resolves to `priority = null`.

Use a Project single-select field:

```yaml
tracker:
  kind: github-project
  project_id: PVT_kwDOxxxxxx
  state_field: Status
  priority:
    source: project-field
    field: Priority
    values:
      Urgent: 0
      High: 1
      Medium: 2
      Low: 3
```

Or use exact repository labels:

```yaml
tracker:
  kind: github-project
  project_id: PVT_kwDOxxxxxx
  state_field: Status
  priority:
    source: labels
    labels:
      P0: 0
      P1: 1
      P2: 2
```

Or disable priority dispatch explicitly:

```yaml
tracker:
  kind: github-project
  priority:
    source: disabled
```

Lower numbers dispatch first. If an issue has multiple configured priority labels, Symphony uses the lowest numeric value and emits `priority.label_conflict_resolved`. If an active issue carries an unmapped configured-source value, it resolves to `priority = null` and emits `priority.unmapped`.

Legacy `tracker.priority_field: Priority` remains supported for existing workflows, but it is deprecated because it uses live Project option order. To migrate, replace it with `tracker.priority.source: project-field`, copy the exact field name, and write explicit option-name-to-number mappings. If both legacy and explicit config are present, explicit `tracker.priority` wins and diagnostics warn about the conflict.

`gh-symphony workflow validate` reports local config errors and legacy priority warnings. `gh-symphony doctor` additionally checks live Project/repository drift: missing fields, missing labels, unmapped live options, stale configured mappings, and active issues that currently resolve to `priority = null` because their priority-like value is unmapped.

### Official Container Deployment

The official image is designed for headless orchestration and defaults to:

- image: `ghcr.io/hojinzs/github-symphony:<tag>`
- repository runtime volume: `<repo>/.runtime/orchestrator`
- default command: `gh-symphony repo start`
- runtime user: `symphony` (`UID:GID 1000:1000`)

Supported container environment variables:

- `GITHUB_GRAPHQL_TOKEN`: recommended auth source inside containers; requires `repo`, `read:org`, `project`
- `GH_SYMPHONY_CONFIG_DIR`: optional override for the runtime config directory; defaults to `/var/lib/gh-symphony`

Supported volume mounts:

- a cloned repository directory: persists `WORKFLOW.md` and `.runtime/orchestrator/` across restarts

Named Docker volumes work as-is. If you use a host bind mount such as `-v ./data:/var/lib/gh-symphony`, the host directory must be writable by `UID:GID 1000:1000` or the container will fail to persist state.

Prepare a bind-mounted host directory:

```bash
mkdir -p ./data
sudo chown -R 1000:1000 ./data
```

If you need to run the container with your host user instead, pass `--user "$(id -u):$(id -g)"` and make sure the mounted directory is writable by that same UID/GID:

```bash
docker run --rm -it \
  --user "$(id -u):$(id -g)" \
  -e GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token \
  -v "$(pwd)/data:/var/lib/gh-symphony" \
  ghcr.io/hojinzs/github-symphony:latest \
  gh-symphony repo start --once
```

Initialize the repository runtime from inside the mounted repository once:

```bash
docker run --rm -it \
  -e GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token \
  -v "$(pwd):/repo" \
  -w /repo \
  ghcr.io/hojinzs/github-symphony:latest \
  gh-symphony setup --non-interactive
```

Then start the long-running orchestrator from the initialized repository. The image
default command is `gh-symphony repo start`, so the mounted working directory must
already contain `WORKFLOW.md` and the repository runtime config created by setup.

```bash
docker run -d \
  --name gh-symphony \
  --restart unless-stopped \
  -e GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token \
  -v "$(pwd):/repo" \
  -w /repo \
  ghcr.io/hojinzs/github-symphony:latest
```

Example `docker compose` deployment:

```yaml
services:
  gh-symphony:
    image: ghcr.io/hojinzs/github-symphony:latest
    restart: unless-stopped
    working_dir: /repo
    environment:
      GITHUB_GRAPHQL_TOKEN: ${GITHUB_GRAPHQL_TOKEN}
    volumes:
      - ./:/repo
```

Run `gh-symphony setup` once before starting the service so the mounted repository
has `WORKFLOW.md` and `.runtime/orchestrator/`.

If you prefer a host bind mount in `docker compose`, align the container user with the host directory owner:

```yaml
services:
  gh-symphony:
    image: ghcr.io/hojinzs/github-symphony:latest
    working_dir: /repo
    user: "${UID:-1000}:${GID:-1000}"
    environment:
      GITHUB_GRAPHQL_TOKEN: ${GITHUB_GRAPHQL_TOKEN}
    volumes:
      - ./:/repo
      - ./data:/var/lib/gh-symphony
```

Create `./data` ahead of time and ensure it is writable by the UID/GID that you pass through `user`.

For a first-run smoke check against an existing mounted config directory:

```bash
docker run --rm \
  -e GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token \
  -v gh-symphony-data:/var/lib/gh-symphony \
  ghcr.io/hojinzs/github-symphony:latest \
  gh-symphony doctor --smoke --project-id your-project-id
```

## Orchestration Commands

The command reference follows the CLI's Setup / Orchestration / Maintenance grouping.

Setup:

```bash
gh-symphony doctor                   # Validate local prerequisites, auth, config, WORKFLOW.md, and runtime command
gh-symphony doctor --fix             # Create safe missing paths and print/run remediation follow-ups
gh-symphony doctor --json            # Print machine-readable diagnostics
gh-symphony doctor --smoke           # Final preflight: validate a live issue without dispatching work
gh-symphony repo init                # Bind .runtime/orchestrator to the cwd repository
```

Orchestration:

```bash
gh-symphony repo start                   # Start (foreground)
gh-symphony repo start --once            # First managed-project smoke run, then exit
gh-symphony repo start --daemon          # Start (background)
gh-symphony repo stop                    # Stop the daemon
gh-symphony repo stop --force            # Force stop with SIGKILL
gh-symphony repo run org/repo#123        # Dispatch a single issue
gh-symphony repo run org/repo#123 --watch
```

Monitor:

```bash
gh-symphony repo status                  # Show current status
gh-symphony repo status --watch          # Live dashboard
gh-symphony repo logs                    # View event logs
gh-symphony repo logs --follow           # Stream logs in real-time
gh-symphony repo logs --issue org/repo#1 # Filter by issue
gh-symphony repo logs --run <run-id>     # Read events for a specific run
gh-symphony repo logs --level <level>    # Filter by log level
```

Maintenance:

```bash
gh-symphony repo explain owner/repo#123  # Explain why one issue is not dispatching
gh-symphony repo recover                 # Recover stalled runs
gh-symphony repo recover --dry-run       # Preview what would be recovered
gh-symphony doctor --bundle              # Export a redacted support bundle for bug reports
```

Create a shareable support bundle when reporting setup or orchestration
failures:

```bash
gh-symphony doctor --bundle
gh-symphony doctor --bundle ./tmp/support-bundle
gh-symphony doctor --bundle --project-id your-project-id
```

The bundle includes `manifest.json`, `doctor.json`, redacted config and project
metadata, `WORKFLOW.md`, runtime status files when present, and bounded tails of
recent run logs/events. Optional missing files are recorded in the manifest
instead of failing the export.

### Why Is My Issue Not Running?

Use `gh-symphony repo explain <owner/repo#number>` as the first diagnostic
when a GitHub Project issue stays idle:

```bash
gh-symphony repo explain owner/repo#123
gh-symphony repo explain owner/repo#123 --json
gh-symphony repo explain owner/repo#123 --workflow ./WORKFLOW.md
```

The report checks whether the repository is linked to the active managed
project, the issue is present in the GitHub Project item set, the current
project status maps to active / wait / terminal in `WORKFLOW.md`, blockers are
resolved, an existing run / retry / convergence state already owns the issue,
and project or per-state concurrency limits still have capacity.

If the project has no previous local run snapshot and the repository path is
not stored in the managed project config, pass `--workflow` so the command
evaluates the same `WORKFLOW.md` that orchestration will use.

Example:

```text
Issue dispatch explanation: owner/repo#123
Not dispatchable: Project state "Backlog" maps to wait, not active, in WORKFLOW.md.

Checks:
  ✓ Repository owner/repo is linked to the active managed project.
  ✓ Issue is present in the bound GitHub Project item set.
  ✗ Project state "Backlog" maps to wait, not active, in WORKFLOW.md.
    Hint: Move the GitHub Project item to an active state or run 'gh-symphony workflow preview' to inspect WORKFLOW.md state mappings.
```

Hints point back to existing troubleshooting commands such as `workflow
preview`, `doctor`, `repo status`, and `repo logs --issue`.

Recover stalled runs:

```bash
gh-symphony repo recover                 # Recover stalled runs
gh-symphony repo recover --dry-run       # Preview what would be recovered
```

### Repository Runtime

`gh-symphony repo init` binds the orchestrator to the cwd repository. It reads `WORKFLOW.md`, infers `owner/name` from the Git remote, and writes per-repo runtime state under `.runtime/orchestrator/`.

For Linear tracker repositories, `WORKFLOW.md` remains the source of truth:

```yaml
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: symphony-0c79b11b75ea
  pickup_labels:
    include:
      - agent
      - dev-ready
    exclude:
      - no-agent
      - needs-spec
```

`gh-symphony repo init` validates that `tracker.project_slug` is present and that the `tracker.api_key` reference resolves, for example through `LINEAR_API_KEY`. Linear config aliases such as `tracker.project_id`, `projectId`, `project_id`, and `teamId` are rejected. The legacy `.gh-symphony/config.json` file is not used as the Linear source of truth.

`gh-symphony repo start --assigned-only` also applies to Linear trackers. Linear pushes the filter into GraphQL as `assignee.isMe = true`, so the result set is scoped to the user represented by the configured API key. With a personal API key this means issues assigned to that person; with a service-account key it means issues assigned to the service account, and Symphony does not fail fast because Linear does not expose enough token metadata in the issue query path to distinguish those cases reliably.

Linear workflows may also configure `tracker.pickup_labels.include` and `tracker.pickup_labels.exclude` as pickup eligibility gates. Excluded labels always win; when include labels are configured, an issue needs at least one include label before a worker starts. Label changes are not an interruption control for already running workers; move the Linear issue state to drive lifecycle and handoff behavior.

Linear orchestration is polling-only. There is intentionally no Linear webhook setup command; state transitions, workpad comments, and PR handoff policy belong in `WORKFLOW.md`. See `docs/examples/linear-WORKFLOW.md` for a complete example.

### Configuration

```bash
gh-symphony config show             # Show configuration
gh-symphony config set <key> <val>  # Set a configuration value
gh-symphony config edit             # Open config in $EDITOR
```

### Diagnostics

`gh-symphony doctor` runs a single first-run diagnostic pass and exits non-zero if any required prerequisite is missing. `gh-symphony doctor --fix` adds a remediation pass on top of the same checks. `gh-symphony doctor --smoke` is the recommended final preflight before `gh-symphony repo start --once`: it resolves the active managed project, checks the GitHub Project binding, confirms the repository and target issue are readable through the project, renders `WORKFLOW.md` for that issue, verifies the runtime command, workspace root, and configured hook paths, and exits without dispatching a worker.

Use an explicit issue when you want a deterministic check:

```bash
gh-symphony doctor --smoke --issue owner/repo#123
gh-symphony doctor --smoke --issue owner/repo#123 --json
```

Without `--issue`, doctor auto-selects one active live issue from the managed project. If none is suitable, the report explains which active states it expected and suggests re-running with `--issue`.

`gh-symphony doctor --fix` can:

- create missing config, runtime, and workspace directories
- launch `gh auth login` / `gh auth refresh` in TTY environments, or print the exact command in non-interactive environments
- launch `gh-symphony workflow init` when `WORKFLOW.md` is missing or invalid
- launch `gh-symphony setup` when the repository runtime or GitHub Project binding must be reconfigured
- print environment-specific runtime install guidance when the configured command is missing from `PATH`

The diagnostic checks cover:

- the active GitHub auth source (`GITHUB_GRAPHQL_TOKEN` first, otherwise `gh`) and required scopes (`repo`, `read:org`, `project`)
- Node.js runtime version against the documented minimum (`v24+`) and the current `process.version`
- Git installation availability on `PATH`, including `git --version` when available
- repository runtime resolution and GitHub Project binding lookup
- runtime root and repository workspace writability
- repository `WORKFLOW.md` presence and parse validity
- configured runtime command availability on `PATH`
- with `--smoke`: linked repository readiness, live issue readability, strict prompt rendering, and hook path resolution

Use `--json` for setup automation and smoke checks. When combined with `--fix`, the JSON report also includes a structured remediation step list with `applied`, `skipped`, or `manual` outcomes.

```bash
gh-symphony doctor --json
gh-symphony doctor --fix --json
gh-symphony doctor --smoke --json
gh-symphony repo start --once
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

`GITHUB_GRAPHQL_TOKEN` takes priority over `gh` CLI. Interactive `gh-symphony workflow init` and `gh-symphony setup` will use the env token first when it is present and valid, and only fall back to `gh` when no usable env token is available. `gh-symphony doctor` also reports the resolved auth source as `env` or `gh`.

## WORKFLOW.md

`WORKFLOW.md` contains YAML front matter for lifecycle configuration and a Markdown body used as the agent prompt template.

The generated file includes:

- **Lifecycle**: `active_states`, `terminal_states`, explicit `blocker_check_states`, and `planning_states` derived from the status column mapping
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

`--dry-run` resolves the same generated `WORKFLOW.md` and runtime skill files,
then prints whether each path would be created, updated, or left unchanged
without writing anything.

When `gh-symphony workflow init` detects repository validation entry points, it bakes that information back into the generated policy files so the out-of-the-box workflow already tells agents which test/lint/build commands to prefer and whether workspace-aware validation is expected. That includes non-Node repositories when the detector can prove a conservative command from `Makefile`, `justfile`, Python tooling, `go.mod`, or `Cargo.toml`.

Without a project (standalone):

```bash
gh-symphony workflow init --non-interactive --project PVT_xxx --output WORKFLOW.md
gh-symphony workflow init --non-interactive --project PVT_xxx --dry-run
```

`gh-symphony workflow validate` parses the target file, strictly renders the prompt body and continuation guidance with canonical sample variables, and prints a compact runtime/lifecycle summary.

`gh-symphony workflow preview --issue owner/repo#123` is the fastest validation step after `workflow init`: it resolves the active managed project (or `--project-id`) and renders the exact worker prompt from the live GitHub Project issue. Linear workflows can preview a single issue with `gh-symphony workflow preview ENG-123`, which routes through the configured Linear tracker adapter and `LINEAR_API_KEY`. Keep `--sample <path-to-json>` for fixture-based debugging, and use `--attempt <n>` to inspect retry prompts before changing policy files.

### Resolution order

The orchestrator resolves the workflow policy using this fallback chain:

1. **Repository WORKFLOW.md** — if the target repository has a `WORKFLOW.md` at its root, use it.
2. **Project WORKFLOW.md** — if the repository has no `WORKFLOW.md`, fall back to the project-level `WORKFLOW.md`.
3. **Hardcoded defaults** — if neither file exists, use built-in defaults (`Todo`, `In Progress` as active; `Done` as terminal; blocker check and planning states disabled).

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

The orchestrator runs independently as long as the repository has been initialized with `gh-symphony repo init`.

```bash
# Via the CLI daemon
gh-symphony repo start                    # continuous polling + status API on 127.0.0.1:4680
gh-symphony repo start --once             # run startup cleanup + one poll/reconcile/dispatch tick
gh-symphony repo start --once --http      # keep the dashboard/API available after the one-shot tick until Ctrl+C
gh-symphony repo run beta/api#42          # dispatch a single issue

# Via the orchestrator package directly
pnpm --filter @gh-symphony/orchestrator start -- run
pnpm --filter @gh-symphony/orchestrator start -- run-once
pnpm --filter @gh-symphony/orchestrator start -- dispatch --project-id <id>
pnpm --filter @gh-symphony/orchestrator start -- run-issue --project-id <id> --issue <owner/repo#number>
pnpm --filter @gh-symphony/orchestrator start -- recover
pnpm --filter @gh-symphony/orchestrator start -- status
```

Runtime state lives under `.runtime/orchestrator/`:

| Path                          | Contents                                     |
| ----------------------------- | -------------------------------------------- |
| `project.json`                | Repository runtime metadata                  |
| `config.json`                 | Active repository runtime pointer            |
| `leases.json`                 | Active or released issue-phase leases        |
| `status.json`                 | Latest repository status snapshot            |
| `runs/<run-id>/run.json`      | Run snapshot, retry state, worker assignment |
| `runs/<run-id>/events.ndjson` | Structured orchestration events              |

Read orchestration state via the status API (`/api/v1/projects/<id>/status`) rather than reading status files directly.

Run `gh-symphony doctor --smoke` before the first `start --once` when you want a safe pre-dispatch readiness check. `gh-symphony repo start --once` is the first production-like run: it validates the real GitHub Project binding, repository `WORKFLOW.md`, and dispatch eligibility, then performs one poll/reconcile/dispatch tick instead of starting a long-lived poller. Add `--http` when you want the dashboard/API available; with `--once --http`, the one-shot tick still completes, but the HTTP server stays up afterward and the process keeps the project lock until you stop it with `Ctrl+C`.

## Verification

Before shipping a change:

```bash
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

## Community and security

- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

## License

This project is released under the [MIT License](LICENSE).
