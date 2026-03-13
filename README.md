# GitHub Symphony

GitHub Symphony is a multi-tenant AI coding agent platform built on top of the Symphony specification. It separates orchestration from operator UX: a CLI-first orchestrator polls tracker state and assigns runs, the control plane remains an optional extension, and workers execute one assigned issue run at a time while keeping agent-side tracker mutation inside the `github_graphql` tool contract.

The repository includes a buildable local worker image instead of assuming a published upstream image.

## What is in this repository

- `apps/control-plane`: Next.js App Router control plane (optional UI)
- `packages/cli`: interactive CLI for tenant setup (`gh-symphony tenant add`) and daemon lifecycle (`start`, `stop`, `status`)
- `packages/orchestrator`: headless CLI orchestrator with filesystem-backed leases, run snapshots, and recovery
- `packages/worker`: Symphony runtime integration, hooks, tracker adapter, runtime launch plan
- `packages/shared`: shared types and re-exports
- `prisma`: PostgreSQL schema for GitHub integration state
- `docs`: local-development, rollout, and self-hosting guides
- `openspec`: product change history and implementation artifacts

## License

This project is released under the [MIT License](/home/ubuntu/projects/github-symphony/LICENSE).

## Open source workflow

- Contribution guide: [CONTRIBUTING.md](/home/ubuntu/projects/github-symphony/CONTRIBUTING.md)
- Local development: [docs/local-development.md](/home/ubuntu/projects/github-symphony/docs/local-development.md)
- Self-hosting: [docs/self-hosting.md](/home/ubuntu/projects/github-symphony/docs/self-hosting.md)
- Rollout checklist: [docs/rollout-checklist.md](/home/ubuntu/projects/github-symphony/docs/rollout-checklist.md)

## Local development

1. Install Node.js 24+ and pnpm 9+.
2. Run `pnpm install`.
3. Configure `DATABASE_URL`, `CONTROL_PLANE_BASE_URL`, `CONTROL_PLANE_RUNTIME_URL`, `SYMPHONY_RUNTIME_DRIVER`, `PLATFORM_SECRETS_KEY`, `WORKSPACE_RUNTIME_AUTH_SECRET`, `GITHUB_OPERATOR_CLIENT_ID`, `GITHUB_OPERATOR_CLIENT_SECRET`, and `GITHUB_OPERATOR_ALLOWED_LOGINS`.
4. Start PostgreSQL.
5. Run `pnpm prisma:generate` and `pnpm prisma:db-push`.
6. Set `SYMPHONY_RUNTIME_DRIVER=local` and start the UI with `pnpm dev:control-plane`.
7. Open `http://localhost:3000/sign-in`, authenticate as a trusted operator, and complete the first-run machine-user PAT setup flow.
 Use a classic PAT issued for the dedicated machine user with these scopes:
 `repo`, `read:org`, `project`
8. Create a tenant from the control plane. That persists tenant metadata and emits orchestrator config under `.runtime/orchestrator/tenants/<tenant-id>/config.json`.
9. Start the headless orchestrator with `pnpm --filter @gh-symphony/orchestrator build` followed by `pnpm --filter @gh-symphony/orchestrator start -- run`.
 The long-running `run` command exposes the orchestrator status API on `http://127.0.0.1:4680` by default. Override it with `--status-host`, `--status-port`, or `ORCHESTRATOR_STATUS_BASE_URL` on control-plane hosts.

## CLI-first setup

The CLI provides an interactive setup flow that registers a tenant and generates a `WORKFLOW.md` without requiring the control-plane web app.

**Concepts:**

- **Tenant** — one GitHub Project bound to one set of repositories. Each tenant gets its own config, leases, and status snapshot. A single orchestrator can manage multiple tenants.
- **WORKFLOW.md** — the per-tenant (or per-repository) workflow policy file. Contains YAML front matter for lifecycle config and a Markdown body used as the agent prompt template.

### Quick start

```bash
pnpm --filter @gh-symphony/cli build
gh-symphony tenant add  # register a GitHub Project as a new tenant
gh-symphony start       # start the orchestrator daemon
gh-symphony status      # check orchestration status
gh-symphony stop        # stop the daemon
```

### Registering a tenant

`gh-symphony tenant add` walks through PAT validation, GitHub Project selection, repository selection, status column mapping, and runtime configuration. On completion it writes:

- `~/.gh-symphony/tenants/<tenant-id>/tenant.json` — orchestrator config for this tenant
- `~/.gh-symphony/tenants/<tenant-id>/workflow-mapping.json` — status column → role mappings
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

### Generating WORKFLOW.md

`gh-symphony init` generates a `WORKFLOW.md` in the current directory.

