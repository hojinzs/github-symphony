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
4. Dump the Claude and Codex stub invocations' complete child environments,
   compare literal expected names and assignments with the exported core
   declarations, and inspect the generated MCP configuration.
5. With the GitHub broker variables absent, let both successful worker
   lifecycles authenticate to a smart-HTTP Git remote, then fetch and push the
   checked-out assigned branch through the direct-token credential helper.
6. Advance the remote assigned branch independently, then run successful Claude
   and Codex agent lifecycles whose local commits can no longer fast-forward it.
7. Start the built GitHub worker with no direct token or complete broker pair.

## Expected

- The Claude child has none of the supplied GitHub, Linear, or broker secrets.
- Every literal expected credential name is injected into the worker and absent
  from both dumped child environments. The literals are separately cross-checked
  against the exported contract, host-constructed paths and values are asserted
  independently, and no injected contract sentinel leaks under another name.
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
- Worker stderr confirms both assigned branches were pushed by host Git transport,
  and the authenticated remote observes upload-pack and receive-pack
  advertisements plus the receive-pack RPC.
- Both provider lifecycles emit a final `runPhase: failed` heartbeat containing
  `git_transport_failed` and exit non-zero when the assigned branch cannot be
  published.
- The credential-free GitHub worker exits non-zero with the managed project
  `.env` / daemon-auth remediation before Codex or Claude initialization.
- Unit fixtures prove a child-mutated `origin` cannot redirect that push and a
  child-authored pre-push hook cannot observe the host credential.
- The companion Codex Docker lifecycle remains healthy.

## Cleanup

The `pnpm e2e:claude` runner removes both Compose projects, their volumes and
images, resets `e2e/fixtures/issues.json`, and deletes temporary test roots.
