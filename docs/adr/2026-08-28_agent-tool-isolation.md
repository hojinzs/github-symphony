# ADR: Isolate provider-native tools in the Symphony host

- **Date**: 2026-08-28
- **Status**: Accepted
- **Related Issues**: #671, #672, #673, #675
- **Related Spec**: `docs/symphony-spec.md` §10.5, §11.5, §15.1, §15.3, §15.5, §17.5
- **Symphony Layers**: Policy, Execution, Integration, Observability

## Context

Provider-native tracker tools currently run as MCP subprocesses started from
the coding-agent runtime. The Codex runtime supplies tracker credentials in
the child environment, and the Claude runtime writes credentials into its
generated `mcp.json`. This makes the raw GitHub or Linear credential available
to a process and, for Claude, a workspace file controlled by the coding-agent
child.

That arrangement conflicts with the upstream requirements that provider-native
tools execute in the Symphony host with configured adapter credentials, and
that tracker secrets are neither inherited by the coding-agent child nor stored
in a child-readable `WORKFLOW.md`. It is also unsuitable for customer
repositories: a tenant must be able to rely on an agent never receiving its
tracker token.

The existing GitHub token broker and runtime environment allowlists are useful
building blocks. The worker also has an unused dynamic-tool path, but it does
not speak the current Codex app-server `item/tool/call` protocol and cannot be
adopted as-is.

## Decision

Adopt host-side provider-native tool execution in two implementation phases.
The host is the worker/orchestrator side of the Symphony runtime boundary; the
coding-agent runtime is the untrusted child side. Adapter credentials remain
available only to the host process or a host-owned broker.

### Implementation sequencing

