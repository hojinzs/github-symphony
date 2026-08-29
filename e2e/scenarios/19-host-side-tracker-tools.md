# TC-19: Host-side tracker tools

## Purpose

Verify that the Codex and Claude transports call a selected tracker adapter in
the host process, receive only the resulting payload, and do not expose the
provider credential to the coding-agent child or its readable workspace files.

## Run

```bash
docker compose -f docker-compose.e2e.yml up -d --build
docker compose -f docker-compose.e2e.yml exec -T symphony-e2e \
  node /app/e2e/host-dynamic-tool-e2e.mjs
pnpm e2e:claude
docker compose -f docker-compose.e2e.yml down --volumes --remove-orphans
```

## Assertions

- The Codex helper invokes `github_graphql` through the built worker and
  selected GitHub adapter, returning the stubbed provider payload while using
  the host-only test credential for the HTTP request.
- The Claude Docker test invokes the host-owned HTTP MCP endpoint, performs a
  provider call using the host credential, and records a successful tool
  response.
- The Claude stub's captured child environment and generated MCP configuration
  contain neither the raw GitHub credential aliases nor the host token value.

## Cleanup

The commands remove the compose project and its temporary workspace. No live
GitHub or Linear provider credentials are needed; the provider HTTP boundary is
stubbed by the tests.
