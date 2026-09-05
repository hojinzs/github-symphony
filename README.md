# GitHub Symphony

> **CLI migration:** `The 'repo' command has been removed. Use 'gh-symphony
project start --project-dir <path>'.` See the
> [CLI migration note](packages/cli/README.md#repository-command-migration),
> including the required daemon restart after upgrading.

[![CI](https://github.com/hojinzs/github-symphony/actions/workflows/ci.yml/badge.svg)](https://github.com/hojinzs/github-symphony/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@gh-symphony/cli?logo=npm)](https://www.npmjs.com/package/@gh-symphony/cli)
[![Node.js 24+](https://img.shields.io/badge/node-24%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/code%20of%20conduct-active-blueviolet.svg)](CODE_OF_CONDUCT.md)

GitHub Symphony is a multi-tenant AI coding agent orchestration platform built on the [OpenAI Symphony specification](https://github.com/openai/symphony). A CLI-first orchestrator polls GitHub Projects for open issues, dispatches worker runs per repository, and resolves workflow policy from the project folder's `WORKFLOW.md` at runtime.

GitHub Symphony is an MIT-licensed open source project. Contributions are welcome: start with the [contributing guide](CONTRIBUTING.md), follow the [Code of Conduct](CODE_OF_CONDUCT.md), use the GitHub issue templates for bug reports and feature requests, and report security issues through [SECURITY.md](SECURITY.md). For setup or orchestration failures, include a redacted support bundle from `gh-symphony doctor --bundle` when opening a bug report.

## Requirements

- **[Node.js](https://nodejs.org/)** v24+ with npm
- **[Git](https://git-scm.com/)**
- One existing GitHub Project for the repositories you want Symphony to manage
- One AI agent runtime on `PATH` before `gh-symphony project start --project-dir <path>`:
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

Prerequisites: Node.js 24+, Git, GitHub auth with `repo`, `read:org`, and `project` scopes, one authenticated runtime such as `codex` or `claude`, and an existing GitHub Project.

```bash
npm install -g @gh-symphony/cli
gh-symphony doctor

mkdir my-symphony-project && cd my-symphony-project
gh-symphony setup
gh-symphony project start --project-dir "$PWD" --once
```

If `doctor` reports missing prerequisites, run `gh-symphony doctor --fix` for safe local remediation guidance. After the one-shot run succeeds, start continuous orchestration with:

```bash
gh-symphony project start --project-dir <path>
```

## Getting Started

### 1. Install Package

```bash
npm install -g @gh-symphony/cli
```

Or use the official container image:

```bash
docker pull ghcr.io/hojinzs/github-symphony:latest
docker run --rm ghcr.io/hojinzs/github-symphony:latest gh-symphony --version
```

Verify the installation:

```bash
gh-symphony --version
```

The npm package also ships the internal `dist/mcp-server.js` and
`dist/git-credential-helper.js` subprocess entry points used by worker runtimes.
They are implementation details of the CLI and are validated from the packed
tarball during release testing.

Validate the local prerequisites before setup:

```bash
gh-symphony doctor
gh-symphony doctor --fix
gh-symphony doctor --json
gh-symphony doctor --smoke
gh-symphony doctor --bundle
```

Token-only validation works without `gh`:

```bash
GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token gh-symphony doctor --json
```

For the full list of operator knobs, runtime credentials, GHES overrides, and
auto-injected worker variables, see
[Configuration: Environment Variables](docs/configuration.md#environment-loading-order).

### 2. Run Setup

Create a project folder outside the target repository, then run:

```bash
mkdir my-symphony-project && cd my-symphony-project
gh-symphony setup
```

The one-command setup flow will:

1. Authenticate via `GITHUB_GRAPHQL_TOKEN` or fall back to `gh` CLI
2. Let you select a **GitHub Project**
3. Map project status columns to workflow phases (active / wait / terminal)
4. Configure the project folder for the orchestrator
5. Generate the following files:

| File                                    | Description                                                       |
| --------------------------------------- | ----------------------------------------------------------------- |
| `WORKFLOW.md`                           | Workflow policy — the agent prompt template with lifecycle config |
| `.codex/skills/` (or `.claude/skills/`) | Agent skill definitions, including `/gh-symphony` references      |

Before writing anything, the interactive wizard shows a final summary of the
project folder and generated workflow.

When the selected GitHub Project links multiple repositories, setup outside a
repository checkout selects the first linked repository. Verify
`repository.slug` in the generated `WORKFLOW.md` and correct it before starting
Symphony if the project should target a different repository.

Non-interactive mode:

```bash
gh-symphony setup --non-interactive
```

If non-interactive setup needs an explicit GitHub Project selection, run the two setup commands directly:

```bash
GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token gh-symphony workflow init --non-interactive --project PVT_xxx --output WORKFLOW.md
GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token gh-symphony setup
```

### 3. Run a Smoke Tick

Run one production-like orchestration tick before starting a long-lived poller:

```bash
gh-symphony doctor --smoke
gh-symphony project start --project-dir <path> --once
```

`doctor --smoke` validates the configured tracker, repository workflow, runtime command, workspace root, and hook paths without dispatching a worker. GitHub projects validate their Project binding; Linear projects read through the Linear adapter without requiring one. `project start --once` then performs startup cleanup plus one poll/reconcile/dispatch tick and exits.

Use an explicit issue when you want a deterministic preflight:

```bash
gh-symphony doctor --smoke --issue owner/repo#123
# Linear: gh-symphony doctor --smoke --issue DEV-54
```

### 4. Run the Orchestrator

```bash
gh-symphony project start --project-dir <path>                   # Start (foreground)
gh-symphony project start --project-dir <path> --daemon          # Start (background)
gh-symphony project stop --project-dir <path>                    # Stop the daemon
gh-symphony project stop --project-dir <path> --force            # Force stop with SIGKILL
gh-symphony project start --project-dir <path> --web             # Browser control-plane dashboard at http://127.0.0.1:4680/
gh-symphony project start --project-dir <path> --web --bind-all  # Explicitly bind the dashboard to all interfaces
```

Monitor from the terminal:

```bash
gh-symphony project status --project-dir <path>                  # Show current status
gh-symphony project status --project-dir <path> --watch          # Live terminal status
```

For each active run that has a recorded digest, the status view labels and displays the opaque
`sha256:...` project-environment digest. Compare this value across runs to
detect project `.env` changes; Symphony never exposes environment names or
values through this surface.

### Observability Surfaces

Use `gh-symphony project start --project-dir <path> --web` when you want the browser-based
control-plane dashboard. It starts the orchestrator and serves the React SPA at
`http://127.0.0.1:4680/` by default. The dashboard includes the project
overview at `/` and per-issue detail pages at `/issues/<encoded-identifier>`,
where issue identifiers such as `acme/web#42` are URL-encoded as
`acme%2Fweb%2342`. It is backed by the same JSON API used for status snapshots
and refresh.

HTTP servers bind to `127.0.0.1` unless `--bind-all` is explicitly supplied.
Every `/api/v1/*` request requires the bearer token printed by `project start`.
Set `GH_SYMPHONY_HTTP_TOKEN` to provide a stable shared secret; otherwise the
CLI generates one for the process. The `--web` launch URL carries the token in
the URL fragment, moves it to session storage, and removes it from the visible
URL before API requests begin.

Use `gh-symphony project start --project-dir <path> --http` when you only need the JSON status API, for
example from CI, scripts, or another monitoring process. It exposes
`/api/v1/state`, `/api/v1/<encoded-identifier>`, and
`POST /api/v1/refresh`, but `/` is not a browser dashboard. Use
`project status --watch` for an interactive terminal view. For scripts, send
`Authorization: Bearer $GH_SYMPHONY_HTTP_TOKEN`.

## End-to-End Walkthrough

This walkthrough shows the default happy path for one repository after
`gh-symphony setup` has generated a project folder with `WORKFLOW.md`.

1. Create or pick one issue in the managed repository, for example `acme/web#42`.
2. Add that issue to the GitHub Project selected during setup.
3. Move the Project item into a status that `WORKFLOW.md` maps to an active phase, such as `Ready` or `In progress`.
4. Run one orchestration tick:

   ```bash
   gh-symphony project start --project-dir <path> --once
   ```

5. Symphony reads the Project item, checks that the repository and issue are dispatchable, creates an issue workspace under `workspace.root` (by default `<project-dir>/.runtime/workspaces`), and starts the configured worker runtime.
6. The worker receives the rendered issue prompt, follows the project folder's `WORKFLOW.md`, makes the requested change on a feature branch, and opens a draft PR linked back to the issue.
7. Inspect the result:

   ```bash
   gh-symphony project status --project-dir <path>
   gh pr list --repo acme/web --search "42"
   ```

The expected first success is an opened PR for the managed issue. After that, the lifecycle continues through the statuses and handoff rules encoded in the project `WORKFLOW.md`.

If GitHub reports that the source issue is already closed, or that a linked closing PR is merged, Symphony does not dispatch a worker even when the Project item was accidentally left in an active status. It reconciles that Project item to the first terminal status configured in `WORKFLOW.md` and emits a `tracker-terminal-candidate-reconciled` event.

If the issue does not dispatch, inspect `project status --watch`, the dashboard, and the run events under the configured runtime directory.

## Advanced Setup Options

### Workflow Only

Use `workflow init` when you want to generate or update project workflow files
without running the full setup:

```bash
cd my-symphony-project
gh-symphony workflow init
```

Preview and validate generated files without writing anything:

```bash
gh-symphony workflow init --dry-run
gh-symphony workflow validate
gh-symphony workflow preview --issue owner/repo#123
gh-symphony doctor --smoke --issue owner/repo#123
```

The interactive wizard will:

1. Authenticate via `GITHUB_GRAPHQL_TOKEN` or fall back to `gh` CLI
2. Let you select a **GitHub Project** to bind
3. Map project status columns to workflow phases (active / wait / terminal)
4. Generate the following files:

| File                                    | Description                                                       |
| --------------------------------------- | ----------------------------------------------------------------- |
| `WORKFLOW.md`                           | Workflow policy — the agent prompt template with lifecycle config |
| `.codex/skills/` (or `.claude/skills/`) | Agent skill definitions, including `/gh-symphony` references      |

Project discovery is pagination-aware for larger GitHub accounts, so personal projects, organization pages, and organization-owned projects are fetched across multiple API pages before selection. If the CLI hits a discovery safety cap, it keeps the partial list and prints a warning before you choose a board.

`gh-symphony workflow init --dry-run` resolves the same generated outputs, shows whether each path would be created, updated, or left unchanged, and prints the detected environment inputs that shaped the preview.

Those detected inputs are also threaded into the generated artifacts themselves: `WORKFLOW.md` and the runtime skill templates include repository-aware validation guidance based on the detected package manager, monorepo shape, and explicit validation entry points when present.

`workflow init` is not limited to Node repositories. The detector now recognizes conservative validation signals for:

- JavaScript / TypeScript lockfiles and `package.json` scripts
- Python repositories with `uv.lock`, `poetry.lock`, `pyproject.toml`, `pytest.ini`, and `requirements*.txt`
- Go repositories with `go.mod`
- Rust repositories with `Cargo.toml`
- Top-level command runners such as `Makefile` and `justfile`

When the repository exposes an unambiguous entry point, the generated guidance will prefer commands such as `make test`, `just lint`, `uv run pytest`, `go test ./...`, or `cargo test`. When signals conflict at the same confidence level, the generator intentionally falls back to generic validation guidance instead of guessing.

Token-only interactive setup is supported:

```bash
export GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token
gh-symphony workflow init
```

### Customizing Agent Behavior

The generated skill files (under `.codex/skills/` or `.claude/skills/`) define how the AI agent handles commits, pushes, pulls, and project status transitions. The `/gh-symphony` skill also includes `references/` files for workflow schema details and prompt-body postures (`implement`, `review`, and `maintain`) that can be composed when designing or refining `WORKFLOW.md`.

The generated `/push` skill requests the run-scoped host publication action
after a commit. The credential remains in the worker host, while the assigned
branch becomes available for pull-request creation during the same run. Worker
exit repeats the same fast-forward-only transport as a backstop.

You can further customize the agent's behavior by editing `WORKFLOW.md` or by adding repository-specific reference markdown under the `/gh-symphony` skill's `references/` directory. `WORKFLOW.md` remains the policy layer that controls what the agent does at each workflow phase.

> Currently supported runtimes: **[Codex CLI](https://developers.openai.com/codex/cli/)** and **[Claude Code](https://code.claude.com/docs/en/quickstart)**. The selected runtime command must be installed and authenticated before `gh-symphony project start --project-dir <path>` can dispatch worker runs.

### Explicit GitHub Priority Mapping

GitHub Project V2 priority is repository policy in `WORKFLOW.md`. The runtime uses exactly one configured source and never falls back or guesses renamed labels, Project fields, or option values. Anything unmapped resolves to `priority = null`.

Use a Project single-select field:

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

Or use exact repository labels:

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
```

Or disable priority dispatch explicitly:

```yaml
tracker:
  kind: github-project
  provider:
    priority:
      source: disabled
```

Lower numbers dispatch first. If an issue has multiple configured priority labels, Symphony uses the lowest numeric value and emits `priority.label_conflict_resolved`. If an active issue carries an unmapped configured-source value, it resolves to `priority = null` and emits `priority.unmapped`.

Flat tracker keys such as `tracker.priority_field` are rejected in this major release. Use `tracker.provider.priority.source: project-field`, copy the exact field name, and write explicit option-name-to-number mappings. `gh-symphony doctor` prints a copyable provider block for migration.

`gh-symphony workflow validate` reports local configuration errors, including `workflow_deprecated_key` for removed flat tracker keys, plus warnings for ignored per-state concurrency entries. Each concurrency warning names the ignored `agent.max_concurrent_agents_by_state` path and reason, while valid entries in the same map remain active. With `--json`, `workflow validate` includes both `error.code` and `error.path`. `gh-symphony doctor` additionally checks live Project/repository drift and prints a provider migration block for removed flat keys.

### Token-Only Setup

Token-only setup is supported when exactly one GitHub Project is visible to the token:

```bash
export GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token
gh-symphony setup
```

### Project Commands

```bash
gh-symphony doctor                   # Validate local prerequisites, auth, config, WORKFLOW.md, and runtime command
gh-symphony doctor --fix             # Create safe missing paths and print/run remediation follow-ups
gh-symphony doctor --smoke           # Final preflight: validate a live issue without dispatching work
gh-symphony doctor --bundle          # Export a redacted support bundle for bug reports
gh-symphony setup                # Generate the cwd project configuration
gh-symphony project status --project-dir <path>              # Show project orchestration status
gh-symphony project start --project-dir <path>               # Start this project
gh-symphony project start --project-dir <path> --once        # Run one orchestration tick
gh-symphony project stop --project-dir <path>                # Stop this project
gh-symphony cache status             # Inspect shared bare caches, sizes, locks, and worktrees
gh-symphony cache prune --dry-run    # Preview 30-day cache eviction
gh-symphony cache prune --max-age-days 30 # Remove old idle caches safely
```

### Projects

A project folder is an independent orchestration instance, decoupled from the
repository it targets. The folder owns `WORKFLOW.md` (which must declare
`repository.slug: owner/name`), plus optional `.mcp.json`, `.env`, and
`.agent/skills/`; the referenced repository itself stays unmodified. Issue
workspaces are created under the project's `workspace.root`, relative to the
project folder and defaulting to `<project-dir>/.runtime/workspaces`. They are
populated as worktrees from a shared bare clone cache, and branches default to
`symphony/<project-slug>/<issue-id>`, so multiple projects can orchestrate the
same repository without branch collisions.

If cache storage is unavailable or lock acquisition times out, workspace population falls back to an isolated direct clone. Cache locks heartbeat during long clone/fetch operations. Cleanup is operator-driven: `cache prune` defaults to entries at least 30 days old and skips every locked cache, linked worktree, or cache whose worktree state cannot be verified.

```bash
cd <projectDir> && gh-symphony project start   # Start the project in this folder
gh-symphony project start --project-dir <dir>  # ...or name the folder explicitly
gh-symphony project status                     # Status for the project in this folder
gh-symphony project stop                       # Stop its daemon
gh-symphony project list                       # List cached projects (with live instance metadata when available)
gh-symphony instances --json                    # List active project instances
```

The project folder is the source of truth and the address: every command derives the runtime from the folder's `WORKFLOW.md` on each start, so editing the workflow takes effect on the next start with no registration step. `project start --help` lists its runtime flags, including `--once`, `--daemon`, `--assigned-only`, `--allow-duplicate`, `--bind-all`, `--http`, `--web`, `--log-level`, and `--project-dir`. `--assigned-only` is input to the tracker adapter's `dispatchable` derivation; the scheduler consumes that normalized eligibility result rather than interpreting provider-specific assignment rules. A verified live instance for the same project in another runtime is rejected by default; use `--allow-duplicate` only for intentional isolation. Starting refuses a tracker mapping that overlaps a project already running against the same repository, and asks for confirmation when the overlapping project is stopped. Two projects on one repository stay disjoint through `tracker.provider.pickup_labels.include`, which GitHub and Linear apply as an any-match candidate pre-filter. `tracker.required_labels` is separate: every configured label must remain present for an issue to be routable, including between worker turns. Label comparison is case-insensitive and ignores surrounding whitespace, so `Agent`, `agent`, and `" AGENT "` are the same label. `repository.clone_url` overrides the derived clone URL for mirrors, Enterprise hosts, or local paths. See [docs/configuration.md](docs/configuration.md) for the project `.env` loading order and skill layering details.

### Official Container Deployment

The official image is designed for headless orchestration and defaults to:

- image: `ghcr.io/hojinzs/github-symphony:<tag>`
- project folder mount: `/project`
- default command: `gh-symphony project start --project-dir <path>`
- runtime user: `symphony` (`UID:GID 1000:1000`)

Supported container environment variables:

- `GITHUB_GRAPHQL_TOKEN`: recommended auth source inside containers; requires `repo`, `read:org`, `project`
- `GH_SYMPHONY_CONFIG_DIR`: optional override for the runtime config directory; defaults to `/var/lib/gh-symphony`

See
[Configuration: Environment Variables](docs/configuration.md#auth-and-api-endpoints)
for GHES endpoints, token brokers, runtime credentials, and tuning knobs used by
containerized workers.

Supported volume mounts:

- a project folder: persists `WORKFLOW.md`, `.env`, optional skills, and runtime state across restarts

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
  gh-symphony project start --project-dir <path> --once
```

Initialize the mounted project folder once:

```bash
docker run --rm -it \
  -e GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token \
  -v "$(pwd):/project" \
  -w /project \
  ghcr.io/hojinzs/github-symphony:latest \
  gh-symphony setup --non-interactive
```

Then start the long-running orchestrator from the initialized project folder.
The mounted directory must already contain the generated `WORKFLOW.md`.

```bash
docker run -d \
  --name gh-symphony \
  --restart unless-stopped \
  -e GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token \
  -v "$(pwd):/project" \
  -w /project \
  ghcr.io/hojinzs/github-symphony:latest
```

Example `docker compose` deployment:

```yaml
services:
  gh-symphony:
    image: ghcr.io/hojinzs/github-symphony:latest
    restart: unless-stopped
    working_dir: /project
    environment:
      GITHUB_GRAPHQL_TOKEN: ${GITHUB_GRAPHQL_TOKEN}
    volumes:
      - ./:/project
```

Run `gh-symphony setup` once before starting the service so the mounted project
folder has `WORKFLOW.md`.

If you prefer a host bind mount in `docker compose`, align the container user with the host directory owner:

```yaml
services:
  gh-symphony:
    image: ghcr.io/hojinzs/github-symphony:latest
    working_dir: /project
    user: "${UID:-1000}:${GID:-1000}"
    environment:
      GITHUB_GRAPHQL_TOKEN: ${GITHUB_GRAPHQL_TOKEN}
    volumes:
      - ./:/project
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

Use `gh-symphony project status --project-dir <path> --watch`, `gh-symphony doctor --smoke`, and `gh-symphony workflow preview` to inspect an idle Project issue.

### Project Runtime

`gh-symphony setup` generates `WORKFLOW.md` and its support files in the cwd project folder. `project start --project-dir <path>` derives and refreshes runtime configuration from that folder on every start.

For Linear tracker projects, `WORKFLOW.md` remains the source of truth:

```yaml
tracker:
  kind: linear
  provider:
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

`gh-symphony setup` validates that `tracker.provider.project_slug` is present and that the optional `tracker.provider.api_key` reference resolves when supplied. Without it, Linear uses `LINEAR_API_KEY`. Flat tracker keys are rejected; run `gh-symphony doctor` for a normalized provider migration block. The legacy `.gh-symphony/config.json` file is not used as the Linear source of truth.

`gh-symphony project start --project-dir <path> --assigned-only` also applies to Linear trackers. It is an input to the Linear adapter's `dispatchable` derivation: the adapter keeps candidate issues observable, compares each returned `assignee.id` with the authenticated viewer, and marks nonmatching or unassigned issues non-dispatchable. With a personal API key this viewer is that person; with a service-account key it is the service account. Symphony does not fail fast because Linear does not expose enough token metadata in the issue query path to distinguish those cases reliably.

GitHub and Linear workflows may configure `tracker.provider.pickup_labels.include` and `tracker.provider.pickup_labels.exclude` as candidate filters. Excluded labels always win; when include labels are configured, an issue needs any one include label before it is considered for dispatch. On GitHub, this pre-filter does not terminate an already-running worker when its labels change. Linear applies the pickup filter to ID refreshes too, so removing the sole included label can make an active worker stop during reconciliation. By contrast, `tracker.required_labels` is an all-of routability gate: removing one blocks new dispatches and due retries, and the worker stops before its next turn after a refreshed tracker read reports the issue is no longer routable. Label comparison is case-insensitive and ignores surrounding whitespace, so labels that differ only by case or outer whitespace cannot be used as separate gates.

Linear orchestration is polling-only. There is intentionally no Linear webhook setup command; state transitions, workpad comments, and PR handoff policy belong in `WORKFLOW.md`. See `docs/examples/linear-WORKFLOW.md` for a complete example.

Workers log structured diagnostics when a between-turn tracker refresh fails, including the HTTP status, provider error, or exception message. Transient failures retain the configured consecutive-failure threshold. If an adapter permanently rejects state reads with `tracker_state_requests_unsupported`, the worker emits one capability warning and continues turns without the unavailable tracker gate.

### Configuration

```bash
gh-symphony config show             # Show configuration
gh-symphony config set <key> <val>  # Set a configuration value
gh-symphony config edit             # Open config in $EDITOR
```

### Diagnostics

`gh-symphony doctor` runs a single first-run diagnostic pass and exits non-zero if any required prerequisite is missing. `gh-symphony doctor --fix` adds a remediation pass on top of the same checks. `gh-symphony doctor --smoke` is the recommended final preflight before `gh-symphony project start --project-dir <path> --once`: it resolves the active managed project, reads a target issue through the configured tracker integration, renders `WORKFLOW.md` for that issue, verifies the runtime command, workspace root, and configured hook paths, and exits without dispatching a worker. GitHub projects retain the GitHub Project read path and require `owner/repo#number` for explicit issues; Linear projects read through the Linear adapter, use identifiers such as `DEV-54`, and do not require a GitHub Project binding.

When cwd is a project folder whose runtime config was cached by `project start`,
`doctor` and live `workflow preview` diagnose that project even if another
registry project is active. Explicit `--project-dir <path>` (`doctor`) or
`--project-id <projectId>` (`workflow preview`) selection wins over cwd;
outside such a folder, diagnostics fall back to the registry's `activeProject`.

Use an explicit issue when you want a deterministic check:

```bash
gh-symphony doctor --smoke --issue owner/repo#123
gh-symphony doctor --smoke --issue owner/repo#123 --json
gh-symphony doctor --smoke --issue DEV-54
```

Without `--issue`, doctor auto-selects one active live issue from the managed project. If none is suitable, the report explains which active states it expected and suggests re-running with `--issue`.

`gh-symphony doctor --fix` can:

- create missing config, runtime, and workspace directories
- launch `gh auth login` / `gh auth refresh` in TTY environments, or print the exact command in non-interactive environments
- launch `gh-symphony workflow init` when `WORKFLOW.md` is missing or invalid
- launch `gh-symphony setup` when the project configuration or GitHub Project binding must be reconfigured
- print environment-specific runtime install guidance when the configured command is missing from `PATH`

The diagnostic checks cover:

- the active GitHub auth source (`GITHUB_GRAPHQL_TOKEN` first, otherwise `gh`) and required scopes (`repo`, `read:org`, `project`)
- Node.js runtime version against the documented minimum (`v24+`) and the current `process.version`
- Git installation availability on `PATH`, including `git --version` when available
- project runtime resolution and GitHub Project binding lookup
- runtime root and workspace writability
- project `WORKFLOW.md` presence and parse validity
- configured runtime command availability on `PATH`
- with `--smoke`: linked repository readiness, live issue readability, strict prompt rendering, and hook path resolution

Use `--json` for setup automation and smoke checks. When combined with `--fix`, the JSON report also includes a structured remediation step list with `applied`, `skipped`, or `manual` outcomes.

```bash
gh-symphony doctor --json
gh-symphony doctor --fix --json
gh-symphony doctor --smoke --json
gh-symphony project start --project-dir <path> --once
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
- **WORKFLOW.md** — the project folder's workflow policy file. Contains YAML front matter for lifecycle config and a Markdown body used as the agent prompt template.

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

### GitHub GraphQL Rate Limits

GitHub GraphQL rate limits are shared by every orchestrator process using the
same token. If one host runs several repository orchestrators, prefer a
separate `GITHUB_GRAPHQL_TOKEN` per repository or per runtime identity when
that is operationally practical. Shared-token deployments still degrade
gracefully: GitHub tracker polling slows down as remaining GraphQL budget falls,
and the cached pre-request guard only hard-stops after the cached budget is
exhausted.

### GitHub Enterprise Server

For GitHub Enterprise Server, configure the GraphQL endpoint in `WORKFLOW.md`
so the orchestrator, doctor checks, and dispatched worker all use the same
host:

```yaml
tracker:
  kind: github-project
  provider:
    endpoint: https://github.example/api/graphql
    project_id: PVT_xxx
```

Then initialize and validate the project:

```bash
export GITHUB_GRAPHQL_TOKEN=ghp_your_enterprise_token
gh-symphony setup
gh-symphony doctor
gh-symphony doctor --smoke --issue owner/repo#123
```

`GITHUB_GRAPHQL_API_URL` remains an optional process-level override. If both
`tracker.provider.endpoint` and `GITHUB_GRAPHQL_API_URL` are set, keep them identical;
`doctor` reports the resolved endpoint and warns when they disagree. During
dispatch, the GitHub tracker injects the configured `tracker.provider.endpoint` into the
worker as `GITHUB_GRAPHQL_API_URL`, so worker-side `github_graphql` calls do not
fall back to `https://api.github.com/graphql`.

## WORKFLOW.md

`WORKFLOW.md` contains YAML front matter for lifecycle configuration and a Markdown body used as the agent prompt template.

### Live reload and applied revision

You do **not** need to restart a running daemon after editing `WORKFLOW.md`.
The orchestrator defensively reads and resolves the file at every reconciliation
tick, so a valid edit takes effect at the next tick. The normal polling delay is
configured by `polling.interval_ms` and capped at five minutes; reducing that
value still waits for the already-scheduled tick before the shorter interval is
used. `agent.max_concurrent_agents` and lifecycle policy follow the same
next-tick rule, while future worker prompts use the newly resolved policy.

The daemon does not use a filesystem watcher. This is an intentional
repository-local divergence from the upstream Symphony specification's watch
requirement, documented in
[ADR 2026-08-26](docs/adr/2026-08-26-workflow-reload-divergence.md). Inspect
`project status` for `workflow.revision` and
`workflow.loadedAt` to identify the policy currently applied by the latest
tick; dispatch events also include `workflowRevision`.

The generated file includes:

- **Lifecycle**: core `tracker.active_states` and `tracker.terminal_states`, plus provider-owned `blocker_check_states` and `planning_states`, derived from the status column mapping. Lifecycle state names are matched case-insensitively after trimming. Missing blocker configuration defaults to the first active state; an explicit `tracker.provider.blocker_check_states: []` disables blocker gating as an intentional spec divergence. Planning remains disabled unless configured explicitly.
- **Tracker provider**: adapter-owned settings are generated under `tracker.provider`. Flat tracker keys are rejected in this major release; run `gh-symphony doctor` for a copyable migration block.
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
| `{{execution_phase}}`   | `planning`, `implementation`, or null    |
| `{{guidelines}}`        | Prompt guidelines from WORKFLOW.md       |

`tracker.provider.planning_states` classifies matching states as `planning`; it does not
impose a built-in plan-only gate or make a state eligible for dispatch.
Use `execution_phase` in the prompt body when policy should change agent
behavior, for example:

```liquid
{% if execution_phase == "planning" %}
Produce a plan and move the issue to human review. Do not implement yet.
{% else %}
Implement and validate the requested change.
{% endif %}
```

Planning-state matching uses the same trimmed, case-insensitive comparison as
active and terminal state matching. It is evaluated independently of dispatch
eligibility and takes precedence over active-state classification, including
when a state appears in both lists.

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

With an explicit output path:

```bash
gh-symphony workflow init --non-interactive --project PVT_xxx --output WORKFLOW.md
gh-symphony workflow init --non-interactive --project PVT_xxx --dry-run
```

`gh-symphony workflow validate` parses the target file, strictly renders the prompt body and continuation guidance with canonical sample variables, and prints a compact runtime/lifecycle summary.

`gh-symphony workflow preview --issue owner/repo#123` is the fastest validation step after `workflow init`: it resolves the active managed project (or `--project-id`) and renders the exact worker prompt from the live GitHub Project issue. Linear workflows can preview a single issue with `gh-symphony workflow preview ENG-123`, which routes through the configured Linear tracker adapter and `LINEAR_API_KEY`. Keep `--sample <path-to-json>` for fixture-based debugging, and use `--attempt <n>` to inspect retry prompts before changing policy files.

### Workflow policy source

The project folder's `WORKFLOW.md` is the workflow policy source. If it is
absent, Symphony uses built-in defaults (`Todo`, `In Progress` as active;
`Done` as terminal; blocker checks enabled for `Todo`; planning states
disabled). A `WORKFLOW.md` in the target repository is reported as shadowed;
it is not used as a fallback for a folder-addressed project.

### Environment Variables

This section covers the project `.env` file and hook context merge order. For a
single reference of every environment variable read by the CLI, orchestrator,
worker, and runtimes, see
[Configuration: Environment Variables](docs/configuration.md#environment-loading-order).

#### Project `.env` File

For project-specific secrets or staging settings, place a `.env` file in the
project folder instead of committing values into `WORKFLOW.md` or repository
scripts. Symphony never loads the target repository's `.env`; it is reserved
for the application. The project `.env` is the base environment for workspace
hooks and worker processes.

Symphony reads the project `.env` when each hook or worker consumes it.
Therefore an approved `after_create` or `before_run` hook may refresh the file
for the worker spawned in the same run; credential checks and worker launch use
one post-hook snapshot.

```bash
# /path/to/project/.env
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

#### Example: External Script File

Hooks are an opt-in, repository-local divergence from the upstream shell-command
model. Set `SYMPHONY_ALLOW_WORKFLOW_HOOKS=1` in the host environment, and point
each hook at a committed executable script. Inline shell, `bash` prefixes, and
shell operators are rejected; Symphony executes no implicit shell.

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

The orchestrator runs independently as long as the project folder has been initialized with `gh-symphony setup`.

```bash
# Via the CLI daemon
gh-symphony project start --project-dir <path>                    # continuous polling
gh-symphony project start --project-dir <path> --once             # run startup cleanup + one poll/reconcile/dispatch tick
gh-symphony project start --project-dir <path> --http             # continuous polling + JSON status API on 127.0.0.1:4680
gh-symphony project start --project-dir <path> --port 4800        # preferred alias for --http with an explicit port
gh-symphony project start --project-dir <path> --once --http      # keep the JSON status API available after the one-shot tick until Ctrl+C
gh-symphony project start --project-dir <path> --web              # continuous polling + browser dashboard on 127.0.0.1:4680

# Via the orchestrator package directly
pnpm --filter @gh-symphony/orchestrator start -- run
pnpm --filter @gh-symphony/orchestrator start -- run-once
pnpm --filter @gh-symphony/orchestrator start -- dispatch --project-id <id>
pnpm --filter @gh-symphony/orchestrator start -- run-issue --project-id <id> --issue <owner/repo#number>
pnpm --filter @gh-symphony/orchestrator start -- recover
pnpm --filter @gh-symphony/orchestrator start -- status
```

Cached runtime state lives under the configured Symphony directory:

| Path                          | Contents                                     |
| ----------------------------- | -------------------------------------------- |
| `project.json`                | Project runtime metadata                     |
| `config.json`                 | Active project runtime pointer               |
| `leases.json`                 | Active or released issue-phase leases        |
| `status.json`                 | Latest repository status snapshot            |
| `runs/<run-id>/run.json`      | Run snapshot, retry state, worker assignment |
| `runs/<run-id>/events.ndjson` | Structured orchestration events              |

Failed workers, including failures that retain dirty-workspace recovery
context, consume `agent.max_failure_retries`. When that budget is exhausted,
the claim is released and the issue remains suppressed across restarts,
fresh polls, and same-state tracker writes. Change the issue's tracker state
explicitly when an operator has resolved the failure and wants to re-arm it.
Healthy continuation retries do not consume the failure budget.

Read orchestration state via the status API (`/api/v1/state`) rather than reading status files directly.

Run `gh-symphony doctor --smoke` before the first `start --once` when you want a safe pre-dispatch readiness check. `gh-symphony project start --project-dir <path> --once` is the first production-like run: it validates the real GitHub Project binding, project `WORKFLOW.md`, and dispatch eligibility, then performs one poll/reconcile/dispatch tick instead of starting a long-lived poller. Add `--port [port]` when you want the JSON status API available; `--http [port]` remains a supported alias. With `--once --port`, the one-shot tick still completes, but the HTTP server stays up afterward and the process keeps the project lock until you stop it with `Ctrl+C`. `server.port` in `WORKFLOW.md` enables the same API when no CLI port is supplied. Add `--web` instead when you want the browser dashboard at `/` plus the JSON API.

## Verification

Before shipping a change:

```bash
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

## Security posture

GitHub Symphony is intended for trusted, operator-controlled environments.
Codex, Claude, and default custom coding-agent children receive no raw GitHub
or Linear tracker credential and no token-broker secret, including in
brokerless deployments. Their runtime-owned `HOME` and `GH_CONFIG_DIR` do not expose the operator's
`gh auth` store or credential-helper configuration. Codex provider tools execute
through host dynamic tools; Claude's generated MCP configuration contains only
the worker-owned loopback endpoint and its per-run capability. The host-owned
transport is described in
[ADR 2026-08-28](docs/adr/2026-08-28_agent-tool-isolation.md).
At dispatch, tracker adapters resolve host-only credentials from the tenant's
project `.env` before the daemon environment. Workers use that daemon-resolved
tracker identity for host tools and Git transport without restoring blanket
environment inheritance.
GitHub and Linear workers fail startup before launching an agent when this
effective environment has no provider credential. Candidate dispatch is also
skipped when the orchestrator can determine the credential is missing, and
`project status` expose the remediation in `warnings`.
When no direct provider API key is configured, a non-bare runtime stages only
the provider login into this private home: Codex `auth.json`, or Claude's
`claudeAiOauth` entry without `mcpOAuth`. Host agent configuration and GitHub
CLI credentials remain outside the child boundary. A custom command can receive
only the provider key named by `runtime.auth.env`. The documented
`runtime.isolation.inherit_environment: true` migration escape hatch instead
forwards the full worker environment (including raw credentials), so it is an
intentional repository-local divergence from the upstream child-isolation
requirements and should be removed after compatibility work.

Codex supports only `approval_policy: never` and uses the
`danger-full-access` thread sandbox; Claude uses `bypassPermissions`.
Other Codex approval policies fail workflow validation because operator approval
handling is not implemented. Operators can configure the Codex sandbox settings,
but must use least-privilege credentials, dedicated workspaces, and controls
appropriate to their environment. The target transport keeps credentials in the Symphony host
or a host-side broker, returns only bounded issue-aware tool results to agents,
uses loopback-only local services with scoped session capabilities, and gives
the child an isolated home/configuration directory rather than a host `gh auth`
store. After a successful agent run, the worker copies the assigned ref into a
temporary host-owned bare repository, fetches and fast-forward checks the
orchestrator-owned target URL, and performs the authenticated push with
repository hooks disabled. Child changes to `origin`, Git hooks, or repository
Git configuration cannot redirect or extend that credential-bearing operation.

This trust posture is an intentional repository-local divergence: Codex defaults
to `approval_policy: never` with `danger-full-access`, Claude defaults to
`bypassPermissions`, and untrusted user-input approval requests fail
immediately rather than pausing for interactive confirmation.

## Community and security

- [Contributing guide](CONTRIBUTING.md) — development setup, validation, and pull request expectations.
- [Security policy](SECURITY.md) — supported reporting path for vulnerabilities and sensitive disclosures.
- [Code of Conduct](CODE_OF_CONDUCT.md) — community expectations for issues, discussions, and pull requests.
- [MIT License](LICENSE) — project license terms.

## License

This project is released under the [MIT License](LICENSE).
