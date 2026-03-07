# Contributing

## Ground rules

- Open an issue or discussion before making large architectural changes.
- Keep changes scoped. Separate refactors from feature work when possible.
- Preserve the OpenSpec workflow. Proposal, design, and tasks should stay in sync with implementation.
- Prefer additive changes over silent behavioral rewrites.

## Development workflow

1. Create or pick an OpenSpec change.
2. Implement against the active tasks.
3. Run `pnpm lint`, `pnpm test`, `pnpm typecheck`, and `pnpm build`.
4. If Prisma schema changes, also run `DATABASE_URL='postgresql://postgres:postgres@localhost:5432/github_symphony' pnpm prisma:validate`.
5. Document operational or self-hosting impact when it changes deployment behavior.

## Pull request expectations

- Explain the user-visible behavior change and any operational impact.
- Link the related OpenSpec change or issue.
- Include screenshots or terminal output when changing UX or deployment flows.
- Call out follow-up work explicitly instead of leaving hidden gaps.

## Code style

- TypeScript is `strict`; do not weaken compiler settings to land a change.
- Add tests for new worker logic, provisioning logic, and API behavior.
- Keep Docker and GitHub integration code auditable. Favor explicit env vars and small helper functions.

## Security

- Never commit real GitHub tokens, private keys, `.env` files, or generated installation tokens.
- Treat `docker.sock` access as privileged. Self-hosting docs assume a trusted operator.
