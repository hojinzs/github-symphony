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

`gh-symphony workflow init` generates skill files under `.codex/skills/` (or `.claude/skills/` for Claude Code). These skills define how the AI agent handles commits, pushes, pulls, and project status transitions. The generated `/land` skill gives merged PRs precedence over failure classification and treats review threads created before a qualifying approval on the current PR head as absorbed by that approval. Ready-state review classification remains policy owned by the project folder's `WORKFLOW.md`; it is not part of the Land-triggered skill. The generated `/gh-symphony` skill includes `references/` files that can be customized or extended without adding CLI flags.

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
`runtime.timeouts.*`. Each explicit runtime timeout takes precedence over its
legacy `codex.*_timeout_ms` counterpart; omitted runtime fields inherit legacy
values, with documented defaults used when neither location provides a value.

In JSON output, effective timeout values are exposed as
`summary.runtimeTimeouts.{readTimeoutMs,stallTimeoutMs,turnTimeoutMs}`. These
replace the former `summary.codex.*TimeoutMs` fields, which could report values
that the runtime did not use; no compatibility aliases are emitted.
Per-field origins are exposed as
`summary.runtimeTimeoutSources.{readTimeoutMs,stallTimeoutMs,turnTimeoutMs}` so
partial `runtime.timeouts` blocks identify which values came from
`runtime.timeouts` and which came from `codex/defaults`.

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

The orchestrator retains tracker and Git publication credentials at the worker
host boundary, enabling polling and host-side tools while the agent child
remains credential-free. Project `.env` credentials take precedence over the
daemon's resolved credential. The required direct token must also permit
repository pushes. `gh-symphony doctor` validates the operator-facing host
authentication and tracker/project resolution. Without usable host credentials,
startup fails before the agent launches; known-empty dispatches are skipped and
surfaced in status snapshot warnings.

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

Run `gh-symphony workflow validate` for local schema errors, hook path syntax errors, immediately resolvable missing or non-executable hook scripts, and warnings. Repository-relative run hooks are reported as deferred until an issue workspace is available. Ignored `agent.max_concurrent_agents_by_state` entries warn with their paths and reasons, while valid entries in the same map remain active; `gh-symphony doctor` reports the same warning alongside live drift checks such as missing Project fields, missing labels, unmapped live options, stale mappings, and active issues whose priority-like value resolves to `priority = null`. Strict front-matter failures use stable workflow error codes; `workflow validate --json` also emits the failing `error.path`.

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
`project start` enforces script-path validity when this flag enables execution,
while `doctor` reports invalid declared paths even when hooks are disabled.

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

Automation can stop a persisted, verified target with:

```bash
gh-symphony --json project stop --project-dir <path> \
  --expected-pid <pid> --expected-process-identity "<identity>"
```

Both expected-target options must be supplied together, and cannot be combined
with `--force`. The identity is the exact OS process identity recorded in the
project's PID/lock record, passed as one argument. This mode compares the PID,
identity, canonical folder and both project locks without the legacy recovery
fallback. It never deletes PID or lock records. JSON output contains `outcome`
and `pid`: `superseded_target` and `process_unverified` exit 1; `signal_sent` and
`already_stopped` exit 0. Invalid arguments exit 2.

The CLI uses a private local Unix socket, and only the matching target signals
itself with SIGTERM. This prevents PID reuse between caller verification and
signal delivery from stopping a replacement process. The endpoint starts while
the project locks are held, before daemon readiness, and closes on shutdown.
Older daemons without this endpoint fail with `process_unverified`; restart
them with the new CLI before using expected-target mode. Folder-only stop keeps
its existing behavior.
Expected-target stop supports Linux/macOS daemons, or foreground processes
started from the selected project folder. Foreground starts from another CWD
with `--project-dir` fail closed in this mode. If endpoint setup fails, ordinary
startup continues with a warning and expected-target stop returns
`process_unverified`. Ordinary startup on other platforms skips the endpoint.

`signal_sent` is a delivery acknowledgment, not proof of exit. The management
adapter must verify exit, lock release, and absence of a replacement within its
completion deadline. `already_stopped` requires exit and released locks; a stale
PID record belonging to that same exited target may remain. No SIGKILL escalation
occurs in expected-target mode. A broken or removed workflow does not block stop.

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

