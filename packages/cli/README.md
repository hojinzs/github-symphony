# @gh-symphony/cli

Interactive CLI for GitHub Symphony — a multi-tenant AI coding agent orchestration platform.

## Requirements

The following tools must be installed before using the CLI:

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
gh-symphony doctor --smoke
gh-symphony doctor --bundle
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
gh-symphony doctor --smoke --issue owner/repo#123
```

The interactive wizard will:

1. Authenticate via `GITHUB_GRAPHQL_TOKEN` or fall back to `gh` CLI
2. Let you select a **GitHub Project** to bind
3. Map project status columns to workflow phases (active / wait / terminal)
4. Generate `WORKFLOW.md` and supporting files in the repository

Project discovery is pagination-aware for larger GitHub accounts, so viewer projects plus organization-owned projects are collected across multiple API pages before the selection prompt. If a discovery safety cap is hit, the wizard keeps the partial list and prints a warning.

Token-only interactive setup is supported:

```bash
export GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token
gh-symphony workflow init
```

Use `--dry-run` to preview the generated write plan first. The preview reports
whether `WORKFLOW.md`, `.gh-symphony/context.yaml`,
`.gh-symphony/reference-workflow.md`, and runtime skill files would be created,
updated, or left unchanged, and then exits without modifying the repository.

The same detected environment data is applied to the generated artifacts, so `WORKFLOW.md`, `.gh-symphony/reference-workflow.md`, and the runtime skill templates already include repository-aware validation guidance for the detected package manager, monorepo layout, and explicit validation commands when they exist. The `/gh-symphony` skill also ships a `references/` directory with workflow schema details and composable prompt-body postures for implementation, review, and maintenance workflows.

The detector is language-agnostic by default:

- Node repositories: JS lockfiles plus `package.json` `test` / `lint` / `build` scripts
- Python repositories: `uv.lock`, `poetry.lock`, `pyproject.toml`, `pytest.ini`, `requirements*.txt`
- Go repositories: `go.mod`
- Rust repositories: `Cargo.toml`
- Generic runners: `Makefile`, `justfile`

Examples of generated validation guidance include `make test`, `just build`, `uv run pytest`, `poetry run pytest`, `go test ./...`, and `cargo test` when those commands are the clearest repository entry points. If the repository exposes conflicting signals, the CLI keeps the generic fallback instead of guessing.

### Customizing Agent Behavior

`gh-symphony workflow init` generates skill files under `.codex/skills/` (or `.claude/skills/` for Claude Code). These skills define how the AI agent handles commits, pushes, pulls, and project status transitions. The generated `/gh-symphony` skill includes `references/` files that can be customized or extended without adding CLI flags.

You can further customize the agent's behavior by editing `WORKFLOW.md` — this is the policy layer that controls what the agent does at each workflow phase.

> Currently supported runtimes: **[Codex CLI](https://developers.openai.com/codex/cli/)** and **[Claude Code](https://code.claude.com/docs/en/quickstart)**. The selected runtime command must be installed and authenticated before `gh-symphony repo start` can dispatch worker runs.

### Explicit Priority Mapping

GitHub Project V2 does not have a native issue priority. For GitHub Project workflows, dispatch priority is controlled only by the explicit `tracker.priority` policy in `WORKFLOW.md`; there is no fallback from Project fields to labels and no guessed label naming convention. Unmapped values resolve to `priority = null`, so dispatch falls back to created time and identifier.

Project field source:

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

Label source:

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
      P3: 3
```

Disabled:

```yaml
tracker:
  kind: github-project
  priority:
    source: disabled
```

Legacy `tracker.priority_field: Priority` still works, but it is deprecated because it derives numeric priority from the live Project option order. Migrate by copying the field name into `tracker.priority.field` and writing each option display name under `values` with the intended number. If both keys are present, `tracker.priority` wins and `gh-symphony doctor` reports a warning.

Run `gh-symphony workflow validate` for local schema errors and `gh-symphony doctor` for live drift warnings such as missing Project fields, missing labels, unmapped live options, stale mappings, and active issues whose priority-like value resolves to `priority = null`.

### Linear Tracker Repositories

For Linear, configure the tracker in `WORKFLOW.md` and initialize the repository runtime from the target GitHub repository:

```yaml
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: symphony-0c79b11b75ea
```

`gh-symphony repo init` validates `tracker.project_slug` and resolves `tracker.api_key`, so `LINEAR_API_KEY` must be set before initialization. Linear aliases such as `tracker.project_id`, `projectId`, `project_id`, and `teamId` are rejected, and `.gh-symphony/config.json` is not a Linear source of truth.

