# GitHub Symphony

GitHub Symphony is a multi-tenant AI coding agent platform built on top of the Symphony specification. It provides a Next.js control plane for workspace and issue management, provisions one isolated Symphony worker per workspace, and keeps agent-side tracker mutation inside the `github_graphql` tool contract.

The repository now includes a buildable local worker image instead of assuming a published `ghcr.io/openai/symphony` image exists.

## What is in this repository

- `apps/control-plane`: Next.js App Router control plane
- `packages/worker`: Symphony runtime integration, hooks, tracker adapter, runtime launch plan
- `packages/shared`: shared types and labels
- `prisma`: PostgreSQL schema for GitHub integration state, workspaces, repositories, and runtime instances
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
3. Configure `DATABASE_URL`, `CONTROL_PLANE_BASE_URL`, `CONTROL_PLANE_RUNTIME_URL`, `PLATFORM_SECRETS_KEY` (or `GITHUB_APP_SECRETS_KEY` for backward compatibility), and `WORKSPACE_RUNTIME_AUTH_SECRET`.
4. Start PostgreSQL.
5. Run `pnpm prisma:generate` and `pnpm prisma:db-push`.
6. Start the UI with `pnpm dev:control-plane`.
7. Open `http://localhost:3000/setup/github-app` and complete the first-run GitHub App bootstrap flow.

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

The control plane now bootstraps its GitHub integration from the UI. On first run it redirects workspace and issue flows to `/setup/github-app`, walks the operator through GitHub App registration and installation, encrypts the returned app credentials in PostgreSQL, and then brokers short-lived installation tokens for control-plane and runtime use.

Required non-GitHub secrets:

- `PLATFORM_SECRETS_KEY`: recommended encryption key for stored GitHub App and agent runtime credentials
- `GITHUB_APP_SECRETS_KEY`: legacy fallback if `PLATFORM_SECRETS_KEY` is not set
- `WORKSPACE_RUNTIME_AUTH_SECRET`: derives workspace-scoped secrets for runtime token refresh

Recommended base URLs:

- `CONTROL_PLANE_BASE_URL=http://localhost:3000`
- `CONTROL_PLANE_RUNTIME_URL=http://host.docker.internal:3000`

Required GitHub App permissions for the approval-gated workflow:

- `Contents: Read and write`
- `Issues: Read and write`
- `Pull requests: Read and write`
- `Repository projects: Read and write`
- `Organization projects: Read and write`

Required GitHub settings for merge-driven completion:

- The workspace project must expose `Todo` or `Needs Plan`, `Human Review`, `Approved` or `Ready to Implement`, `Await Merge`, and `Done` statuses, or equivalent mapped values in `WORKFLOW.md`.
- Linked issue auto-close must remain enabled so PR bodies that include `Fixes #<issue-number>` close the tracked issue on merge.
- GitHub Projects built-in automation should move closed issues into the completed state.

The legacy helper script at [scripts/github-app-installation-token.sh](/home/ubuntu/projects/github-symphony/scripts/github-app-installation-token.sh) remains useful for diagnostics, but it is no longer part of the normal setup flow.

## Agent credential setup

The control plane now manages the service credential used to start `codex app-server` inside each worker container.

1. Open `/workspaces/new`.
2. Register an agent credential with an OpenAI-compatible API key.
3. Mark one ready credential as the platform default, or leave it available only for workspace overrides.
4. Create a workspace by choosing either `Platform default` or `Workspace override`.

Runtime behavior:

- Worker containers fetch the effective agent credential from the control plane immediately before launch.
- The worker stores only the brokered environment contract needed for the current run.
- Rotating the platform default or an override changes subsequent runs automatically; workflow files and repositories are not rewritten with long-lived agent secrets.
- If the effective credential is missing, revoked, or degraded, workspace creation and new runtime launches are blocked until the credential is repaired or reassigned.

## Worker image

The sample worker image is built from [docker/worker.Dockerfile](/home/ubuntu/projects/github-symphony/docker/worker.Dockerfile). It runs the local worker package and serves `/api/v1/state`, which makes the compose example and dashboard flow runnable without relying on an unpublished upstream image.

## Verification

Before shipping a change, run:

- `pnpm lint`
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- `pnpm prisma:validate`
