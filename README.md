# GitHub Symphony

GitHub Symphony is a multi-tenant AI coding agent orchestration platform built on the [Symphony specification](docs/symphony-spec.md). A CLI-first orchestrator polls GitHub Projects for open issues, dispatches worker runs per repository, and resolves all workflow policy from each repository's `WORKFLOW.md` at runtime.

## Packages

| Package | Description |
|---------|-------------|
| `packages/cli` | Interactive CLI for tenant setup (`gh-symphony tenant add`) and daemon lifecycle (`start`, `stop`, `status`) |
| `packages/orchestrator` | Headless orchestrator with filesystem-backed leases, run snapshots, and recovery |
| `packages/worker` | Single-issue runner with runtime integration, hooks, and tracker adapter |
| `packages/core` | Domain types, contracts, workflow lifecycle, and observability snapshots |
| `packages/tracker-github` | GitHub Project tracker adapter |
| `packages/runtime-codex` | Codex AI runtime integration |
| `packages/extension-github-workflow` | GitHub Actions workflow extension |
| `packages/shared` | Shared types and re-exports |
| `apps/control-plane` | Optional web UI (work in progress — being redesigned) |
| `docs` | Local-development, rollout, and self-hosting guides |
| `openspec` | Product change history and implementation artifacts |

## Quick start

```bash
# Prerequisites: Node.js 24+, pnpm 9+
pnpm install
pnpm build

# Register a GitHub Project as a new tenant
gh-symphony tenant add

# Start the orchestrator daemon
gh-symphony start

# Check orchestration status
gh-symphony status

# Stop the daemon
gh-symphony stop
```

## Concepts

- **Tenant** — one GitHub Project bound to a set of repositories. Each tenant gets its own config, leases, and status snapshot. A single orchestrator manages multiple tenants.
- **WORKFLOW.md** — the per-repository (or per-tenant fallback) workflow policy file. Contains YAML front matter for lifecycle config and a Markdown body used as the agent prompt template.

## Registering a tenant

`gh-symphony tenant add` walks through PAT validation, GitHub Project selection, repository selection, status column mapping, and runtime configuration. On completion it writes:

- `~/.gh-symphony/tenants/<tenant-id>/tenant.json` — orchestrator config
- `~/.gh-symphony/tenants/<tenant-id>/workflow-mapping.json` — status column to role mappings
- `~/.gh-symphony/tenants/<tenant-id>/WORKFLOW.md` — scaffolded workflow policy (tenant-level fallback)

Non-interactive mode:

```bash
gh-symphony tenant add --non-interactive --token ghp_xxx --project PVT_xxx --runtime codex
```

Managing tenants:

```bash
gh-symphony tenant list            # list registered tenants
gh-symphony tenant remove <id>     # remove a tenant and its config
```

Required classic PAT scopes:

- `repo`: repository access, issue creation, git push, pull request workflows
- `read:org`: organization-scoped access checks
- `project`: GitHub Project v2 lookup and mutation

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

| Variable | Description |
|----------|-------------|
| `{{issue.identifier}}` | e.g. `acme/platform#42` |
| `{{issue.title}}` | Issue title |
| `{{issue.state}}` | Current tracker state |
| `{{issue.description}}` | Issue body |
| `{{issue.url}}` | Issue URL |
| `{{issue.repository}}` | `owner/name` |
| `{{issue.number}}` | Issue number |
| `{{attempt}}` | Retry attempt number (null on first run) |
| `{{guidelines}}` | Prompt guidelines from WORKFLOW.md |

### Generating WORKFLOW.md

`gh-symphony init` generates a `WORKFLOW.md` in the current directory.

With a tenant already registered:

```bash
cd my-repo
gh-symphony init        # generates ./WORKFLOW.md from active tenant config
```

Without a tenant (standalone):

```bash
gh-symphony init --non-interactive --token ghp_xxx --project PVT_xxx --output WORKFLOW.md
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

| Path | Contents |
|------|----------|
| `tenants/<id>/config.json` | Tenant metadata |
| `tenants/<id>/WORKFLOW.md` | Tenant-level workflow policy (repo fallback) |
| `tenants/<id>/leases.json` | Active or released issue-phase leases |
| `tenants/<id>/status.json` | Latest tenant status snapshot |
| `runs/<run-id>/run.json` | Run snapshot, retry state, worker assignment |
| `runs/<run-id>/events.ndjson` | Structured orchestration events |

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
