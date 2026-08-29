# ADR: Add `claude -p` runtime support (multi-runtime abstraction)

- **Date**: 2026-04-15
- **Status**: Proposed
- **Maintenance note (2026-08-28)**: Historical source line references below
  are point-in-time and may be stale. Claude `result` usage fields are not
  currently consumed as an authoritative usage accounting source.
- **Revisions**:
  - 2026-04-15 r1 — initial draft
  - 2026-04-15 r2 — added 3 permission presets + legacy reverse mapping
  - 2026-04-15 r3 — incorporated Codex review, slimmed rewrite to v1 scope (see §11 for the scope reduction details)
  - 2026-04-15 r4 — incorporated 5 up-front decisions: split out the neutral `tool-github-graphql` package (precedes P1), hybrid MCP composition, per-layer session handling (intra-run resume / inter-run fork), added `expires_at?` to the broker contract, made the isolation knobs (`--bare`/`--strict-mcp-config`) opt-in. See "r4 new decisions" in §11 for the detailed change points.
  - 2026-04-15 r5 — split ACP support into a separate ADR while incorporating 3 up-front hooks to minimize schema breaks: explicit P1 event naming freeze (§4.2.3), additive `protocol` field in the session file schema (§4.2.1), 3 additional naming debt items (§9). Rationale: `moncher-stack-wiki/research/github-symphony-acp-support.ko.md`. See "r5 new decisions" in §11 for the detailed change points.
- **Related Spec**: `docs/symphony-spec.md` §5 (Workflow), §10 (Runtime Events), §13 (Runtime Snapshot)
- **References**:
  - Anthropic Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
  - Anthropic headless / Agent SDK (CLI) guide: https://code.claude.com/docs/en/headless
  - Anthropic permission modes: https://code.claude.com/docs/en/permission-modes

---

## 1. Context

The current implementation runs only one AI coding agent runtime: the **Codex app-server (JSON-RPC daemon)**. `packages/worker/src/index.ts:555 runCodexClientProtocol` assumes a `thread/start` → multiple `turn/*` → `shutdown` loop, and `packages/runtime-codex/src/runtime.ts:136` hardcodes the default command to `codex app-server`. The `"claude-code"` strings scattered across the repository only refer to authoring / skill directory paths; there is no actual execution path.

Adding support for the Anthropic `claude -p` (non-interactive CLI) runtime takes more than swapping the command. The process lifecycle, credential model, MCP wiring, and how WORKFLOW.md is exposed all differ.

This ADR targets exactly one success condition: **"make the current Codex experience equally usable with Claude."** Permission abstraction, automatic allowlist generation, legacy reverse mapping, and the like are deliberately excluded from scope (see §11).

## 2. Relationship to the Upstream Spec

`docs/symphony-spec.md` is **not modified**. The contents of this ADR are treated as a repo-local divergence.

Codex symbols already baked into the spec / contracts (`OrchestratorChannelCodexUpdateEvent`, `codexTotals`, `codex_totals`, `WorkflowCodexConfig`, `DEFAULT_CODEX_COMMAND`, etc.) are not renamed in this ADR. We accept that Claude runtime data will flow under these names for the time being. Renaming cleanup is handled in a separate follow-up ADR.

## 3. Official `claude -p` Contract (docs verified 2026-04-15)

### 3.1 Base argv (default, always included)

| Flag                                                         | Reason                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `-p` / `--print`                                             | non-interactive execution                                                                               |
| `--output-format stream-json` + `--input-format stream-json` | NDJSON events / multi-message injection                                                                 |
| `--include-partial-messages` + `--verbose`                   | include delta token events                                                                              |
| `--permission-mode bypassPermissions`                        | functionally equivalent to the current Codex `danger-full-access`. Assumes an isolated workspace (§4.4) |
| `--session-id <uuid>` / `--resume <id>` / `--fork-session`   | session management across turns/runs (§4.2)                                                             |

### 3.2 Isolation opt-in flags (§4.8)

Flags not included in the base argv, selected via `runtime.isolation` in WORKFLOW.md.

