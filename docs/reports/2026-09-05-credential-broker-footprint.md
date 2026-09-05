# Credential broker footprint before Phase 4 removal

Date: 2026-09-05

Issue: #874

Scope: read-only investigation of the current tree

## Executive conclusion

The repository has two credential brokers, not one. The **GitHub token broker** returns a short-lived GitHub token and feeds host-side tracker GraphQL plus HTTPS Git publication. The **agent credential broker** returns an environment map and feeds `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` to the selected coding runtime. They share naming, cache patterns, and type vocabulary, but not a protocol or consumer.

The broker is therefore **not removable safely as one issue**. The recommendation is to split removal into three ordered issues: migrate host-side GitHub GraphQL authentication, migrate and prove host-side Git publication, then remove the independent agent-provider broker and remaining plumbing. The upstream floor remains intact if GitHub's adapter continues to declare all authentication environment names and no tracker credential reaches a coding-agent child.

## 1. What the broker carries end to end

### Concrete GitHub path: project configuration to host-side branch push

1. The GitHub tracker adapter searches the project environment first and the daemon environment second. It selects either `GITHUB_GRAPHQL_TOKEN` or the complete `GITHUB_TOKEN_BROKER_URL` / `GITHUB_TOKEN_BROKER_SECRET` pair, optionally with `GITHUB_TOKEN_CACHE_PATH` (`packages/tracker-github/src/orchestrator-adapter.ts:56-77`).
2. The orchestrator snapshots that result into the worker environment at dispatch (`packages/orchestrator/src/service.ts:3333-3342,3343-3376`). The broker secret is a bearer credential for the broker, not the GitHub token itself.
3. On every terminal path the worker calls `trySynchronizeAssignedBranch` with its effective environment (`packages/worker/src/index.ts:2038-2048,2109-2119`). An explicit publication request follows the same implementation on the orchestrator host: it resolves the tracker credentials again and passes them to `trySynchronizeAssignedBranch` (`packages/orchestrator/src/service.ts:565-607`).
4. `buildHostGitEnvironment` recognizes either a direct GitHub token or the broker pair and installs the Node credential helper into Git's numbered configuration (`packages/worker/src/git-transport.ts:229-270`). The isolated transport checks the assigned branch and fast-forward ancestry, then runs `git push --no-verify` (`packages/worker/src/git-transport.ts:75-153`).
5. When Git asks for an HTTPS credential, the helper accepts only the configured Git host, calls the shared GitHub token resolver, and returns `x-access-token` plus the resolved token as Git's password (`packages/runtime-codex/src/git-credential-helper.ts:23-72`).
6. The shared resolver first reuses a cache entry only when it remains valid beyond the 60-second reuse window. Otherwise it validates the broker URL, POSTs the broker secret as `Authorization: Bearer ...`, requires `{ token, expiresAt }`, writes the optional mode-0600 cache, and returns the token (`packages/tool-github-graphql/src/tool.ts:274-346`). Git sends that short-lived token to the repository HTTPS endpoint.

The same GitHub token resolver supplies the host-owned `github_graphql` execution path before the request is sent to GitHub (`packages/tool-github-graphql/src/tool.ts:57-74,274-346`; `packages/tracker-github/src/orchestrator-adapter.ts:109-124`).

### Separate agent-provider path

`AGENT_CREDENTIAL_BROKER_URL` / `AGENT_CREDENTIAL_BROKER_SECRET` has a different response shape: `{ env, expires_at? }` (`packages/core/src/runtime/adapter.ts:3-8`). Codex POSTs to that endpoint, optionally reuses or writes an agent-credential cache, extracts the allowed OpenAI variables, and injects them into the runtime plan (`packages/runtime-codex/src/runtime.ts:704-717,914-1009`; `packages/core/src/runtime/credentials.ts:7-29,48-100`). Claude's preflight independently probes the endpoint with a five-second timeout and requires `ANTHROPIC_API_KEY` in the returned map (`packages/runtime-claude/src/preflight.ts:251-358`). This broker never supplies GitHub publication credentials.