Use a project folder as an orchestration instance decoupled from the repository it targets. The folder owns `WORKFLOW.md` (with `repository.slug: owner/name`), plus its `hooks/after_create.sh`, optional `.mcp.json`, `.env`, and `.agent/skills/`. The orchestrator creates issue directories and invokes `after_create`; the shipped default hook fully clones the target and checks out the project-scoped issue branch so the host publication transport can fetch the branch from the workspace. `start` derives and caches configuration from the folder on every run; `status` and `stop` address the same runtime by folder without reading `WORKFLOW.md`.

Create the folder with `gh-symphony workflow init` to scaffold
`hooks/after_create.sh` with executable permissions. Hand-built folders may
copy that generated script or symlink the configured path to an executable
regular file. `project start` and the default `doctor` run validate project-root
and absolute hook paths immediately, report their resolved absolute paths, and
surface repository-relative run/remove hooks as deferred until an issue
workspace exists. Invalid hook configuration stops the project before issue
retry accounting begins.

Only one orchestrator may own an accessible canonical project folder, even when
separate `--config` runtime roots, temporary directories, users, or mount
namespaces are used. Startup retains the project lock in each runtime root and
additionally acquires a `.gh-symphony-start.lock` identity lease in the project
folder; both use lease heartbeats and process-owner identity validation so stale
owners can be reclaimed safely.

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
`workflowRevision`. When the configured repository is local, status also shows
the project workflow's source path, content revision, relationship to repository
history, and current committed repository-policy revision. `doctor` warns when
a regular-file copy matches an older repository revision, but treats a symlink,
current copy, or never-related independent policy as a distinct non-warning
identity. A repository with no committed `WORKFLOW.md` is a separate
`no-repository-policy` non-warning identity. If the committed ref or checkout cannot be read, `doctor` reports the
comparison as a warning rather than passing it. Relative local clone paths are
resolved from the command's repository working directory; remote clone URLs
use the project's newest usable live issue checkout or run working directory,
skipping removed, missing, or non-Git persisted paths and never using an
unrelated operator cwd. The comparison never fetches from the network.

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