Phase 1 is delivered in two parts. Phase 1a (#672) adds adapter secret
metadata, removes raw GitHub tracker tokens from Codex and Claude coding-agent
children when a GitHub token broker is configured, and prevents Claude
`mcp.json` from storing literal tracker tokens in that mode. The broker
credentials remain for the existing `github_graphql` tool and Git workflow.
Without a broker, raw GitHub and Linear credentials remain a documented
temporary Phase 1a divergence so existing agent Git and MCP workflows do not
lose capability; the worker warns operators about this path. Custom runtimes
also retain their GitHub credentials even with a broker because they do not yet
have the shared broker-backed Git helper; Phase 1b (#700) removes both
conditions alongside #673's host-owned transport release.

### Phase 1 — remove tracker secrets from the child boundary (#672)

Every tracker adapter declares `secretEnvironmentNames()`. The declaration
covers raw tracker credentials, and the source names of supported MCP `$VAR`
indirections are retained as secret metadata while configuration is resolved. When a GitHub
token broker is configured, local and remote launchers remove every declared
GitHub name from coding-agent child environments; the Codex and Claude runtime
paths must not add them back. Generated Claude `mcp.json` must contain no
literal raw tracker credential in this mode; the GitHub broker secret remains
available to the child until Phase 1b.

This phase is deliberately a security-boundary prerequisite, not completion of
host-side execution. A legacy MCP subprocess started by the coding agent has no
safe credential channel: its stdio is the JSON-RPC transport, and any inherited
descriptor would be readable by the untrusted parent. The host-owned transport
in phase 2 removes that limitation.

Authenticated Git transport follows the same boundary. The current child-side
Git credential helper receives either a raw GitHub token or broker credentials
and returns a password to Git. Phase 1a keeps the helper and raw credential only
for brokerless compatibility; with a broker it uses the broker path and removes
raw aliases from the child. Phase 1b moves authenticated fetch/push to a
worker-host operation for the assigned branch and removes the temporary
brokerless path. Workflow transitions continue through the orchestrator
transition endpoint and are unaffected by this sequencing.

### Phase 2 — execute tools at the host boundary (#673)

The worker executes the selected adapter's bounded tool implementation with its
configured adapter credential and a normalized, internal tool context:

```ts
type TrackerToolContext = {
  issue: {
    id: string;
    identifier: string;
    nativeRef: unknown;
  };
};
```

`nativeRef` remains opaque to the scheduler and is used only by the adapter to
narrow provider scope. The host must enforce that context in bounded,
issue-aware operations; moving the existing arbitrary GraphQL forwarding paths
host-side alone is not sufficient. Tool names, input schemas, mutation
capability, scope constraints, result/error shape, and rate-limit behavior are
published per adapter. A session snapshots the selected adapter's tool
specifications at startup, so a configuration reload cannot change an
in-flight session.

#### Codex transport

Codex uses the app-server dynamic-tool protocol, not a child MCP process:

```text
worker starts Codex session
  → advertise selected adapter tool specs
  → Codex sends item/tool/call(name, arguments)
  → worker validates name and arguments
  → worker executes adapter tool with host credential + issue context
  → worker returns the protocol response/result to Codex
```

Unknown tool names, invalid arguments, missing adapter auth, provider errors,
and rate limits produce structured failure payloads. In particular, an
unsupported tool call never stalls the Codex session. The obsolete
`dynamic_tool_call_*` and `runToolProcess` route is removed rather than
translated into a second protocol.

#### Claude transport

For Claude, the worker or orchestrator starts an MCP server as a host-owned
per-run service and exposes it over HTTP/SSE (or the then-supported HTTP MCP
transport). It binds to loopback by default on an ephemeral port. The generated
`mcp.json` contains only that URL and a worker-issued, high-entropy session
capability token; it never contains an adapter credential.

The capability token is scoped to one run and MCP server, may call only the
selected adapter's snapshotted tools, is rejected after expiry, and is revoked
when the turn/run ends or the server is torn down. The server must be stopped
on normal completion, cancellation, timeout, and worker crash recovery. The
port is an addressability detail, not an authorization boundary; the session
token and loopback bind are both required.

Both phase-2 launchers retain the isolated child home/configuration directory
from phase 1. Agent preflight must not require `gh auth`, and neither `HOME`,
`GH_CONFIG_DIR`, nor an inherited credential-helper configuration may expose a
host GitHub login. The worker performs authenticated Git transport and tool
calls with its host credential; the child receives only repository state and
bounded results.

### Credential flow

```text
operator secret configuration
          │
          ▼
orchestrator ───────────────► worker host
                               │
                  broker / adapter credential
                               │
                               ▼
                       provider-native tool
                               │ tool result only
                               ▼
                       coding-agent child

The child environment and child-readable workspace files receive no raw
GitHub, Linear, or broker secret. Claude receives only a loopback endpoint and
a scoped session capability; Codex receives only advertised schemas and tool
results.
```

### Linear credential ownership

GitHub can use the existing token broker. Linear must gain the same host-side
property before phase 2 ships. Either extend the broker with a provider-keyed,
scope-limited Linear credential endpoint, or keep the Linear credential solely
in the worker process and invoke the Linear adapter in-process. The latter is
the default implementation choice unless a broker extension is needed for
remote workers. In both cases, the agent receives neither `LINEAR_API_KEY` nor
`LINEAR_AUTHORIZATION`.

## Rejected alternative: retain agent-started MCP subprocesses

Keeping the present subprocess model is convenient because both runtimes
already compose MCP commands. It was rejected as the permanent architecture:

- it leaves the unconditional §15.3 host-execution MUST unmet even if
  `mcp.json` no longer contains a literal secret;
- a child-started process makes credential inheritance and disk exposure harder
  to audit and reliably prevent;
- Linear has no equivalent broker today, so a raw credential would remain
  necessary or require a one-off side channel; and
- it does not provide the host's normalized issue context or a single place to
  enforce adapter-specific scope, error, and rate-limit contracts.

The phase-1 compatibility channel is therefore temporary and explicitly
tracked as a divergence, not an alternative architecture.

## Consequences

- Customer repository agents can use provider-native tracker operations without
  possessing the corresponding tracker token or a readable host GitHub login.
- Runtime-specific transports differ, but adapter contracts and host-side
  execution semantics remain the same.
- Host lifecycle code owns session capability generation, loopback server
  teardown, structured tool failures, and tool-call observability.
- Phase 1 temporarily removes agent access to provider-native MCP tools; #673
  restores that access through the host-owned transport.

## Upstream conformance and divergence

The target architecture conforms to the upstream tool, secret-handling, and
scope-narrowing requirements. `docs/symphony-spec.md` remains unchanged.

Until #673 ships, the current agent-started MCP subprocess model is an
intentional, documented repository-local divergence. #672 removes raw tracker
and broker values from coding-agent environments and `mcp.json`, isolates the
child home/configuration directory, replaces child-authenticated Git transport
with a host operation, and disables the agent-owned MCP path; it does not claim
that the subprocess arrangement is conformant. #673 is the conformance-closing
implementation.

## README security-posture draft for #675

The §15.1 posture text now lives in [README.md](../../README.md#security-posture)
so it has one authoritative copy. #675 owns final wording and placement
coordination.
