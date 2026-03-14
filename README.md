# GitHub Symphony

GitHub Symphony is a multi-tenant AI coding agent orchestration platform built on the [OpenAI Symphony specification](https://github.com/openai/symphony). A CLI-first orchestrator polls GitHub Projects for open issues, dispatches worker runs per repository, and resolves all workflow policy from each repository's `WORKFLOW.md` at runtime.

## Requirements

- **[Node.js](https://nodejs.org/)** (v24+) with npm
- **[Git](https://git-scm.com/)**
- **[GitHub CLI (`gh`)](https://cli.github.com/)** — authenticated with required scopes:
  ```bash
  gh auth login --scopes repo,read:org,project
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

### 2. Set Repository

Navigate to the repository you want to orchestrate, then run:

```bash
cd your-repo
gh-symphony init
```

The interactive wizard will:

1. Authenticate via `gh` CLI
2. Let you select a **GitHub Project** to bind
3. Map project status columns to workflow phases (active / wait / terminal)
4. Generate the following files:

| File | Description |
| --- | --- |
| `WORKFLOW.md` | Workflow policy — the agent prompt template with lifecycle config |
| `.gh-symphony/context.yaml` | Project metadata and environment context |
| `.gh-symphony/reference-workflow.md` | Reference workflow documentation |
| `.codex/skills/` (or `.claude/skills/`) | Agent skill definitions |

#### Customizing Agent Behavior

The generated skill files (under `.codex/skills/` or `.claude/skills/`) define how the AI agent handles commits, pushes, pulls, and project status transitions. You can further customize the agent's behavior by editing `WORKFLOW.md` — this is the policy layer that controls what the agent does at each workflow phase.

> Currently supported runtimes: **Codex**, **Claude Code**

### 3. Set Orchestrator Runner (Tenant)

On the machine where you want the orchestrator to run, register a tenant:

```bash
gh-symphony tenant add
```

The interactive wizard will:

1. Authenticate via `gh` CLI
2. Let you select a **GitHub Project**
3. Select repositories to orchestrate
4. Auto-detect workflow column mappings
5. Choose an AI runtime (Codex / Claude Code / custom)
6. Write tenant configuration to `~/.gh-symphony/`

Non-interactive mode:

```bash
gh-symphony tenant add --non-interactive --project PVT_xxx --runtime codex
```

Managing tenants:

```bash
gh-symphony tenant list             # List all configured tenants
gh-symphony tenant remove <id>      # Remove a tenant
```

### 4. Run the Orchestrator

```bash
gh-symphony start                   # Start (foreground)
gh-symphony start --daemon          # Start (background)
gh-symphony stop                    # Stop the daemon
```

Monitor:

```bash
gh-symphony status                  # Show current status
gh-symphony status --watch          # Live dashboard
gh-symphony logs                    # View event logs
gh-symphony logs --follow           # Stream logs in real-time
```

Dispatch a single issue:

```bash
gh-symphony run org/repo#123
```

Recover stalled runs:

```bash
gh-symphony recover                 # Recover stalled runs
gh-symphony recover --dry-run       # Preview what would be recovered
```

## Concepts

- **Tenant** — one GitHub Project bound to a set of repositories. Each tenant gets its own config, leases, and status snapshot. A single orchestrator manages multiple tenants.
- **WORKFLOW.md** — the per-repository (or per-tenant fallback) workflow policy file. Contains YAML front matter for lifecycle config and a Markdown body used as the agent prompt template.

## Authentication

GitHub Symphony uses the `gh` CLI for authentication. Run once:

```bash
gh auth login --scopes repo,read:org,project
```

Or if you need to add scopes to an existing login:

```bash
gh auth refresh --scopes repo,read:org,project
```

For CI/CD pipelines (where `gh` CLI is not available), set:

```bash
export GITHUB_GRAPHQL_TOKEN=ghp_your_classic_token
```

The `GITHUB_GRAPHQL_TOKEN` environment variable takes priority over `gh` CLI.

## WORKFLOW.md

`WORKFLOW.md` contains YAML front matter for lifecycle configuration and a Markdown body used as the agent prompt template.

The generated file includes:

- **Lifecycle**: `active_states`, `terminal_states`, `blocker_check_states` derived from the status column mapping
- **Runtime**: `agent_command` based on the selected runtime
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

`gh-symphony init` generates a `WORKFLOW.md` in the current directory.

With a tenant already registered:

```bash
cd my-repo
gh-symphony init        # generates ./WORKFLOW.md from active tenant config
```

Without a tenant (standalone):

```bash
gh-symphony init --non-interactive --project PVT_xxx --output WORKFLOW.md
```

### Resolution order

The orchestrator resolves the workflow policy using this fallback chain:

1. **Repository WORKFLOW.md** — if the target repository has a `WORKFLOW.md` at its root, use it.
2. **Tenant WORKFLOW.md** — if the repository has no `WORKFLOW.md`, fall back to the tenant-level `WORKFLOW.md`.
3. **Hardcoded defaults** — if neither file exists, use built-in defaults (`Todo`, `In Progress` as active; `Done` as terminal).

This means you can:

- Run without any `WORKFLOW.md` and rely on defaults
- Use a single tenant-level `WORKFLOW.md` for all repositories
- Override per-repository by committing a `WORKFLOW.md` to the repo root

## Headless orchestration

The orchestrator runs independently as long as tenant config exists under `~/.gh-symphony/tenants/`.

```bash
# Via the CLI daemon
gh-symphony start                    # continuous polling + status API on 127.0.0.1:4680
gh-symphony run beta/api#42          # dispatch a single issue

# Via the orchestrator package directly
pnpm --filter @gh-symphony/orchestrator start -- run
pnpm --filter @gh-symphony/orchestrator start -- run-once
pnpm --filter @gh-symphony/orchestrator start -- dispatch --tenant-id <id>
pnpm --filter @gh-symphony/orchestrator start -- run-issue --tenant-id <id> --issue <owner/repo#number>
pnpm --filter @gh-symphony/orchestrator start -- recover
pnpm --filter @gh-symphony/orchestrator start -- status
```

Runtime state lives under `.runtime/orchestrator/`:

| Path                          | Contents                                     |
| ----------------------------- | -------------------------------------------- |
| `tenants/<id>/config.json`    | Tenant metadata                              |
| `tenants/<id>/WORKFLOW.md`    | Tenant-level workflow policy (repo fallback) |
| `tenants/<id>/leases.json`    | Active or released issue-phase leases        |
| `tenants/<id>/status.json`    | Latest tenant status snapshot                |
| `runs/<run-id>/run.json`      | Run snapshot, retry state, worker assignment |
| `runs/<run-id>/events.ndjson` | Structured orchestration events              |

Read orchestration state via the status API (`/api/v1/tenants/<id>/status`) rather than reading status files directly.

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