Linear runs are polling-only. There is no webhook setup command. Put state transition, workpad comment, and PR handoff policy in `WORKFLOW.md`; see `docs/examples/linear-WORKFLOW.md` in the repository for a complete example. Preview a Linear issue prompt with:

```bash
gh-symphony workflow preview ENG-123
```

### Repository `.env` Mapping

If your hooks or worker runs need staging hosts, database URLs, Playwright base URLs, or other runtime-only values, store them in the repository runtime directory instead of hardcoding them in `WORKFLOW.md`.

1. Initialize the repository runtime with `gh-symphony repo init`.
2. Create the runtime env file:

```bash
mkdir -p .runtime/orchestrator
cat > .runtime/orchestrator/.env <<'EOF'
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

The repository runtime always lives under `.runtime/orchestrator/`.

## 3. Set Orchestrator Runner (Repository)

From inside the cloned repository that should run orchestration, initialize the workflow and repository runtime:

```bash
gh-symphony setup
```

The interactive wizard will:

1. Authenticate via `GITHUB_GRAPHQL_TOKEN` or fall back to `gh` CLI
2. Let you select a **GitHub Project**
3. Optionally limit processing to issues assigned to the authenticated user
4. Write `WORKFLOW.md`, support files, and `.runtime/orchestrator/` in the repository

This wizard uses the same pagination-aware discovery path as `workflow init`, so it can enumerate large personal and organization-backed GitHub accounts more reliably. If the CLI stops at a safety limit, it warns that the visible project list may be incomplete.

Token-only non-interactive setup:

```bash
GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token \
  gh-symphony workflow init --non-interactive --project PVT_xxx --output WORKFLOW.md

GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token \
  gh-symphony repo init
```

Token-only setup is also supported when exactly one GitHub Project is visible to the token:

```bash
export GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token
gh-symphony setup
```

### Repository Management

```bash
gh-symphony doctor                   # Validate local prerequisites, auth, config, WORKFLOW.md, and runtime command
gh-symphony doctor --fix             # Apply safe fixes and guide/launch follow-up recovery commands
gh-symphony doctor --smoke           # Final preflight: validate a live issue without dispatching work
gh-symphony repo init                # Bind .runtime/orchestrator to the cwd repository
gh-symphony repo status              # Show current repository orchestration status
gh-symphony repo explain owner/repo#123  # Explain why one issue is not dispatching
gh-symphony repo start               # Start this repository
gh-symphony repo stop                # Stop this repository
```

`gh-symphony repo init` reads `WORKFLOW.md`, infers `owner/name` from the Git remote, and writes per-repo runtime state under `.runtime/orchestrator/`.

### Why Is My Issue Not Running?

Use `gh-symphony repo explain <owner/repo#number>` before digging through
logs manually:

```bash
gh-symphony repo explain owner/repo#123
gh-symphony repo explain owner/repo#123 --json
gh-symphony repo explain owner/repo#123 --workflow ./WORKFLOW.md
```

The command checks project repository linkage, GitHub Project item presence,
`WORKFLOW.md` active / wait / terminal state mapping, blocker state, existing
run / retry / convergence ownership, and project or per-state concurrency
limits.

If the project has no previous local run snapshot and the repository path is
not stored in the managed project config, pass `--workflow` so the command
does not guess from the current shell directory.

```text
Issue dispatch explanation: owner/repo#123
Not dispatchable: Issue has 1 unresolved blocker.

Checks:
  ✓ Repository owner/repo is linked to the active managed project.
  ✓ Issue is present in the bound GitHub Project item set.
  ✓ Project state "Todo" maps to an active state in WORKFLOW.md.
  ✗ Issue has 1 unresolved blocker.
    Hint: Move blocker issues to a terminal state or update the blocker relationship in GitHub.
```

The remediation hints point to existing commands such as `workflow preview`,
`doctor`, `repo status`, and `repo logs --issue`.

## 4. Run the Orchestrator

### Foreground

```bash
gh-symphony repo start
gh-symphony repo start --once            # Run startup cleanup + one orchestration tick, then exit
```

### Background (daemon)

```bash
gh-symphony repo start --daemon          # Start in background
gh-symphony repo stop                    # Stop the daemon
```

Run `doctor --smoke` before the first `start --once` when you want a safe pre-dispatch readiness check. Use `start --once` for the first real managed-project run or a CI smoke check. It reuses the configured GitHub Project binding and `WORKFLOW.md` and performs exactly one poll/reconcile/dispatch cycle instead of entering the long-running orchestration loop. `--daemon --once` is rejected because the modes conflict. If you add `--http`, the dashboard/API remains available after that one-shot tick completes, and the process stays up until you interrupt it with `Ctrl+C`.

### Monitor

