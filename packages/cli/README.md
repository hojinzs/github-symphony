# @gh-symphony/cli

## Repository command migration

The CLI prints this migration instruction exactly:

```text
The 'repo' command has been removed. Use 'gh-symphony project start --project-dir <path>'.
Migration: packages/cli/README.md#repository-command-migration
```

Every removed `repo` subcommand exits non-zero. Start the project explicitly:

```bash
gh-symphony project start --project-dir /path/to/project
```

After upgrading, restart daemonized projects so their process command line uses
`project start` rather than the legacy `repo start`. A daemon started by an
older CLI can still be stopped safely with the new project command, even when
its saved process identity differs from the platform-reported command line:

```bash
gh-symphony project stop --project-dir /path/to/project
gh-symphony project start --daemon --project-dir /path/to/project
```

The internal `GH_SYMPHONY_DAEMON_PROJECT_ID` handoff has been removed; daemon
children now receive project identity through the explicit `--project-dir`
argument.

Interactive CLI for GitHub Symphony — a multi-tenant AI coding agent orchestration platform.

## Requirements

The following tools must be installed before using the CLI:

- **[Node.js](https://nodejs.org/)** (v24+) with npm
- **[Git](https://git-scm.com/)**
- At least one AI agent runtime on `PATH` before `gh-symphony project start --project-dir <path>`:
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

The package includes internal `dist/mcp-server.js` and
`dist/git-credential-helper.js` executables for host-side compatibility paths.
Coding-agent children do not launch these provider MCP or Git credential
subprocesses; provider tools and authenticated Git transport execute in the
worker host. The Git helper consumes the worker's direct
`GITHUB_GRAPHQL_TOKEN`; it does not contact a credential broker. Git transport
uses the orchestrator-owned target URL from a
temporary bare repository with checkout hooks disabled, so child-authored
remote and hook configuration is outside the credential-bearing path. These
entry points are not standalone user-facing commands. Agents publish committed
work through the authenticated run-scoped host action documented by the
generated `/push` skill; the same transport runs again at worker exit as a
backstop.

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

## 2. Create a Project Folder

Create a project folder outside the target repository, then run:

```bash
mkdir my-symphony-project && cd my-symphony-project
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
4. Generate `WORKFLOW.md` and supporting files in the project folder

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

Pickup-label eligibility comparison is case-insensitive and ignores surrounding
whitespace: `Agent`, `agent`, and `" AGENT "` are the same label. Do not use
labels that differ only by case or outer whitespace as separate pickup gates.

### Codex approval and turn timeout posture

Codex workflows support only `codex.approval_policy: never`. The runtime has no
operator-approval handler, so `on-request` and `untrusted` are rejected during
workflow validation rather than leaving a worker session waiting for an
unanswerable request. To migrate an existing workflow, change either value to
`never` or remove `codex.approval_policy`.

`runtime.timeouts.turn_timeout_ms` (and legacy `codex.turn_timeout_ms`) is the
maximum silence interval for a Codex app-server turn. Every app-server output
resets it; it is not a total turn-duration cap.

`gh-symphony workflow validate` reports the effective values under
`runtime.timeouts.*`. An explicit `runtime.timeouts` block takes precedence over
the legacy `codex.*_timeout_ms` fields; documented defaults apply when neither
location provides a value.

In JSON output, effective timeout values are exposed as
`summary.runtimeTimeouts.{readTimeoutMs,stallTimeoutMs,turnTimeoutMs}`. These
replace the former `summary.codex.*TimeoutMs` fields, which could report values
that the runtime did not use; no compatibility aliases are emitted.

Lifecycle generation enables blocker checks for the first configured active
state (`Todo` with built-in defaults) while leaving planning states disabled.
An explicit `tracker.provider.blocker_check_states: []` disables blocker gating; this is
an intentional repository-level opt-out from the vendored Symphony spec's
unconditional blocker rule.

`tracker.provider.planning_states` classifies a matching state's `execution_phase` as
`planning`; other matching active states use `implementation`. Classification
is independent of dispatch eligibility and does not make a state active. State
names are trimmed and compared case-insensitively. The classification is
available to the prompt as `{{ execution_phase }}`, but does not itself prevent
implementation: the `WORKFLOW.md` prompt policy must branch on that variable
when a plan-only posture is required.

Between-turn tracker refresh failures include HTTP, provider, or exception
diagnostics in worker logs. Transient failures keep the configured consecutive
failure threshold; an adapter response of `tracker_state_requests_unsupported`
produces one capability warning and lets the worker continue without that gate.

> Currently supported runtimes: **[Codex CLI](https://developers.openai.com/codex/cli/)**, **[Claude Code](https://code.claude.com/docs/en/quickstart)**, and an operator-supplied `runtime.kind: custom` command. The selected runtime command must be installed and authenticated before `gh-symphony project start --project-dir <path>` can dispatch worker runs.

For a local non-bare login, the worker copies only the selected provider's
login material into a private, workspace-contained child home. It does not
expose the host `gh` configuration, Codex configuration, Claude MCP OAuth, or
tracker credentials to the coding-agent process.

The orchestrator retains a tenant-scoped direct tracker credential at the
worker host boundary. Project `.env` credentials take precedence over the
daemon's resolved credential, enabling GitHub polling and host-side tracker
tools while the agent child remains credential-free. The Git publication
broker branch remains in code for later removal, but the required direct token
takes precedence and therefore must also permit repository pushes.
`gh-symphony doctor` reports a required `Worker GitHub credential` check for
the selected tenant using that same precedence. Without a usable GitHub or
Linear worker credential, startup fails before the agent launches; known-empty
dispatches are skipped and surfaced in status snapshot warnings.

Custom commands are isolated by default: they receive portable process values,
a private `HOME`/`GH_CONFIG_DIR`, the rendered prompt, and only the dedicated
provider credential named in `runtime.auth.env`. Existing custom commands that
relied on inherited variables must declare that one credential explicitly. The
temporary `runtime.isolation.inherit_environment: true` migration escape hatch
restores the raw worker environment, including tracker and broker credentials;
it is custom-only, security-sensitive, and should be removed after migration.

Before dispatch, GitHub candidates are checked against the source issue and linked closing PR state. A closed issue or merged linked PR left in an active Project status is reconciled to the first configured terminal status, suppressed from worker startup, and reported as `tracker-terminal-candidate-reconciled`.

### Explicit Priority Mapping

GitHub Project V2 does not have a native issue priority. For GitHub Project workflows, dispatch priority is controlled only by the explicit `tracker.provider.priority` policy in `WORKFLOW.md`; there is no fallback from Project fields to labels and no guessed label naming convention. Unmapped values resolve to `priority = null`, so dispatch falls back to created time and identifier.

Project field source:

```yaml
tracker:
  kind: github-project
  provider:
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
  provider:
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
  provider:
    priority:
      source: disabled
```

Flat tracker keys such as `tracker.priority_field` are rejected in this major release. Use `tracker.provider.priority.field` and write each option display name under `values` with the intended number. `gh-symphony doctor` prints a copyable provider migration block.

All removed flat `tracker.*` provider settings produce a typed
`workflow_deprecated_key` error. Use `tracker.provider`; `gh-symphony doctor`
prints the normalized provider block for migration.

Run `gh-symphony workflow validate` for local schema errors and warnings. Ignored `agent.max_concurrent_agents_by_state` entries warn with their paths and reasons, while valid entries in the same map remain active; `gh-symphony doctor` reports the same warning alongside live drift checks such as missing Project fields, missing labels, unmapped live options, stale mappings, and active issues whose priority-like value resolves to `priority = null`. Strict front-matter failures use stable workflow error codes; `workflow validate --json` also emits the failing `error.path`.

### Linear Tracker Projects

For Linear, configure the tracker in the project folder's `WORKFLOW.md`:

```yaml
tracker:
  kind: linear
  provider:
    api_key: $LINEAR_API_KEY
    project_slug: symphony-0c79b11b75ea
```

`gh-symphony setup` validates `tracker.provider.project_slug` and resolves `tracker.provider.api_key` when supplied. If it is omitted, startup uses `LINEAR_API_KEY`. Flat keys are rejected; `.gh-symphony/config.json` is not a Linear source of truth.

Linear runs are polling-only. There is no webhook setup command. Put state transition, workpad comment, and PR handoff policy in `WORKFLOW.md`; see `docs/examples/linear-WORKFLOW.md` in the repository for a complete example. Preview a Linear issue prompt with:

```bash
gh-symphony workflow preview ENG-123
```

### Project `.env` Mapping

Symphony-specific values belong in the project folder's `.env`, which is merged
before the daemon environment and Symphony-injected run context. A repository's
own `.env` remains application-owned and is never loaded by Symphony.

The project `.env` is read at each consumption point. Approved workspace hooks
may update it, and the worker spawned after those hooks observes the same-run
update from one post-hook environment snapshot.

If your hooks or worker runs need staging hosts, database URLs, Playwright base
URLs, or other runtime-only values, store them in the project `.env` instead of
hardcoding them in `WORKFLOW.md`.

1. Initialize the project folder with `gh-symphony setup`.
2. Create the project env file:

```bash
cat > .env <<'EOF'
STAGING_API_HOST=https://staging.example.com
DATABASE_URL=postgres://user:pass@staging-db:5432/app
PLAYWRIGHT_BASE_URL=http://localhost:3000
EOF
```

3. Reference those variables from a committed hook script or repository setup script:

`WORKFLOW.md` hooks are path-only and require
`SYMPHONY_ALLOW_WORKFLOW_HOOKS=1` (or `true`) in the host environment. Inline
shell commands are rejected; use an executable repository script instead.

Env precedence during hook execution and worker spawn is:

- `project .env` as the base
- system env as the override layer
- Symphony context vars such as `SYMPHONY_*` as the highest-priority layer

Cached runtime state lives under the configured Symphony directory; the
project folder remains the source of truth.

## 3. Set Up the Project Folder

From inside the project folder, initialize the workflow:

```bash
gh-symphony setup
```

The interactive wizard will:

1. Authenticate via `GITHUB_GRAPHQL_TOKEN` or fall back to `gh` CLI
2. Let you select a **GitHub Project**
3. Optionally limit processing to issues assigned to the authenticated user
4. Write `WORKFLOW.md` and support files in the project folder

This wizard uses the same pagination-aware discovery path as `workflow init`, so it can enumerate large personal and organization-backed GitHub accounts more reliably. If the CLI stops at a safety limit, it warns that the visible project list may be incomplete.

Token-only non-interactive setup:

```bash
GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token \
  gh-symphony workflow init --non-interactive --project PVT_xxx --output WORKFLOW.md

GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token \
  gh-symphony setup
```

Token-only setup is also supported when exactly one GitHub Project is visible to the token:

```bash
export GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token
gh-symphony setup
```

### Project Management

```bash
gh-symphony doctor                   # Validate local prerequisites, auth, config, WORKFLOW.md, and runtime command
gh-symphony doctor --fix             # Apply safe fixes and guide/launch follow-up recovery commands
gh-symphony doctor --smoke           # Final preflight: validate a live issue without dispatching work
gh-symphony setup                # Generate the cwd project configuration
gh-symphony project status --project-dir <path>              # Show current project orchestration status
gh-symphony project start --project-dir <path>               # Start this project
gh-symphony project stop --project-dir <path>                # Stop this project
```

`gh-symphony setup` generates `WORKFLOW.md` and support files in the cwd project folder. `project start --project-dir <path>` derives and refreshes runtime configuration from that folder on every start.

### Why Is My Issue Not Running?

Use `gh-symphony project status --project-dir <path> --watch`, `gh-symphony doctor --smoke`, and `gh-symphony workflow preview` to inspect an idle Project issue.

## 4. Run the Orchestrator

### Foreground

```bash
gh-symphony project start --project-dir <path>
gh-symphony project start --project-dir <path> --once            # Run startup cleanup + one orchestration tick, then exit
```

### Background (daemon)

```bash
gh-symphony project start --project-dir <path> --daemon          # Start in background
gh-symphony project stop --project-dir <path>                    # Stop the daemon
```

Run `doctor --smoke` before the first `start --once` when you want a safe pre-dispatch readiness check. Use `start --once` for the first real managed-project run or a CI smoke check. It reuses the configured GitHub Project binding and `WORKFLOW.md` and performs exactly one poll/reconcile/dispatch cycle instead of entering the long-running orchestration loop. `--daemon --once` is rejected because the modes conflict. Add `--port [port]` to enable the JSON status API; `--http [port]` remains an alias, and `server.port` in `WORKFLOW.md` applies when neither CLI option is present.

### Monitor

```bash
gh-symphony project status --project-dir <path>                  # Show current status
gh-symphony project status --project-dir <path> --watch          # Live dashboard
```

Active-run rows with a recorded digest include the opaque `sha256:...`
project-environment digest.
Operators can compare the digest across runs to detect project `.env` changes;
the status surface never expands it into environment names or values.

### Standalone Projects

Use a project folder as an orchestration instance decoupled from the repository it targets. The folder owns `WORKFLOW.md` (with `repository.slug: owner/name`), plus its `hooks/after_create.sh`, optional `.mcp.json`, `.env`, and `.agent/skills/`. The orchestrator creates issue directories and invokes `after_create`; the shipped default hook clones the target and checks out the project-scoped issue branch. `start` derives and caches configuration from the folder on every run; `status` and `stop` address the same runtime by folder without reading `WORKFLOW.md`.

The trusted population hook receives host Git credential-helper configuration
for private clones, and dispatch verifies that it leaves
`SYMPHONY_ASSIGNED_BRANCH` checked out. Re-running `workflow init` migrates the
exact legacy generated no-op hook to the population script while preserving any
customized hook.

A running daemon defensively re-reads and resolves `WORKFLOW.md` at every
reconciliation tick, so valid edits need no restart and apply at the next tick.
The polling delay is capped at five minutes; lowering the interval waits for the
already-scheduled tick before the new interval applies. The daemon intentionally
does not use a filesystem watcher, a repository-local divergence from the
upstream Symphony specification. `project status` expose the
applied `workflow.revision` and `workflow.loadedAt`; dispatch events carry
`workflowRevision`.

```bash
cd <projectDir>
gh-symphony project start                # Derive WORKFLOW.md and start this folder's project
gh-symphony project status               # Address this folder's runtime
gh-symphony project stop
gh-symphony project start --project-dir <projectDir>
gh-symphony project list                 # List cached projects
gh-symphony doctor --project-dir <projectDir>
```

## Diagnostics

`gh-symphony doctor` validates the most common first-run prerequisites in one pass. `gh-symphony doctor --smoke` is the recommended final preflight before `gh-symphony project start --project-dir <path> --once`: it resolves the active managed project, reads a target issue through the configured tracker integration, renders `WORKFLOW.md` for that issue, verifies the runtime command, workspace root, and configured hook paths, and exits without dispatching a worker. GitHub projects retain the GitHub Project read path and require `owner/repo#number` for explicit issues; Linear projects read through the Linear adapter, use identifiers such as `DEV-54`, and do not require a GitHub Project binding.

Use an explicit issue when you want a deterministic check:

```bash
gh-symphony doctor --smoke --issue owner/repo#123
gh-symphony doctor --smoke --issue owner/repo#123 --json
gh-symphony doctor --smoke --issue DEV-54
```

Without `--issue`, doctor auto-selects one active live issue from the managed project. If none is suitable, the report explains which active states it expected and suggests re-running with `--issue`.

`gh-symphony doctor --fix` extends the regular diagnostic flow with safe remediation and guided follow-up:

When cwd is a project folder whose runtime config was cached by `project start`,
diagnostics resolve that project before the registry's `activeProject`. Explicit
`doctor --project-dir <path>` or `workflow preview --project-id <projectId>`
selection wins over cwd; outside such a folder, `activeProject` remains the
fallback.

- creates missing config/runtime/workspace directories
- launches `gh auth login` or `gh auth refresh` when a TTY is available, otherwise prints the exact command to run
- launches `gh-symphony workflow init` when `WORKFLOW.md` is missing or invalid
- launches `gh-symphony setup` when project setup or GitHub Project binding must be repaired
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
- project runtime selection plus GitHub Project binding resolution
- runtime/workspace path writability
- project `WORKFLOW.md` presence and parse validity
- runtime command availability on `PATH`
- with `--smoke`: linked repository readiness, live issue readability, strict prompt rendering, and hook path resolution

Use JSON output for scripts and CI smoke checks. `--fix --json` includes a remediation section where each step is reported as `applied`, `skipped`, or `manual`.

```bash
gh-symphony doctor --json
gh-symphony doctor --fix --json
gh-symphony doctor --smoke --json
gh-symphony doctor --bundle --json
gh-symphony project start --project-dir <path> --once
```

JSON output includes the resolved auth source as `env` or `gh`.

## Command Reference

```
Setup:
  setup               Generate WORKFLOW.md and initialize the cwd project
  workflow init       Interactive repository setup wizard
  workflow validate   Parse and strictly validate WORKFLOW.md
  workflow preview    Render the final worker prompt from a sample or live issue
  doctor              Run diagnostics, smoke checks, and optional remediation
  config show         Show current configuration
  config set          Set a configuration value
  config edit         Open config in $EDITOR

Orchestration (project):
  project list        List cached projects as JSON
  project start       Start the cwd project folder (`project start --help` lists runtime flags)
  project status      Show the cwd project folder's status
  project stop        Stop the cwd project folder's daemon
  --project-dir <dir> Address an explicit project folder

Global Options:
  --config <dir>      Config directory (default: initialized cwd runtime, then ~/.gh-symphony)
  --verbose           Enable verbose output
  --json              Output in JSON format
  --no-color          Disable color output
  --help, -h          Show help
  --version, -V       Show version
```