**With a tenant already registered** — it reads the active tenant's lifecycle config and produces a pre-filled `WORKFLOW.md` ready to commit to a repository:

```bash
cd my-repo
gh-symphony init        # generates ./WORKFLOW.md from active tenant config
```

**Without a tenant** — it runs a 3-step flow (PAT → Project → status mapping) and generates `WORKFLOW.md` without writing any config files. Useful for creating a per-repository policy before running `tenant add`:

```bash
gh-symphony init --non-interactive --token ghp_xxx --project PVT_xxx --output WORKFLOW.md
```

### WORKFLOW.md

`WORKFLOW.md` contains YAML front matter for lifecycle configuration and a Markdown body used as the agent prompt template.

The generated file includes:

- **Lifecycle**: `active_states`, `terminal_states`, `blocker_check_states` derived from the status column mapping
- **Runtime**: `agent_command` based on the selected runtime
- **Hooks**: `after_create` hook path
- **Scheduler**: `poll_interval_ms`
- **Retry**: `base_delay_ms`, `max_delay_ms`
- **Status Map**: visual mapping of status columns to roles
- **Agent Instructions**: prompt template with `{{issue.*}}` and `{{guidelines}}` variables

Edit the file to customize your team's coding policy and agent behavior. Available template variables:

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
| `{{guidelines}}` | Tenant-level prompt guidelines |

### WORKFLOW.md resolution order

The orchestrator resolves the workflow policy using this fallback chain:

1. **Repository WORKFLOW.md** — if the target repository has a `WORKFLOW.md` at its root and its lifecycle states match the tenant config, use it.
2. **Tenant WORKFLOW.md** — if the repository has no `WORKFLOW.md`, or it references states unknown to the tenant, fall back to the tenant-level `WORKFLOW.md`.
3. **Hardcoded defaults** — if neither file exists, use built-in defaults (`Todo`, `In Progress` as active; `Done` as terminal).

This means you can:
- Run without any `WORKFLOW.md` and rely on defaults
- Use a single tenant-level `WORKFLOW.md` for all repositories
- Override per-repository by committing a `WORKFLOW.md` to the repo root

When a repository `WORKFLOW.md` references states not in the tenant lifecycle, the orchestrator logs a warning and falls back to the tenant file.

## Headless orchestration

The orchestrator is the authoritative dispatch loop. It can run without the control-plane web app as long as tenant config exists under `.runtime/orchestrator/tenants/`.

```bash
# Continuous polling loop (+ status API on 127.0.0.1:4680)
pnpm --filter @gh-symphony/orchestrator start -- run

# Single reconciliation tick
pnpm --filter @gh-symphony/orchestrator start -- run-once

# Target a specific tenant
pnpm --filter @gh-symphony/orchestrator start -- dispatch --tenant-id <tenant-id>

# Target a specific issue
pnpm --filter @gh-symphony/orchestrator start -- run-issue --tenant-id <tenant-id> --issue <owner/repo#number>

# Reconcile filesystem state after a crash
pnpm --filter @gh-symphony/orchestrator start -- recover

# Print machine-readable orchestration status
pnpm --filter @gh-symphony/orchestrator start -- status
```

Runtime state lives under `.runtime/orchestrator/`:

| Path | Contents |
|------|----------|
| `tenants/<tenant-id>/config.json` | Tenant metadata used by the orchestrator |
| `tenants/<tenant-id>/WORKFLOW.md` | Tenant-level workflow policy (repo fallback) |
| `tenants/<tenant-id>/leases.json` | Active or released issue-phase leases |
| `tenants/<tenant-id>/status.json` | Latest machine-readable tenant status snapshot |
| `runs/<run-id>/run.json` | Run snapshot, retry state, and worker assignment |
| `runs/<run-id>/events.ndjson` | Structured orchestration events |

Each worker run clones the target repository, reloads lifecycle semantics from that repository's `WORKFLOW.md`, and serves `/api/v1/state` so the orchestrator and control-plane extension can aggregate worker state.

Read orchestration state via the status API (`/api/v1/tenants/<tenant-id>/status`) rather than reading `.runtime/orchestrator/tenants/.../status.json` directly. Set `ORCHESTRATOR_STATUS_BASE_URL` when the orchestrator runs on a different host or port.

## Self-hosting with Docker Compose

The repository includes a runnable sample at [docker-compose.yml](/home/ubuntu/projects/github-symphony/docker-compose.yml).

1. Copy [docker-compose.env.example](/home/ubuntu/projects/github-symphony/docker-compose.env.example) to `.env`.
2. Follow [docs/self-hosting.md](/home/ubuntu/projects/github-symphony/docs/self-hosting.md) to set the required non-GitHub secrets and control-plane URLs.
3. Run `docker compose up --build`.
4. Open `http://localhost:3000`.