```bash
gh-symphony repo status                  # Show current status
gh-symphony repo status --watch          # Live dashboard
gh-symphony repo logs                    # View event logs
gh-symphony repo logs --follow           # Stream logs in real-time
```

### Dispatch a Single Issue

```bash
gh-symphony repo run org/repo#123
```

### Recover Stalled Runs

```bash
gh-symphony repo recover                 # Recover stalled runs
gh-symphony repo recover --dry-run       # Preview what would be recovered
```

## Diagnostics

`gh-symphony doctor` validates the most common first-run prerequisites in one pass. `gh-symphony doctor --smoke` is the recommended final preflight before `gh-symphony repo start --once`: it resolves the active managed project, checks the GitHub Project binding, confirms the repository and target issue are readable through the project, renders `WORKFLOW.md` for that issue, verifies the runtime command, workspace root, and configured hook paths, and exits without dispatching a worker.

Use an explicit issue when you want a deterministic check:

```bash
gh-symphony doctor --smoke --issue owner/repo#123
gh-symphony doctor --smoke --issue owner/repo#123 --json
```

Without `--issue`, doctor auto-selects one active live issue from the managed project. If none is suitable, the report explains which active states it expected and suggests re-running with `--issue`.

`gh-symphony doctor --fix` extends the regular diagnostic flow with safe remediation and guided follow-up:

- creates missing config/runtime/workspace directories
- launches `gh auth login` or `gh auth refresh` when a TTY is available, otherwise prints the exact command to run
- launches `gh-symphony workflow init` when `WORKFLOW.md` is missing or invalid
- launches `gh-symphony setup` when repository runtime setup or GitHub Project binding must be repaired
- prints concrete runtime install guidance when the configured command is missing on `PATH`

`gh-symphony doctor --bundle` creates a redacted support bundle for bug reports:

```bash
gh-symphony doctor --bundle
gh-symphony doctor --bundle ./tmp/support-bundle
gh-symphony doctor --bundle --project-id your-project-id
gh-symphony doctor --bundle --json
```

The bundle writes a deterministic directory containing `manifest.json`,
`doctor.json`, redacted CLI/project config, `WORKFLOW.md`, runtime
`status.json`/`issues.json` when available, and bounded recent run
`events.ndjson`, `worker.log`, and `orchestrator.log` tails. Missing optional
artifacts are listed in `manifest.missing`; redaction and truncation counts are
reported in the command summary.

The diagnostic checks cover:

- the active GitHub auth source (`GITHUB_GRAPHQL_TOKEN` first, otherwise `gh`) and required scopes
- Node.js runtime version against the documented minimum (`v24+`) and the current `process.version`
- Git installation availability on `PATH`, including `git --version` when available
- GitHub authentication via `GITHUB_GRAPHQL_TOKEN` or `gh`, including required scopes
- repository runtime selection plus GitHub Project binding resolution
- runtime/workspace path writability
- repository `WORKFLOW.md` presence and parse validity
- runtime command availability on `PATH`
- with `--smoke`: linked repository readiness, live issue readability, strict prompt rendering, and hook path resolution

Use JSON output for scripts and CI smoke checks. `--fix --json` includes a remediation section where each step is reported as `applied`, `skipped`, or `manual`.

```bash
gh-symphony doctor --json
gh-symphony doctor --fix --json
gh-symphony doctor --smoke --json
gh-symphony doctor --bundle --json
gh-symphony repo start --once
```

JSON output includes the resolved auth source as `env` or `gh`.

## Command Reference

```
Setup:
  setup               Generate WORKFLOW.md and initialize the cwd repository runtime
  workflow init       Interactive repository setup wizard
  workflow validate   Parse and strictly validate WORKFLOW.md
  workflow preview    Render the final worker prompt from a sample or live issue
  doctor              Run diagnostics, smoke checks, and optional remediation
  config show         Show current configuration
  config set          Set a configuration value
  config edit         Open config in $EDITOR

Orchestration:
  repo init           Bind .runtime/orchestrator to the cwd repository
  repo start          Start the orchestrator (foreground)
  repo start --once   Run a single orchestration tick and exit
  repo start --daemon Start the orchestrator (background)
  repo stop           Stop the background orchestrator
  repo status         Show orchestrator status
  repo run <issue>    Dispatch a single issue
  repo recover        Recover stalled runs
  repo logs           View orchestrator logs
  repo explain        Explain why an issue is not dispatching
  completion <shell>  Print shell completion for bash/zsh/fish

Global Options:
  --config <dir>      Config directory (default: initialized cwd runtime, then ~/.gh-symphony)
  --verbose           Enable verbose output
  --json              Output in JSON format
  --no-color          Disable color output
  --help, -h          Show help
  --version, -V       Show version
```