## 2. Genuine dependencies versus mentions

### Re-runnable method and counts

The count below is a file count at this commit, not a count of textual hits. It deliberately searches both broker families and common prose/identifier orderings:

```sh
pattern='credential.?broker|broker.?credential|token.?broker|broker.?token|GITHUB_TOKEN_BROKER|AGENT_CREDENTIAL_BROKER'

# Production TypeScript
rg -l -i "$pattern" packages --glob '*.ts' --glob '!*.test.ts' | sort

# Tests
rg -l -i "$pattern" packages test --glob '*.test.ts' --glob '*.spec.ts' | sort

# Documentation
rg -l -i "$pattern" docs README.md packages/cli/README.md packages/*/README.md \
  --glob '!2026-09-05-credential-broker-footprint.md' | sort -u
```

The result is **19 production files, 17 test files, and 8 pre-existing documentation files**. Across `packages`, `test`, `docs`, root `README.md`, and `e2e` (excluding the upstream spec and this report), the same pattern produces 387 matching lines. Line counts are reported only as a discovery checksum because one line may contain several identifiers.

The 19 production files split as follows:

| Classification                                         | Count | Files                                                                                                                                                                                                                                                                           | Why it belongs here                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential resolution or consumption                   | **7** | `core/runtime/credentials.ts`; `runtime-codex/runtime.ts`; `runtime-codex/git-credential-helper.ts`; `runtime-claude/preflight.ts`; `tool-github-graphql/tool.ts`; `tracker-github/orchestrator-adapter.ts`; `worker/git-transport.ts`                                          | These fetch, cache, select, validate for use, or consume brokered credentials. Removing the broker changes their executable behavior. Representative call sites are `runtime.ts:914-1009`, `preflight.ts:251-358`, `tool.ts:274-346`, and `git-transport.ts:229-270`.                                                                                                                                               |
| Active routing, isolation, or guard plumbing           | **8** | `core/runtime/custom-child-env.ts`; `runtime-codex/launcher.ts`; `runtime-claude/adapter.ts`; `runtime-claude/mcp-compose.ts`; `tool-github-graphql/mcp-entry.ts`; `tool-github-graphql/mcp-server.ts`; `worker/non-codex-runtime.ts`; `worker/tracker-credential-preflight.ts` | These ferry configuration to a host consumer, strip it from a child, compose a legacy MCP entry, or reject incomplete configuration. They are behaviorally relevant today, but most edits fall out once the seven consumers have a replacement. Examples: `custom-child-env.ts:64-90`, `runtime-codex/launcher.ts:32-65`, `runtime-claude/adapter.ts:716-752,836-873`, and `tracker-credential-preflight.ts:37-57`. |
| Type, validation-entry, factory, or diagnostic surface | **4** | `core/runtime/adapter.ts`; `orchestrator/runtime-factory.ts`; `tool-github-graphql/url-policy.ts`; `cli/commands/doctor.ts`                                                                                                                                                     | These name the abstraction, validate its URL at an entry boundary, satisfy a generic adapter method, or tell an operator how to configure it. They do not obtain a credential for their own use (`adapter.ts:3-8,31-66`; `runtime-factory.ts:75-136`; `doctor.ts:450-486`).                                                                                                                                         |

Thus **7 of 19 production files genuinely resolve or consume credentials**; **12 of 19 are supporting plumbing or mentions**. The 17 test files and 8 documentation files are not runtime consumers. They should be changed only alongside the production boundary they specify, not treated as 25 additional dependencies.

The classification intentionally counts `worker/git-transport.ts` as a consumer even though it delegates token acquisition to the helper: without a direct token or broker-backed helper, its authenticated push cannot succeed. Conversely, the worker preflight is plumbing: it recognizes acceptable shapes but never uses a token (`packages/worker/src/tracker-credential-preflight.ts:20-65`).

