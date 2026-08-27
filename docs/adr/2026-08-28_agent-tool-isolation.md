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

### Phase 1 — remove tracker secrets from the child boundary (#672)

Every tracker adapter will declare `secretEnvironmentNames()`. Local and
remote launchers will remove those names from coding-agent child environments;
the Codex and Claude runtime paths must not add them back. Generated Claude
`mcp.json` must contain no literal tracker credential.

This phase is deliberately a security-boundary prerequisite, not completion of
host-side execution. Where a legacy MCP subprocess still needs a credential to
function, the host supplies it over a non-environment, non-workspace channel
such as inherited stdin or a file descriptor. That short-lived compatibility
path remains a documented divergence until phase 2, because the agent still
initiates the MCP subprocess rather than receiving host-executed tool results.

### Phase 2 — execute tools at the host boundary (#673)

The worker executes the selected adapter's tool implementation with its
configured adapter credential and a normalized, internal tool context:

```ts
{
  issue: {
    (id, identifier, nativeRef);
  }
}
```

`nativeRef` remains opaque to the scheduler and is used only by the adapter to
narrow provider scope. Tool names, input schemas, mutation capability, scope
constraints, result/error shape, and rate-limit behavior are published per
adapter. A session snapshots the selected adapter's tool specifications at
startup, so a configuration reload cannot change an in-flight session.

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

- it leaves a §10.5/§15.3 MUST violation even if `mcp.json` no longer contains
  a literal secret;
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
  possessing the corresponding tracker token.
- Runtime-specific transports differ, but adapter contracts and host-side
  execution semantics remain the same.
- Host lifecycle code owns session capability generation, loopback server
  teardown, structured tool failures, and tool-call observability.
- Existing MCP subprocess behavior remains only for the bounded phase-1 bridge
  and must be removed by #673.

## Upstream conformance and divergence

The target architecture conforms to the upstream tool, secret-handling, and
scope-narrowing requirements. `docs/symphony-spec.md` remains unchanged.

Until #673 ships, the current agent-started MCP subprocess model is an
intentional, documented repository-local divergence. #672 reduces exposure by
removing raw tracker values from coding-agent environments and `mcp.json`, but
does not claim that the subprocess arrangement itself is conformant. #673 is
the conformance-closing implementation.

## README security-posture draft for #675

The following text is the proposed README section required by §15.1; #675 owns
final wording and placement coordination:

> ### Security posture
>
> GitHub Symphony treats the coding-agent runtime and its workspace as a
> separate trust boundary. Tracker credentials are held by the Symphony host or
> a host-side credential broker; agents receive tool schemas and results, not
> raw tracker tokens. Provider-native tools are scoped to the selected adapter
> and the current normalized issue. Deployments should still use least-privilege
> credentials, dedicated workspace permissions, loopback-only local services,
> and the runtime approval/sandbox policy appropriate for their environment.
>
> The host-side tool transport is being introduced in phases. The current
> MCP-subprocess implementation is a documented divergence and is not suitable
> for untrusted agents until phase 1 removes raw tracker values from
> coding-agent environments and workspace configuration. Operators should track
> the remaining divergence in this ADR until the host-side transport is
> deployed.