The compose sample starts:

- `postgres`: metadata database for the control plane
- `symphony-worker-image`: local build step that produces `github-symphony-worker:local`
- `control-plane`: Next.js app with Prisma schema sync on boot

It also mounts `/var/run/docker.sock` so the control plane can provision isolated Symphony worker containers on the same host. Treat that deployment mode as trusted-operator only.

## GitHub bootstrap

The control plane starts with trusted-operator GitHub OAuth sign-in, then bootstraps its system GitHub integration from the UI. On first run it redirects setup and issue flows through `/sign-in`, guides the operator through machine-user PAT setup, validates the token against organization repository and Project access, and stores the encrypted PAT metadata in PostgreSQL. GitHub Project binding and issue creation remain control-plane extension flows; core orchestration happens in the CLI service.

Required non-GitHub secrets:

- `PLATFORM_SECRETS_KEY`: encryption key for stored PAT and agent runtime credentials
- `WORKSPACE_RUNTIME_AUTH_SECRET`: derives tenant-scoped secrets for runtime token refresh
- `OPERATOR_SESSION_SECRET`: optional dedicated session-signing secret; when unset, the control plane reuses `PLATFORM_SECRETS_KEY`

Required GitHub OAuth settings for trusted operator sign-in:

- `GITHUB_OPERATOR_CLIENT_ID`
- `GITHUB_OPERATOR_CLIENT_SECRET`
- `GITHUB_OPERATOR_ALLOWED_LOGINS`: optional comma-separated GitHub logins allowed to operate the control plane; if omitted, any GitHub user who completes sign-in is accepted
- GitHub OAuth callback URL: `http://localhost:3000/api/auth/github/callback` for local development, or the equivalent deployed control-plane URL in other environments

Recommended base URLs:

- Local development:
  `CONTROL_PLANE_BASE_URL=http://localhost:3000`,
  `CONTROL_PLANE_RUNTIME_URL=http://127.0.0.1:3000`,
  `SYMPHONY_RUNTIME_DRIVER=local`
- Docker/self-hosting:
  `CONTROL_PLANE_BASE_URL=http://localhost:3000`,
  `CONTROL_PLANE_RUNTIME_URL=http://host.docker.internal:3000`,
  `SYMPHONY_RUNTIME_DRIVER=docker`

Recommended PAT setup:

- use a dedicated machine-user account rather than a personal operator account
- target an organization owner login for setup and provisioning
- keep the token scoped to the repositories and GitHub Project mutations Symphony needs
- rotate the PAT by re-running `/setup/github` and replacing the stored token when access changes or expires

Required classic PAT scopes for the default setup path:

- `repo`: repository inventory, issue creation, git push, and pull request workflows
- `read:org`: organization owner validation and organization-scoped access checks
- `project`: GitHub Project v2 lookup and mutation flows used by provisioning and runtime updates

Required GitHub settings for merge-driven completion:

- The GitHub Project must expose `Todo`, `Plan Review`, `In Progress`, `In Review`, and `Done` statuses, or equivalent mapped values in `WORKFLOW.md`. Issues in any other status (e.g. `Draft`) are ignored by the orchestrator.
- Linked issue auto-close must remain enabled so PR bodies that include `Fixes #<issue-number>` close the tracked issue on merge.
- GitHub Projects built-in automation should move closed issues into the completed state.

If the stored PAT is revoked or loses Project capability, the control plane marks the integration `degraded` and routes the operator back to `/setup/github` to replace the token.

## Agent credential setup

The control plane manages the service credential used to start `codex app-server` inside each worker runtime.

1. Open `/workspaces/new`.
2. Register an agent credential with an OpenAI-compatible API key.
3. Mark one ready credential as the platform default, or leave it available only for tenant overrides.
4. Create a tenant by choosing either `Platform default` or `Tenant override`.

Runtime behavior:

- Worker runtimes fetch the effective agent credential from the control plane immediately before launch.
- The worker stores only the brokered environment contract needed for the current run.
- Rotating the platform default or an override changes subsequent runs automatically; workflow files and repositories are not rewritten with long-lived agent secrets.
- If the effective credential is missing, revoked, or degraded, tenant creation and new runtime launches are blocked until the credential is repaired or reassigned.

## Worker image

The sample worker image is built from [docker/worker.Dockerfile](/home/ubuntu/projects/github-symphony/docker/worker.Dockerfile). It runs the local worker package and serves `/api/v1/state`, which makes the compose example and dashboard flow runnable without relying on an unpublished upstream image.

## Verification

Before shipping a change, run:

- `pnpm lint`
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `pnpm prisma:validate`
