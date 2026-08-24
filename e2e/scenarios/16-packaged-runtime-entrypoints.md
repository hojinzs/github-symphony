# TC-16: Packaged runtime entry points

## Setup

Build and start `docker-compose.e2e.yml` so the production CLI bundle and its
workspace dependencies are available under `/app/packages/cli`.

## Steps

1. Send an MCP `initialize` request to `dist/mcp-server.js --server github`.
2. Send the same request to `dist/mcp-server.js --server linear`.
3. Send a Git HTTPS credential request to `dist/git-credential-helper.js` with
   `GITHUB_GRAPHQL_TOKEN` set.
4. Inspect each subprocess response.

## Expected

- The GitHub process emits exactly one initialize response whose server name is
  `github-symphony-graphql`.
- The Linear process emits exactly one initialize response whose server name is
  `github-symphony-linear-graphql`.
- The credential helper returns the configured token for `github.com`.

## Cleanup

Stop the Compose environment with `docker compose -f docker-compose.e2e.yml down`.