Optional `observability.otlp` workflow policy defaults to disabled. Set
`enabled: true` with an HTTP/protobuf endpoint to export Logs and Metrics through
the audited CLI pipeline. Ambient `OTEL_*` settings alone do not activate export.
The orchestrator validates enabled transport settings before dispatch and excludes
exporter credentials from workers and hooks. Exporter auth references must use
separate names from agent/tracker credentials, even when OTLP is disabled.
Durable local events and committed status remain authoritative; publication
failures cannot fail a tick or mark coordination unhealthy. CLI startup supplies
the internal capability and release version after clean-install/performance gates;
independent library owners retain the default rejection guard. Construction
failures report once and exit with code 1, releasing locks and stopping the service.
Valid OTLP edits require
restart; additive JSON status reports applied versus pending settings and safe
exporter health separately from coordination errors. See the
[OTLP configuration contract](../../docs/configuration.md#otlp-workflow-policy-exporter-support-pending).

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
`doctor` and live `workflow preview` resolve that project. Explicit
`doctor --project-dir <path>` or `workflow preview --project-id <projectId>`
selection wins over cwd. Outside a cached project folder, diagnostics select
only a sole configured project; with multiple projects, pass an explicit
selection. Diagnostics do not use the removed instance registry or a legacy
`activeProject` value as a fallback.

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

The internal [management protocol](../management-protocol/README.md) package defines the v1 agent/fleet
transport boundary for the planned management extension. It adds no CLI commands;
existing project commands and the per-project web server retain their behavior.

The internal [fleet services](../fleet-control-plane/README.md) adds private SQLite migrations
and typed HTTPS-origin configuration for C04 (#1008). C07 (#1011) adds the
internal lifecycle command ledger and recovery library: durable idempotency,
claim deadlines, project fences, result reconciliation and audited unknown
closure. Consumers supply authenticated session/project peers; fleet listener
installation and new CLI commands remain separate. Its enrollment service
provides atomic one-use tokens, scoped credential verifiers and transactional
revocation, plus bounded same-origin browser sessions and CSRF validation. Fleet CLI commands and listener composition belong to later consumers;
per-project `--web` retains its existing behavior.

The internal [local management adapter](../management-agent/README.md) adds canonical folder allowlists,
private enrollment persistence and typed lifecycle operations (C03, #1007).
`project status` and `project stop` resolve a folder's existing alias-started
runtime while retaining its runtime ID. Configured project/workflow paths establish
folder ownership; a process's working directory cannot select an unrelated runtime.
Unreadable or ambiguous runtime lookup produces a diagnostic and exit code 1.
A missing/invalid workflow remains
visible and does not prevent verified expected-target stop. The bundled
`@gh-symphony/cli/management-local` module supplies the local driver; this does
not add an `agent` command or change the per-project `--web` server into a fleet
service. Native service launchers remain a separate implementation boundary.

The bundled `@gh-symphony/cli/management-local` module also exports
`createLocalReadAdapter(registry, configDir)` (C09, #1013). It resolves the
registered folder's existing runtime and returns bounded recent run history,
projected run detail and fixed `orchestrator`/`worker`/`events` log streams.
Responses contain at most 256 KiB of UTF-8 log text with a scoped byte cursor;
rotation/truncation reports reset, and missing or escaping selections report
unavailable. Read access survives invalid workflow and has no process effects.
Raw logs may contain sensitive text and are restricted to trusted operator access.

### OTLP diagnostics

Doctor shares the runtime’s SDK-free OTLP credential ownership and resource validation.
Remediation reports fixed validation reasons without endpoint or header values; unknown
errors retain generic guidance. Custom resource values must be finite scalars, and
`service.instance.id` is reserved for the runtime. Disabled checks never probe OTLP.

`gh-symphony doctor` validates the project's `observability.otlp` settings using
its effective environment without loading an OpenTelemetry SDK or contacting the
Collector. Shared agent/tracker auth references fail before value resolution
or probing, including disabled policy. Enabled resource metadata uses the startup
limits and reserved identity checks. `doctor --otlp-probe` explicitly sends an empty protobuf export request
for each enabled signal, with a three-second budget per signal. Disabled policy
and `OTEL_SDK_DISABLED=true` skip all OTLP connections. Reports include safe
endpoints, header names and HTTP outcomes; they omit credentials and remote
response bodies. HTTP success alone does not prove telemetry receipt.

`gh-symphony project status` displays applied and pending exporter settings and
whether a restart is required. The applied exporter remains active until restart,
even when the pending policy disables export. JSON status retains the additive
`telemetry` projection. Existing `logs --level` filters retain their severity
mapping. The audited CLI now supports production YAML enablement for Logs and Metrics.

### Clean package boundary check

Run `pnpm --filter @gh-symphony/cli test:package` to build and install the npm
tarball into a temporary production-only installation. The check resolves the
bundled lazy OpenTelemetry SDK chunks, rejects SDK evaluation by the CLI version
command and idle worker entry, and executes the installed management, MCP and
credential-helper entries. It reports tarball bytes separately from runtime
performance. Startup/RSS/offer benchmarks and packed lifecycle/reload checks are
separate release gates; the smoke check alone is insufficient release evidence.

### Packed OTLP performance audit

After `pnpm build`, run from `packages/cli`:

```bash
node scripts/otlp-package-audit.mjs /absolute/baseline.tgz /tmp/otlp-report.json /absolute/baseline-source <baseline-commit-sha> --production-cli
```

Build the baseline from a separate source archive and pack it before running the
comparison. The audit installs both tarballs with production dependencies only,
counterbalances 30 fresh processes per build on the same empty file-tracker
project (each build runs first in fifteen pairs), and writes
raw startup/RSS samples, loaded modules, sizes and threshold results to the
external JSON report, including the complete startup order. All samples count
toward the unchanged thresholds; outliers are not filtered. Reports also retain
candidate tarball SHA-256, chronological pair/position/start timestamps and elapsed
times, plus host load averages, memory and cumulative CPU counters immediately
before and after startup sampling. These are diagnostic observations only; they
never override a failing gate. No process command lines or host identity are collected. RSS is sampled after the single idle reconciliation, at
process exit. Healthy, 100ms slow and unavailable transport fixtures each receive
1,000 bounded synchronous event/tick offers; the audit verifies transport was
actually exercised. Separate child processes measure 30 full serialized
reconciliation ticks for disabled baseline/candidate and enabled healthy/slow/down
receivers. The audit verifies authenticated protobuf exports with the CLI release
version, applied/pending disable/endpoint reloads, invalid last-known-good recovery,
revert, bounded shutdown, and normal YAML-enabled CLI startup.

The audit also rejects SDK evaluation and receiver connections for disabled or
omitted enable policy and the SDK-disabled veto. Packed doctor checks verify
validation-only network silence, disabled explicit probes, both enabled signal
probes, and credential-free output. A failing startup/RSS/offer threshold returns
a nonzero exit status. Tarball, installed dependency and ESM bytes are reported
separately, without a size threshold. A release must keep the CLI capability off
if any packaged or performance gate fails. The `--production-cli` audit argument
checks the final startup composition; omit it when auditing a candidate whose
production capability is still off. These loopback fixtures prove shipped
behavior, while actual Collector dogfood receipt remains a separate Epic gate.

OTLP doctor probes own their HTTP sockets and destroy stalled connections at the
three-second deadline, allowing the command to exit after reporting the result.
HTTP/TLS probe transports load only for an explicit enabled probe; status
rendering and validation-only diagnostics leave them unloaded.

The bundled `@gh-symphony/cli/management-agent` module provides C05 enrollment
and foreground outbound HTTPS transport for application/service composition.
C08 adds `CommandJournal` and `CommandExecutor` for durable claim replay,
verified lifecycle execution and read-only restart reconciliation:

```ts
import {
  AgentRegistry,
  createAgentTransport,
  enrollAgent,
  runForegroundAgent,
  CommandJournal,
  CommandExecutor,
} from "@gh-symphony/cli/management-agent";
```

Enrollment persists a user-only identity and resumes without another token.
Foreground consumers supply an AbortSignal and typed inventory/delivery adapters;
heartbeats and polling run independently with bounded reconnect backoff.
Transient inventory/delivery adapter failures retry with sanitized diagnostics and
fresh snapshots. Enrollment stays awaiting-signal through expiry or fleet restart
until its first authenticated observation.
This module adds no command or listener. Guided setup (C13, #1017) and fleet
route assembly retain their sibling boundaries; C06 supplies inventory projection.
Use `createDeliveryHandler` to compose command and read handlers while the
foreground runtime holds the registry lock. The factory handler receives empty
polls too, allowing durable result retry and recovery without redelivery.
Existing `gh-symphony project` and per-project `--web` commands keep their behavior.

The same bundled module exports C11 `LinuxAgentService` and
`createLinuxProjectLaunchContext` for trusted Linux service composition. Install,
start/restart/stop/status/uninstall manage only the user-owned agent unit; project
daemons launch in separate retained systemd units. Before launch, empty retained
units are reclaimed with identity/cgroup checks; live units remain untouched.
Diagnosis rejects non-default manager XDG configuration and legacy/hybrid cgroups. Linux requires systemd 254+,
a reachable user manager and cgroup v2 for isolated launch. Missing linger limits
boot/logout startup; diagnosis explains `loginctl enable-linger` without changing
privileges. See the [Linux adapter contract](../management-agent/README.md#linux-user-service-packaging-c11)
for absolute paths, the C13 entrypoint boundary and installation recovery. Native
OS validation remains separate from command-fixture evidence.

The internal [fleet observation service](../fleet-control-plane/README.md) provides C06 cached inventory
queries, receipt-based offline/stale state, paged project lists and advisory
tracker-scope warnings. Complete uploads change membership atomically; partial
uploads retain unseen projects. These library boundaries are separate from the
existing `gh-symphony project` commands and per-project `--web` server; fleet HTTP
and UI assembly is supplied by the separate `control-plane run` command (C23).

The bundled `@gh-symphony/cli/management-agent` module exports
`createInventorySnapshot` for the foreground runner and its authenticated
`ProjectIdentityResolver` composition port. It publishes current redacted
allowlist data after recovery; it does not buffer old inventory across outages.

Fleet project UUIDs follow enrollment generations: replacement agents allocate new
identities while earlier observations remain stale history. Same-agent reconnects
retain UUIDs. Allocation caps outstanding unpublished identities at 100 per
environment; see the fleet service README for migration and recovery behavior.

The [C10 fleet read lane](../fleet-control-plane/README.md#bounded-read-lane-c10) supplies bounded
run/detail/log requests and route dispatch for a consuming private fleet service.
It has no new CLI command; existing project and per-project web usage is unchanged.

### macOS management-agent user service (C12)

The bundled `@gh-symphony/cli/management-agent` module now exports
`MacOSAgentService` and `launchMacOSProject` for local service composition.
Install/start/status/stop/restart/uninstall operate only on the current user's
LaunchAgent and preserve management identity and managed orchestrators. Public
agent command routing remains C13-owned. Login startup requires the real OS user
home; no pre-login boot or logout survival is promised. See the management-agent
package README for the typed configuration and TC-31 native validation.

The internal [C16 fleet project UI](../fleet-control-plane/README.md#project-presentation-boundary-c16)
exports read-only fleet/detail route composition with Graphite responsive rows,
fresh-only workspace totals and historical offline labels. A consuming private
fleet HTTPS listener supplies environment records and optional lifecycle/history
links. This adds no fleet CLI command; `gh-symphony project` and per-project
`--web` keep their existing behavior.

The C17 fleet lifecycle UI composition adds Stop confirmation, durable command
history and reviewed unknown-outcome closure with a required reason. Current
process observations remain independent from command outcomes. The internal
fleet package exports a private-listener dispatcher; this adds no CLI command
and preserves `gh-symphony project` and per-project `--web` behavior.

## Host management agent (C13)

Use the same Node.js 24+ CLI installation for local `project` commands and the
host management agent:

```bash
npm install -g @gh-symphony/cli
gh-symphony --version
gh-symphony agent --help
gh-symphony agent setup --help
gh-symphony agent setup --server https://symphony.lan
```

Paste the one-use enrollment token at the hidden prompt. Automation may pipe one
token using `--token-stdin`; never put a token in an argument. Setup checks native
service prerequisites, saves enrollment, installs and starts the current user's
service, and reports its stages and auto-start limits. If installation/start
fails after enrollment, rerun the same setup command: saved identity resumes
without another token, and project registrations stay intact. A different server
is rejected; repair local configuration explicitly rather than replacing identity.
An already-running agent owns the registry lock; use service status/stop before
setup or foreground recovery.

```bash
gh-symphony agent enroll --server https://symphony.lan  # enrollment only
gh-symphony agent service install                     # install without starting
gh-symphony agent service start
gh-symphony agent service status
gh-symphony agent service restart
gh-symphony agent service stop
gh-symphony agent run                                 # foreground, same owner lock
gh-symphony agent project add /srv/projects/prepared
gh-symphony agent project list
gh-symphony agent project remove <local-project-id>
gh-symphony agent service uninstall
```

Stop the agent before editing its local folder allowlist, then start it again.
Add registers an existing folder, including an unstarted/invalid workflow for
local inspection; it does not create a project. Remove only revokes management.
Service stop/restart/uninstall preserve identity, registrations and command journal.
They do not stop project orchestrators. Linux requires systemd 254+ with a unified
cgroup v2 user manager. Boot/logout persistence requires linger; setup reports
`loginctl enable-linger` guidance without privilege elevation. Unsupported Linux
managers use enroll plus foreground run. macOS LaunchAgents start at login, not
before login, and stop at logout. Session teardown/machine shutdown preservation
is not promised.

Agent host configuration defaults to `~/.gh-symphony-agent/config.json`, with a
private 0700 directory and 0600 file. `--agent-config <file>` selects another file
on every leaf command. Setup/enroll create defaults once; subsequent invocations
preserve them. The global `--config <dir>` selects the project runtime directory
when those defaults are created. Set private CA trust and absolute executable,
project-config and agent-data paths in that local file; see
[agent configuration](../../docs/configuration.md#guided-agent-cli-configuration-c13).
No token/credential is written into service arguments or this host-path config.

This slice exposes the typed `AgentRuntimePorts.resolveIdentities` composition
boundary in `@gh-symphony/cli/management-agent`. The v1 protocol has no fleet UUID
allocation HTTP endpoint yet. Default `agent run` supports the enrolled zero-project
first signal; registered-project publication reports
`inventory_identity_allocation_unavailable` until that fleet composition is
supplied. The typed fixture verifies actual inventory and bounded-read adapters;
this is not a claim of complete fleet UI/runtime acceptance. Existing local
`project` and per-project `--web` remain available. Fleet server deployment and
its `control-plane` command assembly are separate from this agent slice.

The built package version is reported by `--version`; C13 is available in the
source-built tarball until its patch release is published. Consolidated clean-host
release installation and full native service acceptance remain the C19–C21 gates.

The internal [C18 run/log view](../fleet-control-plane/README.md#runlog-presentation-state-c18)
adds paged retained history, allowed-stream selection and bounded follow.
The consuming private fleet listener mounts run/project/read dispatchers and
ships `dist/browser/` with local assets. Reads are limited to known run IDs,
256 KiB chunks and a 30-second lifetime. Rotation needs explicit reset;
offline fetched content remains historical and reconnect leaves follow paused.
An expired browser session preserves content and prompts a page reload.
This adds no CLI command or change to per-project `--web`.

After a Node.js or CLI upgrade, saved agent `nodePath` and `cliPath` may point
to removed version-specific files. Re-running setup preserves these paths.
Stop the agent service, edit only these two absolute paths in the private
`config.json` (preserving mode 0600 and the data directory), then rerun
`agent setup --server <existing-origin>` to reinstall and start the service.
Keep the registry and journal intact so enrollment and registrations resume.
An unknown `agent project remove <id>` fails with `project_unmanaged`;
use `agent project list` to find the registered ID.

The internal [C15 environment UI](../fleet-control-plane/README.md#environment-connection-ui-c15)
adds list/connection route composition for a consuming private fleet listener.
The dialog copies `gh-symphony agent setup --server '<configured-origin>'` and
the ten-minute single-use token separately; paste the token into the hidden
terminal prompt. Close/reopen preserves the environment without recovering the
old secret. Enrolled hosts resume setup with their saved identity; an online
host with zero projects is successful. This slice adds no fleet listener command
and does not change per-project `--web` behavior.

#### Startup repeatability on shared hosts

Before measuring, finish builds/installs and avoid overlapping audits or test
suites. On macOS use an otherwise idle host, stable power/thermal conditions and
the same Node executable, baseline archive and candidate build. Do not stop other
users' processes to manufacture a quiet interval. Record OS/architecture, Node,
source SHAs, tarball hashes, start time and any known concurrent workload outside
the checkout. A container is not a macOS scheduling control.

Predeclare three complete sequential audit runs with distinct external report
paths; retain every exit code and report, including failures. Inspect
`startupTimeline` by pair and position together with `startupHost` before/after
load and CPU deltas. Correlated stalls support a host-interference hypothesis,
but neither correlation nor load averages prove causation. The 30-sample p95 is
the 29th sorted sample, so two slow samples can move it substantially.

For a negative control, pack the built candidate first and run the same protocol
using that tarball as the baseline input, the candidate source directory and SHA
as the baseline metadata, and the same capability flag. The audit packs the
unchanged candidate source again; verify matching tarball hashes in the report.
This identical-build comparison tests measurement repeatability; it does not
measure growth against the pre-SDK baseline. Keep the
baseline/candidate comparison separate. If noise remains, preserve failures and
repeat the predeclared set on a quieter host; never select only passing runs,
remove samples, increase thresholds or convert a failed activation gate to a
pass. Persistent candidate-only slowdown under controlled conditions warrants
profiling the package. Unresolved variance leaves activation acceptance open.
Report native macOS and Linux/container evidence in separate tables, including
unavailable environments explicitly. Linux success cannot clear a macOS failure.

## Fleet control plane (C23)

```bash
gh-symphony help control-plane
gh-symphony control-plane run --config ./control-plane.yaml
```

This foreground command serves the fleet management UI/APIs and the outbound
agent protocol, separate from the per-project `--web` server on `:4680`. Use the
[fleet YAML example](../fleet-control-plane/README.md#runnable-configuration-contract-c23)
with an HTTPS public origin, TLS certificate/key and private data directory.
Defaults are `127.0.0.1:4690` and `~/.gh-symphony-control-plane/`; public/wildcard
binds are rejected and occupied ports fail without fallback. TLS paths resolve
relative to the file. With a trusted HTTPS reverse proxy, choose
`transport: { mode: trusted-proxy }` and retain a loopback backend; preserve the
configured public Host and browser Origin. There is no human login in this
private-network release.

Wait for the JSON `fleet-ready` event, then open the configured HTTPS origin at
`/environments`; `/projects` links to project details and Runs. `GET /healthz`
returns `{"status":"ready"}` and requires the configured Host (including its
port). For a local proxy backend check, use `curl -H 'Host: symphony.lan'
http://127.0.0.1:4690/healthz`. Trust your private CA on the browser and configure
the agent's `caFile` when needed; never disable certificate verification.

SIGINT/SIGTERM cancels long polls, drains the listener and closes storage. Wait
for exit before backing up `fleet.sqlite`; restart preserves saved environments,
while agents reopen sessions using their persisted credentials. Zero-project
agents can enroll and report their first signal. Authenticated project identity
allocation remains the separate #1061 slice. The packaged CLI includes fleet
SVG assets and the bounded-log browser script; no CDN is required.
