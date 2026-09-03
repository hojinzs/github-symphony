# TC-20: Agent child isolation and host Git transport

## Setup

Run `pnpm e2e:claude`. The Claude Docker fixture supplies raw GitHub aliases,
`GITHUB_TOKEN_BROKER_SECRET`, `LINEAR_API_KEY`, and `LINEAR_AUTHORIZATION` to
the worker host. It seeds a real local bare Git remote and an assigned branch.

## Steps

1. Start the Codex lifecycle regression container and Claude black-box container.
2. Dispatch the Claude worker through two turns with host-side tracker tools.
3. Spawn the real custom-child fixture once in default mode and once with the
   documented compatibility escape hatch.
4. Inspect the stub invocation's environment and generated MCP configuration.
5. Let the successful worker lifecycle fetch and push its checked-out assigned branch.
6. Advance the remote assigned branch independently, then run successful Claude
   and Codex agent lifecycles whose local commits can no longer fast-forward it.

## Expected

- The Claude child has none of the supplied GitHub, Linear, or broker secrets.
- The default custom child has no supplied GitHub, Linear, tracker, or broker
  secret, while its declared custom provider credential remains available.
- The compatibility custom child receives raw worker credentials by design, but
  both custom modes retain private `HOME`/`GH_CONFIG_DIR`, override
  `USERPROFILE`, and remove Git credential-helper injection.
- `HOME` and `GH_CONFIG_DIR` point below `WORKSPACE_RUNTIME_DIR/child-home`.
- No `GIT_CONFIG_*` credential helper reaches the child.
- Generated `mcp.json` exposes only the worker-owned `symphony` HTTP endpoint
  and its session capability under forced strict MCP mode; query, comment, and
  Project-state calls succeed.
- Worker stderr confirms the assigned branch was pushed by host Git transport.
- Both provider lifecycles emit a final `runPhase: failed` heartbeat containing
  `git_transport_failed` and exit non-zero when the assigned branch cannot be
  published.
- Unit fixtures prove a child-mutated `origin` cannot redirect that push and a
  child-authored pre-push hook cannot observe the host credential.
- The companion Codex Docker lifecycle remains healthy.

## Cleanup

The `pnpm e2e:claude` runner removes both Compose projects, their volumes and
images, resets `e2e/fixtures/issues.json`, and deletes temporary test roots.
