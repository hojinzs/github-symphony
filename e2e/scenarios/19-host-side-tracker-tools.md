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

- The Codex helper invokes `github_graphql` through the built worker and its
  owning GitHub adapter. It performs a query, an active-issue `addComment`
  mutation, and an active Project-item state mutation using the host-only test
  credential for the HTTP requests.
- The Claude Docker test invokes the host-owned HTTP MCP endpoint through the
  same adapter contract and performs the same query/comment/state-mutation
  sequence with the host credential.
- The Claude stub's captured child environment and generated MCP configuration
  contain neither the raw GitHub credential aliases nor the host token value.
  This credential-isolation assertion is existing coverage in
  `test/e2e/claude/claude-docker.spec.ts`; TC-19 extends its host-tool
  assertions with the scoped mutations.

## Cleanup

The commands remove the compose project and its temporary workspace. No live
GitHub or Linear provider credentials are needed; the provider HTTP boundary is
stubbed by the tests.