| Flag                                   | Effect                                                                       | Default | How to select                               |
| -------------------------------------- | ---------------------------------------------------------------------------- | ------- | ------------------------------------------- |
| `--bare`                               | skips auto-discovery of hooks / skills / plugins / auto memory (`CLAUDE.md`) | **off** | `runtime.isolation.bare: true`              |
| `--strict-mcp-config --mcp-config <f>` | blocks all MCP auto-discovery, loads only `<f>`                              | **off** | `runtime.isolation.strict_mcp_config: true` |

### 3.3 Key constraints

- **Slash skills unavailable**: verbatim from the official docs — _"User-invoked skills like `/commit` and built-in commands are only available in interactive mode."_ In `-p` mode, `.claude/skills/*` cannot be invoked as user-invocable slash commands. This is a CLI constraint independent of `--bare`.
- **OAuth/keychain**: with `--bare` on (and no `apiKeyHelper` configured), `ANTHROPIC_API_KEY` is required. With `--bare` off, a local Claude Code login can also be used.
- **One-shot per invocation**: not a long-lived JSON-RPC daemon like the Codex app-server. A new process per turn (§4.2).

## 4. Decision

### 4.1 Phased introduction

| Phase                                | Scope                                                                                                                                                                                                                                                                                    | Completion criteria                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P1.0 — Preliminary split**         | Create `packages/tool-github-graphql/`. Move the current `packages/runtime-codex/src/github-graphql-tool.ts` / `github-graphql-mcp-server.ts` and their tests. `runtime-codex` references the new package as a dependency.                                                               | No functional change beyond import paths. No Codex regression.                                                                                                                 |
| **P1 — Adapter abstraction**         | Introduce an `AgentRuntimeAdapter` interface in `packages/core` (including the spawn-loop contract), port the existing `runtime-codex` behind that interface. The worker depends only on the adapter. Normalize the agent event names the worker sees to a runtime-neutral set (§4.2.3). | No functional change. No Codex regression. Zero remaining Codex wire names (`turn/completed`, `dynamic_tool_call_request`, `item/tool/requestUserInput`) in the worker source. |
| **P2 — New `runtime-claude`**        | Add `packages/runtime-claude`. Implement `AgentRuntimeAdapter` with a `claude -p` one-shot invocation loop. Credential consumption branching (§4.3), MCP composition (§4.6.2), session management (§4.2), `doctor` / `init` preflight extensions (§4.5).                                 | One issue handled end-to-end in Docker E2E with a stub `claude` binary.                                                                                                        |
| **P3 — `runtime.kind` front-matter** | Introduce a `runtime:` block in WORKFLOW.md (§5.2). The existing `codex:` block remains backward compatible.                                                                                                                                                                             | Runtime selection promoted to a first-class setting.                                                                                                                           |

### 4.2 Worker process model branching

- **Codex app-server**: keep the existing `runCodexClientProtocol`.
- **Claude `-p`**: **one-shot per Symphony turn**.
  1. First turn: issue a fixed `--session-id <generated-uuid>`, persist the session id (§4.2.1).
  2. Turn retry within the same run (**intra-run retry**): `--resume <session-id>`. Preserving the context of the immediately preceding failure prevents repeating the same mistake.
  3. Orchestrator run re-dispatch (**inter-run recover**): read the previous run's session id and issue a new session with `--resume <session-id> --fork-session`. Cuts off accumulated contamination and resets cache cost.
  4. Receive NDJSON events via `--output-format stream-json --include-partial-messages --verbose`.
  5. Determine the turn result from the exit code + final event (§4.2.2).

The existing `thread-resume.ts`, `turn-limits.ts`, and `convergence-detection.ts` are reinterpreted as a **"process spawn loop"** to fit the P1 adapter interface.

#### 4.2.1 Session id persistence

- Path: `.runtime/orchestrator/runs/<run-id>/claude-session.json`
- Contents: `{ protocol: "claude-print", sessionId: string, createdAt: ISO8601, parentRunId?: string, protocolState?: Record<string, unknown> }`.
  - Making the `protocol` field explicit allows an additive transition to a shared session schema (see the §9 naming debt for file consolidation) when additional protocols such as ACP are supported in the future.
  - `parentRunId` links to the previous run during inter-run recover.
  - `protocolState` is a runtime-specific opaque metadata slot (resume tokens, capability negotiation results, etc.).
