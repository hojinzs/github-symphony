# TC-20: Agent child isolation and host Git transport

## Setup

Run `pnpm e2e:claude`. The Claude Docker fixture supplies raw GitHub aliases,
`GITHUB_TOKEN_BROKER_SECRET`, `LINEAR_API_KEY`, and `LINEAR_AUTHORIZATION` to
the worker host. It seeds a real local bare Git remote and an assigned branch.

## Steps

1. Start the Codex lifecycle regression container and Claude black-box container.
2. Dispatch the Claude worker through two turns with host-side tracker tools.
3. Inspect the stub invocation's environment and generated MCP configuration.
4. Let the successful worker lifecycle fetch and push its checked-out assigned branch.

## Expected

- The Claude child has none of the supplied GitHub, Linear, or broker secrets.
- `HOME` and `GH_CONFIG_DIR` point below `WORKSPACE_RUNTIME_DIR/child-home`.
- No `GIT_CONFIG_*` credential helper reaches the child.
- Generated `mcp.json` exposes only the worker-owned `symphony` HTTP endpoint
  and its session capability; query, comment, and Project-state calls succeed.
- Worker stderr confirms the assigned branch was pushed by host Git transport.
- The companion Codex Docker lifecycle remains healthy.

## Cleanup

The `pnpm e2e:claude` runner removes both Compose projects, their volumes and
images, resets `e2e/fixtures/issues.json`, and deletes temporary test roots.
