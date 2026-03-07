# Local development

## Prerequisites

- Node.js 24+
- pnpm 9+
- Docker Engine with access to the local socket
- PostgreSQL 16+

## Required environment

Set these values before booting the control plane locally:

- `DATABASE_URL`
- `CONTROL_PLANE_BASE_URL=http://localhost:3000`
- `CONTROL_PLANE_RUNTIME_URL=http://host.docker.internal:3000`
- `PLATFORM_SECRETS_KEY` or `GITHUB_APP_SECRETS_KEY`
- `WORKSPACE_RUNTIME_AUTH_SECRET`

Generate the two non-GitHub secrets with:

```bash
openssl rand -base64 32
```

## Initial setup

1. Install dependencies with `pnpm install`.
2. Run `pnpm prisma:generate`.
3. Apply the schema with `pnpm prisma:db-push`.
4. Start the control plane with `pnpm dev:control-plane`.
5. Open `http://localhost:3000/setup/github-app` and complete the GitHub App bootstrap flow.

## Common commands

- `pnpm dev:control-plane`: start the Next.js control plane
- `pnpm dev:worker`: run the sample worker entrypoint in watch mode
- `pnpm lint`: run ESLint across the workspace
- `pnpm test`: run the Vitest suite
- `pnpm typecheck`: run TypeScript checks across the workspace

## Notes

- The control plane encrypts persisted GitHub App credentials with `GITHUB_APP_SECRETS_KEY`.
- `PLATFORM_SECRETS_KEY` is the preferred key for both GitHub App secrets and agent runtime credentials; `GITHUB_APP_SECRETS_KEY` remains a fallback.
- Worker containers refresh installation tokens and fetch pre-launch agent credentials through the control plane by using workspace-scoped secrets derived from `WORKSPACE_RUNTIME_AUTH_SECRET`.
- Before creating a workspace, register an agent credential in `/workspaces/new`, then either mark it as the platform default or select it as a workspace-specific override.
- If the effective credential is degraded or missing, the dashboard shows recovery messaging and the worker will not start `codex app-server` for new runs.
- The approval-gated workflow assumes GitHub Project statuses mapped in `WORKFLOW.md` for planning, human review, implementation, awaiting merge, and completion.
- Local test repositories should leave linked issue auto-close enabled so pull requests containing `Fixes #<issue-number>` drive merge completion.
- `CONTROL_PLANE_RUNTIME_URL` must be reachable from worker containers. For local Docker Desktop style setups, `http://host.docker.internal:3000` is the intended default.