## 3. Does the worker's own git push depend on it?

**No—the worker's push does not depend specifically on the broker; it depends on either a direct `GITHUB_GRAPHQL_TOKEN` or the complete broker pair.**

The startup preflight accepts exactly those two alternatives (`packages/worker/src/tracker-credential-preflight.ts:37-57`). The Git transport makes the same choice and creates a credential helper for either alternative (`packages/worker/src/git-transport.ts:229-244`). Therefore broker removal with `GITHUB_GRAPHQL_TOKEN` retained at the host boundary preserves publication; deleting the broker without supplying that direct credential (or a new equivalent host credential source) prevents worker startup and authenticated push.

Host-side publication is already separated from the coding child. The orchestrator endpoint re-resolves credentials and performs `trySynchronizeAssignedBranch` itself (`packages/orchestrator/src/service.ts:565-607`), while the Codex plan deletes tracker secrets and all host Git configuration before spawn (`packages/runtime-codex/src/runtime.ts:640-669,803-829`). Claude performs the equivalent removal (`packages/runtime-claude/src/adapter.ts:700-752`). Consequently Codex does **not** currently receive broker-backed Git access: it can edit and commit locally, but authenticated publication is the worker/orchestrator's responsibility.

The board-stopping failure is real only if Phase 4 removes the broker and the host credential alternative together. Preserve a host-only token source and the publication endpoint, and host-side publication survives.

## 4. What #835's timeout fix protects

#835 (`2f89d566`, released in `@gh-symphony/cli@2.0.0`) bounds the **Git credential helper's broker fetch**, not all broker traffic. It adds a default 5,000 ms `AbortSignal.timeout`, validates `GITHUB_TOKEN_BROKER_TIMEOUT_MS`, turns timeout causes into an attributable error, and exits the helper synchronously with failure (`packages/runtime-codex/src/git-credential-helper.ts:7-10,43-65,114-169`). `worker/git-transport.ts:229-244` forwards the setting to that helper.

Removing the GitHub broker eliminates that particular hung network fetch when Git uses a direct token: `resolveGitHubGraphQLToken` immediately returns `config.token` (`packages/tool-github-graphql/src/tool.ts:284-287`). It does **not** make every equivalent wait disappear:

- The generic GitHub GraphQL resolver's own broker POST has no internal timeout (`packages/tool-github-graphql/src/tool.ts:314-322`). Today the helper wraps it, but host-side tracker tool calls invoke it without that wrapper (`tool.ts:57-66`).
- The agent broker POST in the Codex runtime has no timeout (`packages/runtime-codex/src/runtime.ts:964-971`).
- Claude's agent-broker preflight does have its own timeout (`packages/runtime-claude/src/preflight.ts:314-322`).
- Explicit assigned-branch publication has an outer 10-second `Promise.race` at the orchestrator endpoint (`packages/orchestrator/src/service.ts:595-619`), but worker-exit publication calls the transport directly (`packages/worker/src/index.ts:2038-2048,2109-2119`).

Accordingly, a direct host token **eliminates** #835's failure mode rather than relocating it. Replacing the broker with another network credential service would relocate it unless that service has a bounded request. The outer publication timeout should remain defense in depth, and any new network resolver needs its own abort deadline.

## 5. Minimum replacement that satisfies the upstream floor

The upstream requirement is narrow: tracker credentials should not be inherited by the coding child, and environment-backed adapters must declare authentication names (`docs/symphony-spec.md:1107-1110`). The current adapter contract already exposes `secretEnvironmentNames()` for that declaration (`packages/core/src/contracts/tracker-adapter.ts:279-294`), and GitHub declares direct tokens, aliases, broker fields, and the cache path (`packages/tracker-github/src/orchestrator-adapter.ts:44-53`).

Minimum per affected consumer:

| Consumer losing broker support                                 | Minimum replacement                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host GitHub tracker operations and host-owned `github_graphql` | Resolve one host-only `GITHUB_GRAPHQL_TOKEN` from project or daemon environment, keep `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_TOKEN`, and `GITHUB_GRAPHQL_TOKEN` declared as authentication names, and continue executing tools host-side. Direct-token handling already exists at `orchestrator-adapter.ts:56-61,109-124` and `tool.ts:284-287`.                                      |
| Worker/orchestrator branch publication                         | Pass that same host-only direct token into `buildHostGitEnvironment`; retain the credential helper's host matching, non-interactive Git, fast-forward checks, host publication endpoint, and outer publication timeout (`worker/git-transport.ts:75-153,229-270`; `orchestrator/service.ts:565-619`). The token must not be placed in the child allowlist.                                |
| Codex Git access                                               | No replacement inside the Codex child is needed for the supported workflow: child Git credentials are deliberately removed (`runtime-codex/runtime.ts:661-669,803-829`), and publication is host-owned. For private fetches or any future authenticated child Git operation, add a narrow host RPC/capability rather than inheriting `GITHUB_GRAPHQL_TOKEN`; otherwise §1107 is defeated. |
| Codex model/provider authentication                            | Use existing local `auth.json` staging or a direct `OPENAI_API_KEY` in the runtime-specific environment (`runtime-codex/runtime.ts:704-731,940-945`). This is not a tracker credential, so §1107-1110 does not require an agent broker.                                                                                                                                                   |
| Claude model/provider authentication                           | Use a direct `ANTHROPIC_API_KEY` or, for non-bare mode, the existing staged local login (`runtime-claude/preflight.ts:251-303`; `runtime-claude/adapter.ts:468-476`). This is likewise outside the tracker-credential floor.                                                                                                                                                              |
| Custom runtime authentication                                  | Continue requiring an explicit `runtime.auth.env` and pass only that selected value; reserved tracker and broker variables remain excluded (`core/runtime/custom-child-env.ts:64-95`; `orchestrator/runtime-factory.ts:129-136`).                                                                                                                                                         |

The smallest safe implementation is therefore not a new broker: it is a host-only direct GitHub credential, the existing adapter-declared removal list, and the existing host publication/tool boundary.

## 6. Recommendation

**Must be split into 3 issues, in this order:**

1. **Migrate host GitHub GraphQL from broker to declared direct host credential.** Remove broker selection, fetching, caching, MCP-entry plumbing, preflight/doctor messaging, and associated tests only for tracker GraphQL. Keep adapter authentication-name declarations and prove both orchestrator polling and host-owned agent tool execution. This boundary goes first because the board and status API must remain usable before Git publication changes.
2. **Migrate host Git publication and retire #835's broker-only helper path.** Feed the already-proven host credential from issue 1 into `buildHostGitEnvironment`, retain host matching and both the explicit publication endpoint and worker-exit backstop, and add black-box coverage that publishes from a broker-free environment. Remove `GITHUB_TOKEN_BROKER_TIMEOUT_MS` only after no network resolver uses it. This boundary isolates the failure mode that could strand the fixing branch.
3. **Remove the agent-provider broker and shared residual plumbing.** Delete the independent `{ env, expires_at }` fetch/cache path for Codex and Claude, retain direct provider credentials/local-login behavior, then remove generic broker response types, reserved-name remnants, tests, and documentation. This is ordered last because it cannot help recover a tracker or publication regression and has no reason to share their rollout.

A single issue would combine two protocols and put tracker dispatch, agent tool execution, runtime startup, and recovery publication into one blast radius. Three issues preserve a working control plane and a publishable recovery path after each merge.

## Spec conformance and divergence

This report proposes no change to the upstream specification and no repository-level divergence. The recommended replacement retains the two requirements in `docs/symphony-spec.md:1107-1110`: tracker credentials stay out of coding-agent child environments, and the GitHub adapter continues to declare every authentication-related environment name. No source, configuration, CLI, package structure, or runtime behavior is changed by this spike.
