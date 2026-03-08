# Local development

## Prerequisites

- Node.js 24+
- pnpm 9+
- PostgreSQL 16+

## Required environment

Set these values before booting the control plane locally:

- `DATABASE_URL`
- `CONTROL_PLANE_BASE_URL=http://localhost:3000`
- `CONTROL_PLANE_RUNTIME_URL=http://127.0.0.1:3000`
- `SYMPHONY_RUNTIME_DRIVER=local`
- `PLATFORM_SECRETS_KEY`
- `GITHUB_OPERATOR_CLIENT_ID`
- `GITHUB_OPERATOR_CLIENT_SECRET`
- `GITHUB_OPERATOR_ALLOWED_LOGINS` (optional)
- `WORKSPACE_RUNTIME_AUTH_SECRET`
- `OPERATOR_SESSION_SECRET` (optional, otherwise `PLATFORM_SECRETS_KEY` is reused)

Generate the non-GitHub secrets with:

```bash
openssl rand -base64 32
```

## Initial setup

1. Install dependencies with `pnpm install`.
2. Run `pnpm prisma:generate`.
3. Apply the schema with `pnpm prisma:db-push`.
4. Start the control plane with `pnpm dev:control-plane`.
5. Open `http://localhost:3000/sign-in` and authenticate as a trusted operator.
6. Complete the machine-user PAT setup flow at `/setup/github`.

## Common commands

- `pnpm dev:control-plane`: start the Next.js control plane
- `pnpm dev:worker`: run the sample worker entrypoint in watch mode
- `pnpm lint`: run ESLint across the workspace
- `pnpm test`: run the Vitest suite
- `pnpm typecheck`: run TypeScript checks across the workspace

## Notes

- The control plane encrypts persisted machine-user PAT and agent credentials with `PLATFORM_SECRETS_KEY`.
- The trusted-operator GitHub OAuth callback URL for local development is `http://localhost:3000/api/auth/github/callback`.
- Local worker processes refresh brokered GitHub credentials and fetch pre-launch agent credentials through the control plane by using workspace-scoped secrets derived from `WORKSPACE_RUNTIME_AUTH_SECRET`.
- Before creating a workspace, register an agent credential in `/workspaces/new`, then either mark it as the platform default or select it as a workspace-specific override.
- If the effective credential is degraded or missing, the dashboard shows recovery messaging and the worker will not start `codex app-server` for new runs.
- Prefer an organization-backed machine-user PAT during local setup. This is the only supported GitHub bootstrap path.
- The approval-gated workflow assumes GitHub Project statuses mapped in `WORKFLOW.md` for planning, human review, implementation, awaiting merge, and completion.
- Local test repositories should leave linked issue auto-close enabled so pull requests containing `Fixes #<issue-number>` drive merge completion.
- `CONTROL_PLANE_RUNTIME_URL` must be reachable from the spawned worker runtime. For local development the intended default is `http://127.0.0.1:3000`.
- Docker is optional for day-to-day development. You only need a Docker socket and `SYMPHONY_IMAGE` when running with `SYMPHONY_RUNTIME_DRIVER=docker`.
