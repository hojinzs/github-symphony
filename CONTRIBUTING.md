# Contributing

## Ground rules

- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- Open an issue or discussion before making large architectural changes.
- Keep changes scoped. Separate refactors from feature work when possible.
- Prefer additive changes over silent behavioral rewrites.
- Keep design decisions reviewable. Use `docs/adr/` for architecture decision records when a change needs a durable rationale.

## Development workflow

1. Create a branch from `main`.
2. Implement the change against the linked issue or agreed scope.
3. Run the required checks:
   ```bash
   pnpm lint
   pnpm test
   pnpm typecheck
   pnpm build
   ```
4. Run the formatting gate:
   ```bash
   pnpm format
   ```
   Use `pnpm format:write` only when you need Prettier to rewrite files locally.
5. Add a Changeset for user-visible package changes:
   ```bash
   pnpm changeset
   ```
   Documentation-only changes usually do not need a Changeset unless they describe released package behavior.
6. Document operational or self-hosting impact when it changes deployment behavior.
7. Open a pull request.

## Pull request expectations

- Explain the user-visible behavior change and any operational impact.
- Link the related issue. Link an ADR when the change adds or updates a design decision.
- Include screenshots or terminal output when changing UX or deployment flows.
- Include a Changeset when the change affects released package behavior.
- Call out follow-up work explicitly instead of leaving hidden gaps.

## Code style

- TypeScript is `strict`; do not weaken compiler settings to land a change.
- Add tests for new worker logic, provisioning logic, and API behavior.
- Keep Docker and GitHub integration code auditable. Favor explicit env vars and small helper functions.

## Security

- Never commit real GitHub tokens, private keys, `.env` files, or generated installation tokens.
- Treat `docker.sock` access as privileged. Self-hosting docs assume a trusted operator.
- Report suspected vulnerabilities privately through the process in [SECURITY.md](SECURITY.md). Do not open a public issue for an unpatched vulnerability.