- Fallback on read failure / session expiry (`--resume` 4xx): issue a new `--session-id` (without fork), keep the link via `parentRunId`. Log `session_invalidated` in the run events.

#### 4.2.2 Exit code rules

| Claude exit | Final `result` event | Interpretation                                           | Next action                                             |
| ----------- | -------------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| 0           | `success`            | turn succeeded                                           | apply run continuation policy                           |
| 0           | `error_*`            | application-level failure within the turn                | emit `turn/failed`, delegate to retry rules             |
| non-0       | (none / SIGTERM)     | process-level failure (API error, rate limit, misconfig) | determine whether transient, then retry or fail the run |

The concrete per-event-name mapping table is finalized in implementation issue (#6).

#### 4.2.3 Event naming freeze (P1 merge gate)

The agent event names the worker depends on are frozen as a runtime-neutral set. Each adapter (`runtime-codex`, later `runtime-claude`) maps its own wire protocol events to these names. The worker knows no names outside this set.

| Neutral event             | Codex original               | claude-print original (P2)                    | Notes                                 |
| ------------------------- | ---------------------------- | --------------------------------------------- | ------------------------------------- |
| `agent.turnStarted`       | `turn/started`               | `message_start` / first `content_block_delta` | start of a turn boundary              |
| `agent.turnCompleted`     | `turn/completed`             | `result` (stop_reason != error)               | accompanied by a usage payload        |
| `agent.toolCallRequested` | `dynamic_tool_call_request`  | `tool_use` content block                      | tool bridge entry point               |
| `agent.inputRequired`     | `item/tool/requestUserInput` | (N/A — Anthropic `-p` does not emit it)       | immediate failure per Symphony policy |
| `agent.rateLimit`         | `turn/rate_limit`            | `result.usage.rate_limit`                     | for backoff decisions                 |
| `agent.messageDelta`      | `item/message/delta`         | `content_block_delta`                         | token stream (logging/observability)  |
| `agent.error`             | `error` / non-0 exit         | `error` / non-0 exit                          | classification rules of §4.2.2 apply  |

The concrete payload schema is finalized in the implementation issue. **The name set in this table is the P1 merge gate** — if a grep of the worker source still finds Codex wire names, P1 is considered incomplete.

Rationale: this set is consistent with the `AgentEvent` proposal in `moncher-stack-wiki/research/github-symphony-acp-support.ko.md` §3. The shape is intentional so that when the ACP support ADR lands, adding a single mapping line under the same names is all that is needed.

### 4.3 Credential model

- `AgentRuntimeAdapter` gets a `resolveCredentials(brokerResponse): RuntimeEnv` slot.
- **Broker contract extension (additive)**: extend the response schema to `{ env: Record<string, string>, expires_at?: string (ISO8601) }`. If `expires_at` is unspecified, fall back to lifetime reuse (legacy broker compatible).
- **Consumer-side branching** — each runtime extracts only the env keys it needs from the broker response:
  - Codex: keep the existing consumption logic for `OPENAI_API_KEY`, `OPENAI_BASE_URL`, etc.
  - Claude: `ANTHROPIC_API_KEY`. If absent, a clear error at the preflight stage.
- **Cache**: store an `expires_at`-bearing payload in the current `agentCredentialCachePath` file. Reuse if within `TOKEN_REUSE_WINDOW_MS` of expiry; re-call the broker once expired.
- Codex-specific assets (`CODEX_HOME` staging) remain as-is.

### 4.4 Permission model (single v1 preset)

v1 supports **only `permissive` behavior**. Claude uses `--permission-mode bypassPermissions`; Codex keeps the existing `approval_policy: never` + `thread_sandbox: danger-full-access` (the current defaults in `packages/worker/src/codex-policy.ts:18-24`, unchanged).

Rationale for this choice:

1. **Symphony workers treat "human intervention = failure"** (in `packages/worker/src/index.ts:891-920`, `turnParams.inputRequired === true` triggers immediate SIGTERM + run failure). Therefore modes that "ask a human" — Codex `on-request` / Claude `default` and `acceptEdits` — are meaningless in the orchestrator context.
2. The current Codex experience is already `danger-full-access`. Introducing Claude must not amount to a regression.
3. Symphony operates on the premise of per-issue `.runtime/symphony-workspaces/<id>/` throwaway clones + Docker E2E. This satisfies the "isolated environments" condition the Anthropic docs give for recommending `bypassPermissions`.

Users who want to narrow permissions write the argv themselves via **`runtime.kind: custom`**. Formal presets (e.g. strict-ci / safe-edits) are handled in a separate ADR once real demand accumulates.

**Fixed documentation wording** — automatically inserted by the WORKFLOW.md generator when the Claude runtime is selected:

> **Permissive preset requires an isolated workspace.** Symphony runs each issue in `.runtime/symphony-workspaces/<workspace-id>/`, a throwaway clone. If you disable workspace isolation or mount host paths into worker containers, do not use this runtime in production.

### 4.5 Preflight readiness (required for v1)

Blocker comments during execution alone cannot prevent the common cases that "break before starting." Therefore the following is included as **required for v1**.

- `doctor` extension (extend the branch at `packages/cli/src/commands/doctor.ts:1011`):
  - `claude` binary presence / version.
  - Whether `ANTHROPIC_API_KEY` is set, or credential broker reachability (only when Claude is selected).
  - Readability of `.mcp.json` at the workspace root (absence is OK, read failure is a warn).
  - `gh` authentication status (shared with Codex).
- `init` runs the checks above once locally, right after runtime selection, and prints human-readable errors.
- The worker performs the same checks at startup as well and, on failure, signals explicitly via exit code + log (a stage before blocker comments).

### 4.6 GitHub GraphQL tool — neutral package + MCP composition

#### 4.6.1 Relocation into a neutral package (precedes P1.0)

The current `packages/runtime-codex/src/github-graphql-tool.ts` and `github-graphql-mcp-server.ts` are **runtime-neutral assets** (no Codex-related logic; a simple GraphQL wrapper + MCP stdio server). In the P1.0 preliminary issue, move them into a `packages/tool-github-graphql/` package. Both runtime adapters reference the new package as a dependency.

Rationale: an import graph where `runtime-claude` depends on `runtime-codex` undermines the purpose of the adapter abstraction.

#### 4.6.2 MCP config composition (Claude only)

During worker initialization, the symphony-required MCP (`github_graphql`) is merged with the user's `.mcp.json`. The merge result is always written to an ephemeral file in the worker runtime directory so the checkout root is not polluted. `runtime.isolation.strict_mcp_config` only controls whether auto-discovery is blocked:

| `strict_mcp_config` | Merge result location                        | argv addition                             |
| ------------------- | -------------------------------------------- | ----------------------------------------- |
| **false (default)** | `WORKSPACE_RUNTIME_DIR/mcp.json` (ephemeral) | `--mcp-config <path>`                     |
| true                | `WORKSPACE_RUNTIME_DIR/mcp.json` (ephemeral) | `--strict-mcp-config --mcp-config <path>` |

Merge rules:

- Base: the contents of `.mcp.json` at the workspace root if present, otherwise `{ mcpServers: {} }`.
- Overwrite: the `mcpServers.github_graphql` key is overwritten with the symphony-managed value (command path / env / token decided at runtime).
- Other user-authored keys are preserved.

The Codex runtime keeps its existing `CODEX_HOME` staging and does not go through MCP composition.

### 4.7 Prompt branching

When the Claude runtime is selected, `generate-workflow-md.ts` inserts the following section at the top of the prompt body.

```md
### Runtime Constraints

1. This run uses `claude -p` in non-interactive mode.
2. Slash commands such as `/commit`, `/push`, `/gh-project`, `/gh-pr-writeup` are NOT available (CLI limitation, independent of isolation settings).
3. Use `gh`, `git`, repository scripts, and configured MCP tools directly instead.
4. If a required permission or tool is unavailable, post a blocker comment on the issue and exit. Do not wait for human input.
```

The Codex runtime prompt stays as-is.

### 4.8 Isolation knobs (opt-in)

Whether the operator's personal environment (`~/.claude/`, custom MCPs) and team assets (`CLAUDE.md`, `.claude/skills/`) are exposed to workers is a **team policy**, not a framework default. Exposed via two knobs:

| Knob                                  | off (default) — Claude Code native                                                                                         | on — isolated                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `runtime.isolation.bare`              | `CLAUDE.md` auto-injected, skills/hooks/plugins discovery active                                                           | adds `--bare` to argv — skips all discovery                                                                    |
| `runtime.isolation.strict_mcp_config` | loads both the user `.mcp.json` and `~/.claude` MCPs. The Symphony MCP is supplied via `--mcp-config <ephemeral>` (§4.6.2) | adds `--strict-mcp-config --mcp-config <ephemeral>` to argv. Only the Symphony-merged ephemeral file is loaded |

Rationale for the defaults:

- Same philosophy as making `bypassPermissions` the v1 default in §4.4: "start broad; teams that want to narrow opt in explicitly."
- When a team uses `CLAUDE.md` and `.claude/skills/`, deliberately ignoring them is the bigger surprise.
- Teams that need isolation in multi-tenant / CI environments can switch with a two-line opt-in.

Trade-off disclosure — inserted as a comment by the WORKFLOW.md generator when the Claude runtime is selected:

> Isolation is off by default — the agent will pick up your `CLAUDE.md`, project skills, and personal MCPs from `~/.claude/`. Turn isolation on when running in multi-operator CI, shared infrastructure, or when reproducibility across machines matters.

## 5. WORKFLOW.md schema (v1)

### 5.1 Short-term compatibility (P1-P2)

Reuse the existing `codex:` block. Only the command string is replaced.

```yaml
codex:
  command: >-
    claude -p
    --output-format stream-json --input-format stream-json
    --verbose --include-partial-messages
    --permission-mode bypassPermissions
  read_timeout_ms: 5000
  turn_timeout_ms: 3600000
  stall_timeout_ms: 900000
```

No parser changes. Isolation flags (`--bare` / `--strict-mcp-config`) are added manually when needed.

### 5.2 Formal (P3)

Introduce the `runtime:` block. The old `codex:` block is kept as a deprecated alias.

```yaml
runtime:
  kind: claude-print # codex-app-server | claude-print | custom
  command: claude
  args:
    - -p
    - --output-format
    - stream-json
    - --input-format
    - stream-json
    - --verbose
    - --include-partial-messages
    - --permission-mode
    - bypassPermissions
  isolation:
    bare: false # when true, --bare is added automatically
    strict_mcp_config: false # when true, --strict-mcp-config + an ephemeral --mcp-config are injected automatically
  auth:
    env: ANTHROPIC_API_KEY
  timeouts:
    read_timeout_ms: 5000
    turn_timeout_ms: 3600000
    stall_timeout_ms: 900000
```

The parser prefers `runtime:`, falling back to the existing `codex:` block if absent. **No legacy → preset reverse inference.** Old configuration is interpreted as-is.

Session resume behavior (§4.2) is **not exposed in the schema**. Intra-run `--resume` / inter-run `--fork-session` are framework defaults. A follow-up ADR if real demand emerges.

## 6. User stories

- As a repository maintainer, I can switch between the Codex and Claude runtimes by editing only WORKFLOW.md.
- As a team lead, when I commit `.mcp.json` / `CLAUDE.md` / `.claude/skills/`, the worker uses them as-is. When I need isolation, I turn it on with two lines of `runtime.isolation`.
- As an orchestrator operator, I see the same run lifecycle / session id / `lastEventAt` / token usage regardless of runtime kind.
- As a new Claude user, `gh-symphony init` or `gh-symphony doctor` tells me everything I need (binary, API key, gh auth) at once, **before starting**.
- As a retry/recovery flow, the worker preserves context intra-run with `--resume`, and cuts off accumulated contamination for inter-run recover with `--fork-session`.

## 7. Test plan

- Unit: `AgentRuntimeAdapter` interface conformance, `runtime-claude` argv assembly (including the isolation off/on branches), session id save/restore.
- Unit: `parseWorkflowMarkdown` accepts `runtime.kind=claude-print` + the `runtime.isolation` block and coexists with the legacy `codex:` block.
- Unit: Claude NDJSON events → `OrchestratorChannelEvent` normalization + exit code classification (§4.2.2).
- Unit: MCP composition — (a) no user `.mcp.json`, (b) present, (c) ephemeral path creation when `strict_mcp_config=true`.
- Unit: credentials — broker response `{env, expires_at?}` cache hit/miss, Claude extracts only `ANTHROPIC_API_KEY`.
- Unit: `doctor` reports missing binary / missing `ANTHROPIC_API_KEY` / unauthenticated gh, each as a human-readable message.
- Integration: with a stub `claude` binary (Bash shim), the worker transitions `Ready → In progress → In review`.
- E2E (Docker): in the `AGENT_TEST.md` environment, process one issue end-to-end with the Claude stub; `--resume` is preserved on the intra-run retry path / `--fork-session` behaves on the inter-run recover path.
- Regression: no change to the existing Codex path (P1.0 + P1 merge gate).

## 8. Open questions

Items resolved in r4:

- ~~Who generates `.gh-symphony/claude-mcp.json`~~ → **Resolved**: no Symphony-specific file is created. The worker composes using the workspace root `.mcp.json` as the base (§4.6.2).
- ~~`--fork-session` default~~ → **Resolved**: intra-run retry = `--resume` (no fork), inter-run recover = `--resume + --fork-session`. Not exposed in the schema (§4.2).
- ~~API key rotation policy~~ → **Resolved**: `expires_at?` added to the broker response; rotation via cache hit/miss (§4.3).
- ~~Isolation default~~ → **Resolved**: both `--bare` / `--strict-mcp-config` default off, knob opt-in (§4.8).

Remaining:

1. Concrete normalization table per stream-json event name (finalized in the body of implementation issue #6).
2. Stub `claude` Bash shim input/output contract (finalized in the body of implementation issue #9).

## 9. Naming debt / follow-up (deferred)

Out of scope for this ADR. Handled in a separate ADR.

- `OrchestratorChannelCodexUpdateEvent` / `codex_update` event type
- `codexTotals` / `codex_session_logs` status surface fields
- `WorkflowCodexConfig` / `DEFAULT_CODEX_COMMAND`
- `symphony-spec.md §4.1.8 codex_totals` — an upstream spec document, so modification is prohibited. Interpreted as "the aggregate of the active runtime."
- Rename `AgentRuntimeAdapter` → `AgentProtocolClient`. Re-evaluate when the ACP support ADR lands. While only claude-print is supported, the "runtime" naming still feels natural.
- Relocate `packages/runtime-codex`, `packages/runtime-claude` → `packages/protocol-*`. This becomes meaningful once the context arises that ACP is a standard protocol rather than a "runtime." Before that, the effort outweighs the benefit.
- `.runtime/orchestrator/runs/<run-id>/claude-session.json` → consolidate into a runtime-neutral `agent-session.json` filename. The `protocol` field of §4.2.1 is designed to serve as the discriminator, so additive consolidation is possible.

## 10. Consequences

### Positive

- The runtime abstraction + the `tool-github-graphql` split let additional runtimes such as Bun or Rust plug in under the same contract.
- The two isolation knobs make the "reproducibility vs. leveraging team assets" trade-off decidable at the team-policy level.
- The `init` + `doctor` preflight readiness moves the response from "after a blocker comment" forward to "a local error message."
- The credential broker contract extension is additive, so existing deployments do not break.

### Negative

- The worker multi-turn loop must be redesigned as a "process spawn loop," so P1 must come first. Entering P2 without P1 makes the change footprint dangerously large.
- On the Claude side, OAuth/keychain can be used with `--bare` off, but with it on, `ANTHROPIC_API_KEY` is required — both paths need testing.
- The `codex_*` naming will also carry Claude runtime data for the time being, leaving temporary semantic debt.
- Since the single `permissive` mode is all of v1, teams that want to tighten security must manage the argv themselves via `custom`.
- Default isolation off provides "the Claude Code native experience," but reproducibility across operator environments depends on team policy. Teams must explicitly turn isolation on for reproducibility to be guaranteed.

### Neutral

- The Symphony upstream spec is not changed; this ADR is formalized as a repo-local extension.

---

## 11. Items excluded / retained / added relative to earlier revisions

### 11.0 r5 new decisions

ACP support was decided to be split into a separate ADR. This ADR's scope stays with claude-print, but the following is incorporated up front **so that schema breaks are minimal when ACP is introduced**.

Rationale document: `moncher-stack-wiki/research/github-symphony-acp-support.ko.md` (ChatGPT design consultation, archived 2026-04-15).

- **Explicit P1 event naming freeze** (§4.1 P1 completion criteria, §4.2.3) — the agent event names the worker sees are frozen as a runtime-neutral set (`agent.turnStarted` / `agent.turnCompleted` / `agent.toolCallRequested` / `agent.inputRequired` / `agent.rateLimit` / `agent.messageDelta` / `agent.error`). Consistent with the `AgentEvent` proposal in Research §3. P1 merge gate.
- **Additive `protocol` + `protocolState?` in the session file schema** (§4.2.1) — used as a discriminator + opaque slot when consolidating ACP sessions in the future. No functional change.
- **3 additional naming debt items** (§9) — adapter rename (`AgentRuntimeAdapter` → `AgentProtocolClient`), package relocation (`runtime-*` → `protocol-*`), session filename consolidation. All re-evaluated in the ACP support ADR.

Research proposals explicitly **not accepted**:

- Full introduction of the `AgentCapability` union (`tool` / `fs` / `terminal` / `approval`) — claude-print achieves equivalent capability via MCP + `bypassPermissions`, so this is over-abstraction for v1. Necessity re-evaluated in the ACP support ADR.
- The `capabilities:` block in WORKFLOW.md — unnecessary for v1 for the same reason. Added when real knob demand arises.
- The `protocol-*` package rename — recorded only as naming debt; the actual code stays (§9).

### 11.1 r4 new decisions

- **Split out the neutral `tool-github-graphql` package** (§4.1 P1.0, §4.6.1) — avoids an import graph where runtime-claude depends on runtime-codex.
- **Hybrid MCP composition** (§4.6.2) — using the user's `.mcp.json` as the base, branch between workspace mutation and ephemeral output depending on the `strict_mcp_config` value. No Symphony-specific file such as `.gh-symphony/claude-mcp.json` is created.
- **Per-layer session handling** (§4.2) — intra-run retry uses `--resume`, inter-run recover uses `--resume + --fork-session`. Not exposed in the schema.
- **Broker response `expires_at?` added** (§4.3) — additive. Legacy broker fallback guaranteed.
- **Isolation knobs `runtime.isolation.bare` / `strict_mcp_config`** (§3.2, §4.8, §5.2) — both default off. Teams opt in.

### 11.2 Items excluded in r3 (still excluded in r4/r5)

At the time of the r3 rewrite, reflecting the Codex review and the user principle ("it must be simple"), the following were moved **out of v1 scope**. Still valid as-is in r4 / r5.

#### Exclusion 1: Permission preset abstraction (`permissive` / `safe-edits` / `strict-ci` / `custom`)

- **What r2 had**: a `runtime.permission.preset` field and a 3-preset table. A design that grouped Claude `acceptEdits` / `dontAsk` and Codex `on-request` / `workspace-write` / `read-only` under the same preset names.
- **Reasons for exclusion**:
  1. Symphony workers behave as "immediate SIGTERM + failure on user input request" in `packages/worker/src/index.ts:891-920`. Therefore "ask a human" modes such as `on-request` / `acceptEdits` are meaningless in the orchestrator context, and the Codex-side `safe-edits` / `strict-ci` are **effectively inoperable**. Packaging them under the same names would promise users a false symmetry.
  2. The single `permissive` is sufficient to meet the v1 success condition ("the Codex experience, as-is, with Claude").
- **v1 handling**: only `permissive` behavior is supported. To narrow, write the argv directly via `runtime.kind: custom` (§4.4).
- **Follow-up**: a separate ADR once real demand accumulates. At that point it is likely the preset names will be kept **different per runtime**, abandoning the shared abstraction.

#### Exclusion 2: `runtime.permission.extra_allow` / `extra_deny`

- **What r2 had**: declaring per-project allowlist extensions / deny rule extensions in YAML.
- **Reasons for exclusion**: with the preset abstraction gone, there is nowhere to attach it. `extra_deny` has no corresponding concept on the Codex side, creating a per-runtime feature gap.
- **v1 handling**: write `--allowedTools` / `--disallowedTools` directly in the `custom` argv.
- **Follow-up**: re-evaluate together with the preset ADR.

#### Exclusion 3: Automatic `safe-edits` allowlist generation (based on detectEnvironment)

- **What r2 had**: automatically generating `Bash(<packageManager> *)`, `Bash(<testCommand prefix> *)`, etc. from `detectEnvironment` results.
- **Reasons for exclusion**: the actual detector (`packages/cli/src/detection/environment-detector.ts`) only knows the raw `scripts` strings in `package.json` and the package manager. False positives / omissions are frequent with monorepos, Makefiles, justfiles, Docker-based tests, and shell wrappers. With the preset itself gone, the accessory feature goes too.
- **v1 handling**: none.
- **Follow-up**: re-evaluate in the preset ADR. Rather than auto-generation, opening a scaffold file at `init` time for the user to edit directly may be more realistic.

#### Exclusion 4: Legacy `codex:` config → preset reverse mapping

- **What r2 had**: automatically labeling old WORKFLOW.md values such as `thread_sandbox: danger-full-access` as the `permissive` preset.
- **Reasons for exclusion**: the current `codex:` block has `command` / `approval_policy` / `thread_sandbox` / `turn_sandbox_policy` / timeouts as independent fields. Attaching a preset label based on just one of them **could mislead**, making the setup look safer or stricter than it actually is. Since presets themselves are absent from v1, reverse mapping is also unnecessary.
- **v1 handling**: the parser prefers the `runtime:` block if present, otherwise interprets the `codex:` block as-is. No label inference.
- **Follow-up**: revisit when the preset ADR is introduced. A safe line is for `doctor` to only emit a "legacy configuration detected, please add an explicit preset" warning.

#### Exclusion 5: `--exclude-dynamic-system-prompt-sections`

- **What r1 had**: a proposal to include this flag in the base argv to improve the prompt cache hit rate when processing many issues in parallel.
- **Reasons for exclusion**: a performance optimization unrelated to the v1 success condition. Concrete operational guidance (config path, measurement method) was also undefined.
- **v1 handling**: none.
- **Follow-up**: in a separate optimization ADR if token cost actually becomes a problem.

#### Exclusion 6: Claude-internal `--max-turns` mapping

- **What r1 had**: mapping rules between Claude `--max-turns` (the loop inside an invocation) and Symphony `agent.max_turns` (the number of continuations).
- **Current handling (#677)**: Symphony `agent.max_turns` is now enforced by the worker for the Claude print route, exactly as it is for Codex: it bounds Claude process turns within one worker session. The first turn receives the rendered prompt; later turns send continuation guidance and reuse the persisted Claude session with `--resume`. This is deliberately distinct from Claude's own `--max-turns`, which remains unset because it controls Claude-internal tool-loop behavior rather than Symphony worker turns.
- **Timeout handling (#677)**: `runtime.timeouts.read_timeout_ms` limits waiting for the first Claude output, while `turn_timeout_ms` is a silence interval reset by each stdout or stderr chunk. Timeout expiry terminates the print child and reports `response_timeout` or `turn_timeout` to the worker lifecycle.

### 11.3 Core items retained (r3 → r5)

- Runtime adapter abstraction (§4.1 P1) — core.
- `runtime-claude` package (§4.1 P2) — core.
- `runtime.kind` front-matter (§4.1 P3, §5.2) — core.
- `doctor` preflight readiness (§4.5) — required for v1.
- Single supported `permissive` behavior (§4.4).
- Slash-command prohibition notice in the prompt body (§4.7).
- Credential broker (§4.3) — contract made explicit in r4.
- GitHub GraphQL MCP reuse (§4.6) — extended in r4 with the neutral package relocation + composition branching.
