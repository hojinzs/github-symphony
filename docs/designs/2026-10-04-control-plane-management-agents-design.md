# Control Plane and environment management agents

- **Date:** 2026-10-04
- **Status:** Draft
- **Symphony Layers:** Configuration, Coordination, Integration, Observability; Execution at the host process lifecycle boundary
- **Scope:** Proposed architecture; this document does not describe shipped commands or APIs
- **Related documents:** [Standalone project boundary](../adr/2026-08-13_standalone-project-instance-boundary.md), [standalone project model](2026-08-11-standalone-project-model-design.md), [orchestrator extraction scope](2026-09-14-orchestrator-extraction-scope.md), [current control-plane package](../../packages/control-plane/README.md)

## Intent and agreed scope

One operator manages existing Symphony projects on multiple machines through
one Control Plane UI. Each machine runs an installed Management Agent that
manages its local orchestrator processes. A project retains one orchestrator
instance and its existing workflow, tracker, workspace, and coding-agent behavior.

The agreed first-release constraints are:

- Existing, locally prepared project folders only.
- Installed agents and native host processes; no Docker management.
- One human operator, no user login, deployment within a private network.
- Agent identity and authentication are required independently of user login.
- Later releases add user authentication and OIDC, followed by the ability to
  operate on a public network under an explicitly reviewed deployment profile.
- Later project provisioning connects repositories and trackers, defines
  `WORKFLOW.md`, and registers skills through the UI.

The proposal supports macOS and Linux first. Windows support, fleet size targets,
and public deployment are outside this release's acceptance criteria.

## Upstream conformance and layer boundaries

Upstream [Symphony](../symphony-spec.md) sections 2.2 and 3 exclude a rich,
multi-tenant control plane from their prescribed scope. This management plane
is an explicit repository-local extension outside the single-workflow service.
It does not redefine the upstream specification.

| Layer         | Proposed responsibility                                          | Preserved boundary                                                                       |
| ------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Policy        | No first-release changes                                         | The local workflow defines coding and issue-handling policy                              |
| Configuration | Agent project allowlist, environment identity, protocol settings | Existing workflow loading, validation, and secret indirection remain authoritative       |
| Coordination  | Remote process lifecycle commands and their delivery records     | Each orchestrator exclusively owns dispatch, claims, retries, and reconciliation         |
| Execution     | Starting and stopping the host orchestrator process              | Workspace hooks and coding-agent execution remain inside the current runtime             |
| Integration   | Authenticated agent transport and local lifecycle adapter        | Tracker adapters remain local; the Control Plane does not call trackers to dispatch work |
| Observability | Aggregate snapshots, run history, log viewing, command audit     | Aggregate state is a projection of local observations, never scheduler state             |

The management plane stores operational metadata persistently. This does not
introduce a database requirement into the upstream orchestrator. No changes to
`docs/symphony-spec.md` are proposed. Existing repository-local runtime/API
divergences remain separate from this design.

## Architecture and authority

```mermaid
flowchart TD
    UI[Browser UI] --> CP[Control Plane API and store]
    A[Management Agent: environment A] <-->|Outbound authenticated connection| CP
    B[Management Agent: environment B] <-->|Outbound authenticated connection| CP
    A --> A1[Project A1 orchestrator]
    A --> A2[Project A2 orchestrator]
    B --> B1[Project B1 orchestrator]
```

Management Agent means the host management daemon, not a coding agent.

| Component        | Owns                                                                                           | Does not own                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Control Plane    | Environment registry, observed inventory, command records, audit records, UI                   | Tracker polling, issue dispatch, local project files, tracker/runtime secrets |
| Management Agent | Allowed folder inventory, authenticated transport, local command journal, process observations | Workflow policy, issue retry decisions, automatic relocation                  |
| Orchestrator     | Its single project's execution and scheduler state                                             | Other projects or environments                                                |

Project folders are the source of configuration. The Control Plane caches
non-secret inventory and status. The agent resolves local filesystem locations
and process identities. Orchestrators continue running when the agent or
Control Plane stops; reconnection observes existing processes without launching
replacements. Host reboot or an orchestrator crash does not automatically restart
projects in this release. The operator starts them explicitly.

The installed agent runs as the same ordinary OS user as its projects, with an
explicit Symphony CLI location and configuration directory. One agent manages
that user/configuration context on a machine. Separate users require separate
environment registrations. Agent shutdown must not signal managed orchestrators.
OS service packaging may restart the agent itself without changing this rule.

## Connection approaches

| Approach                                         | Advantages                                                         | Trade-offs                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Agent-initiated HTTPS long polling — recommended | No inbound agent port; explicit, bounded request/response protocol | Requires durable delivery tracking and reconnect handling                    |
| Control Plane calls an inbound agent API         | Simple within a flat private network                               | Requires a reachable address and exposed listener for every environment      |
| SSH invokes the CLI                              | Small initial deployment footprint                                 | Mixes connection credentials, lifecycle commands, and continuous observation |

Use agent-initiated HTTPS long polling first. A reverse proxy may terminate TLS
for the Control Plane; agents validate its certificate, including a configured
private CA when needed. There is no generic reverse tunnel or remote shell.
WebSocket transport may replace long polling later without changing command
identity, completion, or observation semantics.

Proposed defaults: the agent posts observations every 5 seconds, and maintains
one command poll with a maximum 25-second wait. The Control Plane considers an
agent offline after 30 seconds without an authenticated heartbeat/observation.
These are management liveness intervals, independent of tracker polling.
An online agent may still have stale or unavailable project snapshots.

Reconnect uses exponential backoff with jitter, capped at 30 seconds. Only the
current inventory/status is resent after an outage; full snapshots are not
buffered indefinitely. Unacknowledged command results remain durable locally.

## Registration, identity, and project inventory

1. The operator creates a named environment in the UI.
2. The Control Plane generates a single-use enrollment token, valid for 10 minutes.
3. The installed agent exchanges it for an environment-scoped credential over HTTPS.
4. The agent stores its identity and credential in a local file readable only by
   its OS user. The Control Plane stores a verifier, not the raw bearer credential.
5. The operator configures an explicit local allowlist of project folders.
6. The agent reports those folders, their validation results, and current runtime observations.

Enrollment consumption is atomic. Credential revocation blocks subsequent agent
requests without stopping local orchestrators. Re-enrollment replaces the old
credential; it does not silently attach a new machine to old project identities.
Only one active agent session is allowed per environment. A new session replaces
an expired session; a second session while the first is live is rejected. Local
agent configuration also has a single-process lock. A session ID and monotonic
observation sequence prevent old responses from replacing newer observations.

Environment IDs are generated by the Control Plane. Local project IDs use the
current CLI's folder-derived ID function with the registered canonical path.
The global key is
`(environmentId, localProjectId)`, since two machines can use the same folder
path and therefore the same local ID. Run and issue IDs are also qualified by
that global project key in aggregate routes.

Agent registration validates canonical paths and resolves symlinks using the
CLI's existing realpath-based process lock boundary. The current ID function
itself uses absolute-path normalization, not realpath, so existing runtimes
started through an alias may have a different cached ID. The adapter must resolve
those aliases through the existing registry and process lock, retain that runtime
ID for status/stop, and expose one aggregate project for the canonical folder.
It must not assume that hashing the canonical path finds every existing runtime.
Aliases for one folder cannot create two managed projects. Each operation
rechecks the registered canonical folder;
retargeting a symlink requires explicit local re-registration. Folder moves
create a new local project identity; migration is deferred.

The allowlist includes projects that have never been started. Local runtime
registries supplement observations but do not define which folders are managed.
A missing or invalid `WORKFLOW.md` marks the project unstartable while retaining
status/history and the ability to stop a verified existing process. Invalid
projects remain visible with a diagnostic. Removing a folder from the allowlist
removes new remote control without stopping its process; the cached UI entry
becomes unmanaged and remains available as historical metadata. Unclaimed
commands are rejected after removal. Already claimed operations may finish and
must retain their result history; removal cannot undo an effect in progress.

Inventory includes display name, global/local IDs, folder, CLI/protocol versions,
workflow revision when available, normalized non-secret tracker scope, and
validation status. It excludes workflow prompt contents, `.env` contents, MCP
secrets, and credential values. Unsupported versions appear in the UI but cannot
receive lifecycle commands.

## Local lifecycle adapter

Reuse the existing `project start --project-dir <path> --daemon`, status readers,
and `project stop --project-dir <path>` semantics behind a typed adapter. Invoke
the configured executable with an argument array, never interpolated shell text.
Commands address registered project IDs; the Control Plane cannot supply an
arbitrary path, executable, environment override, or shell command.

First release exposes only `start` and `stop`. They mean ensure running and
ensure stopped at the time of completion, rather than continuously maintained
desired state. A start of a verified running project or stop of a verified stopped
project is successful without spawning or signaling anything. The agent serializes
lifecycle operations per project; different projects may operate concurrently.
Existing CLI locks also arbitrate with local CLI invocations.

Start retains current workflow validation and overlap checks and runs without
interactive input. Any required local remediation/confirmation fails with an
actionable diagnostic. The agent does not rewrite policy or resolve configuration
errors automatically. Start succeeds only after the orchestrator's readiness
signal and process ownership have been verified.

Stop uses the normal shutdown path, not force kill. The current CLI stop handler
sends `SIGTERM` and returns without waiting for exit; its output alone is not a
remote completion signal. The adapter waits for the verified target process to
exit and the project locks to release, and confirms that no replacement
orchestrator is running for the project. If that cannot be confirmed within 60
seconds, report an unresolved outcome and current observations. Do not
automatically escalate to `SIGKILL`. Stop can interrupt active coding work under
existing shutdown semantics; it is not a promise to drain all issues to completion.

The adapter must exclude management credentials from subprocess environments
while retaining the existing project/runtime credential resolution behavior.
PID files alone are insufficient evidence: use existing process identity and
lock checks, including PID reuse handling. No generic process killer is added.

## Command delivery and recovery

Control Plane lifecycle submissions have an idempotency key. The durable record
contains command ID, global project key, operation, actor, session target,
submission/expiry timestamps, lifecycle state, and an optional diagnostic.
Reusing the same key with a different operation or target is a conflict.

```text
accepted -> executing -> succeeded | failed
accepted -> expired
accepted | executing -> unknown -> succeeded | failed
```

The Control Plane rejects new commands for offline, unmanaged, invalid-version,
or already-busy targets. There is at most one outstanding lifecycle command per
project; a conflicting click does not form a hidden queue. Accepted commands
expire if execution has not begun within 30 seconds. The Control Plane deadline
is authoritative: after durably journaling receipt, the agent must claim the
command through the API before doing effects. Claiming after expiry fails.

On receipt the agent durably records the command ID, target, and operation before
claiming execution. Duplicate delivery returns the existing journal state.
Persisted execution ownership can be transferred to a reconnected session only
for the same enrolled agent and the same command ID. Old sessions cannot claim
new commands or publish observations.

Once claimed, disconnection does not revoke execution. Commands may finish
locally while the Control Plane is unreachable. The agent stores the result
before publishing it and resends it until acknowledged. A command with a missing
execution/result report becomes `unknown`, never falsely `failed` or `succeeded`.
The UI prevents a replacement lifecycle command until recovery resolves the
previous record. This also applies after a 60-second execution observation timeout.

Agent restart reconciles journal entries using process identity, readiness/lock
evidence, and the persisted stop target. A stop must never signal a replacement
process just because the original PID or project is reused. A confirmed
replacement makes the interrupted stop unsuccessful, with a superseded-target
diagnostic; it does not authorize another signal. If evidence cannot
resolve an interrupted operation, leave it `unknown`; the operator explicitly
closes it as unresolved before submitting a new command. That closure is audited.
Recovery does not promise exactly-once execution. Durable deduplication, local
locks, and verified outcome reconciliation bound duplicate effects.

Control Plane restart preserves command/audit records and cached observations.
It marks environments offline until they reconnect, reconciles existing command
IDs, and does not replay expired work or generate replacement commands.

## Status, history, and logs

The UI represents these independent dimensions:

- Environment connection: online/offline, last contact, agent version.
- Project process: running/stopped/unknown, observation time, process identity
  only when appropriate for the operator view.
- Project health: the existing orchestrator health, freshness, and diagnostics.
- Work: active runs, retrying runs, bounded run history and issue details.
- Command: accepted/executing/succeeded/failed/expired/unknown.

Do not infer stopped from a disconnected agent or a stale snapshot. Missing
runtime data produces unavailable/unknown with a reason. Control Plane receipt
times determine connection freshness; agent observation timestamps are displayed
but are not trusted to extend liveness across clock skew.

Reuse the current filesystem-backed status/dashboard readers for local snapshots
and run records. Do not require each orchestrator's HTTP port to be exposed or
each project to run its own browser UI. Preserve current snapshot fields inside a
versioned management envelope; aggregate identifiers live outside that snapshot.

Run history and logs are fetched on demand through agent read requests. Such
requests use a separate, bounded read lane and never acquire the lifecycle command
slot. While offline, the UI shows cached status/history with timestamps and marks
uncached details/logs unavailable. The Control Plane does not persist raw logs
in the first release. It may retain at most 100 observed run summaries per project.

Log requests select registered project ID, run ID, and a fixed stream enum, not
an arbitrary filename. The agent verifies path containment and reads only the
selected local orchestrator/worker/event log. Each response is limited to 256 KiB,
with a file-generation/byte-offset cursor. Rotation or truncation returns an
explicit cursor reset. UI follow mode requests further chunks while visible and
stops on disconnect; it does not continuously upload every environment's logs.
Files and log text are rendered as text, never executable HTML. Existing secret
redaction applies to metadata, but arbitrary worker logs can contain sensitive
text; raw log viewing is restricted to the trusted operator access boundary.

## Storage and proposed interfaces

Use one Control Plane process with a local SQLite store for environment identity,
project projections, credentials' verifiers, command records, and audit records.
The concrete SQLite driver is an implementation-plan choice. Store the agent's
command journal and enrollment identity durably in its user-owned data directory.
No shared filesystem between machines is required. Control Plane backups contain
metadata, not project configuration or a recoverable copy of remote workspaces.

Proposed protocol contracts, not shipped API routes:

| Contract                   | Caller  | Purpose                                                      |
| -------------------------- | ------- | ------------------------------------------------------------ |
| Enrollment exchange        | Agent   | Consume one-use token and obtain environment credential      |
| Session open               | Agent   | Negotiate protocol version and establish exclusive session   |
| Observation upload         | Agent   | Send inventory, heartbeat, process observations, snapshots   |
| Command/read poll          | Agent   | Receive pending lifecycle and bounded read requests          |
| Execution claim            | Agent   | Atomically claim a non-expired command before effects        |
| Result upload              | Agent   | Publish durable command results or bounded read responses    |
| Environment/project query  | Browser | Read cached aggregate state and freshness                    |
| Lifecycle submission/query | Browser | Submit idempotent start/stop and inspect outcome             |
| Detail/log query           | Browser | Request local history or log chunks through the online agent |

All agent messages carry protocol version, environment/session identity, and
message or command ID. The initial major version is 1; incompatible majors are
rejected explicitly. Inventory advertises supported operations. Incoming message
sizes and pending read requests have fixed limits; oversized data produces a
diagnostic rather than an unbounded backlog. Exact route names and CLI commands
will be specified in the implementation plan, before code is written.

## Private deployment and future authentication

First release has no human login. The private listener/firewall boundary is the
human access boundary, and anyone able to access it acts as the local operator.
Bind to loopback by default; a private interface must be selected explicitly.
The frontend uses same-origin API requests. Mutations require the configured
UI origin and a session CSRF token; permissive CORS is not enabled. Agent routes
always require their enrollment/session credential and never accept browser actor
identity in place of agent authentication.

Every browser operation passes through an actor resolver returning `local-owner`
in this release. Audit events record actor, target, operation, command ID, time,
and outcome. No role hierarchy or multi-tenant schema is introduced now.

Future authentication maps a local user record to OIDC `(issuer, subject)`;
email is display metadata, not identity. The actor resolver can then enforce
authenticated API sessions without changing lifecycle commands or agent credentials.
Public exposure requires that authenticated profile, TLS, session handling, and
authorization to be implemented and tested together. OIDC alone does not authorize
arbitrary users of the identity provider. Agent credentials remain independent.

## Multiple environments and tracker ownership

Each managed project belongs to one environment. Automatic migration, failover,
global issue scheduling, and cross-host workspace sharing are out of scope.
Different projects on different machines must have disjoint issue pickup scopes.
The current CLI's overlap checks and project locks are local and cannot enforce
this across machines.

Report normalized non-secret tracker scope through adapter-owned metadata. The
Control Plane warns about identical reported scopes without reproducing
provider-specific issue eligibility rules. Unknown overlap is shown as unverified.
The operator must configure disjoint scopes before starting projects across
environments. This release makes no global exactly-once dispatch guarantee;
local CLI use and offline orchestrators can bypass aggregate observations.
A later global lease/scheduler design would be a separate Coordination change.

## UI and first-release acceptance

The UI has an environment list, aggregate project list, project detail with active
and retrying work plus recent runs, a bounded log viewer, and command history.
Projects can be filtered by environment and status. Start/stop show pending and
verified outcomes, and are disabled when connection or unresolved command state
prevents safe submission. A stop confirmation describes interruption of active
work. There is no arbitrary terminal, workflow editor, force kill, automatic
restart, project provisioning, or issue-level retry/cancel control.

Acceptance: one operator registers two installed agents, registers multiple
prepared projects across them, observes existing locally started orchestrators,
starts/stops projects remotely, and views local run history/logs in one UI.
Disconnecting either management component does not stop project execution and
does not produce false command completion or false stopped status.

## Delivery slices and future extension

1. **Local management adapter:** allowlist, inventory, typed lifecycle operations,
   durable journal, process reconciliation. No remote transport dependency.
2. **Management protocol and service:** enrollment, sessions, aggregate store,
   observation transport, command claims/results, bounded read requests.
3. **Aggregate UI:** environments/projects, runtime details, commands and logs;
   reuse suitable current components behind the aggregate API.
4. **Authentication:** user sessions and OIDC, authorization and public deployment
   verification. This is a separate release boundary.
5. **Provisioning:** agent capabilities for creating project folders, connecting
   repository/tracker declarations, workflow validation and skill registration.
   Locally created and UI-created projects use the same lifecycle adapter.

These are architectural slices, not an approved implementation plan. Do not turn
the current per-project `--web` server into a fleet server implicitly. Separate
the aggregate service from that shipped surface; a shared protocol module and
management-agent module are proposed package boundaries whose names will be
chosen in the implementation plan. The orchestrator must not depend on the agent
or aggregate service. Provisioning must preserve hook-owned repository population
and must not revive removed repository-cache or orchestrator cloning behavior.

## Test cases and validation

These behavioral TCs are implementation acceptance requirements. They have not
been executed against a management plane, which does not yet exist.

| TC    | Scenario                                                              | Expected result                                                                   |
| ----- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| CP-01 | Two environments report the same folder/local project ID              | Separate aggregate projects and correctly scoped operations                       |
| CP-02 | Register canonical folder and symlink alias                           | One project; a retargeted alias cannot redirect commands                          |
| CP-03 | Register unstarted or invalid workflow folder                         | Visible inventory; invalid start rejected, verified stop remains possible         |
| CP-04 | Concurrent local CLI and remote start, duplicate command delivery     | Existing lock retained; no second orchestrator; one command result                |
| CP-05 | Agent or Control Plane disconnects during active work                 | Orchestrator continues; UI retains explicitly stale observations                  |
| CP-06 | Offline submission, expired acceptance, lost claim response           | No offline backlog; no effects without a valid claim; same command reconciled     |
| CP-07 | Command executes but result upload is lost; restart either side       | Durable result reconciled; no false failure or replacement command                |
| CP-08 | Stop returns before exit, PID reused, replacement process appears     | Completion waits for verified exit; replacement process is not signaled           |
| CP-09 | Restart after effects with insufficient recovery evidence             | Unknown outcome shown; explicit audited closure needed for another command        |
| CP-10 | Clock skew, out-of-order observations, second agent session           | Receipt-based freshness, older observations ignored, live second session rejected |
| CP-11 | Reuse enrollment token, wrong environment credential, revocation      | Authentication rejected; local orchestrators remain running                       |
| CP-12 | Missing logs, traversal, rotation, large log, offline detail request  | Containment and size enforced; explicit reset/unavailable, no false empty success |
| CP-13 | Start needs interactive confirmation or remediation                   | Non-interactive failure with diagnostic; no policy rewrite                        |
| CP-14 | Project removed from allowlist or folder moved                        | Remote control revoked; process unaffected; no silent identity migration          |
| CP-15 | Agent launches CLI, submits inventory and status                      | Management credentials absent from child environment and uploaded metadata        |
| CP-16 | Private browser mutation from a foreign origin                        | Mutation rejected; valid local-owner operation is audited                         |
| CP-17 | Incompatible protocol or unresolved cross-environment tracker overlap | Commands disabled for incompatible agent; overlap limitation visible              |

During implementation, cover journal recovery, session fencing, identity,
timeouts, and log containment with deterministic unit tests. Verify the two-agent
acceptance path with stub workers and network fault injection. Docker may be used
as the repository's isolated test harness, but is not a deployment/runtime feature.
Add actual E2E scenarios to `AGENT_TEST.md` when implementing them.

For this documentation change, check scope and layer headers, agreed constraints,
relative links, failure contracts, and upstream immutability. Run the mandatory
repository `pnpm test` gate and report its actual result separately from the
future management-plane acceptance tests. Shipped CLI, package structure, and
runtime behavior remain unchanged, so their living references are not rewritten
to describe this proposal as current behavior.

## Review decisions

The scope constraints are agreed. HTTPS long polling, SQLite, timing defaults,
bounded on-demand logs, explicit unresolved-command closure, and package
separation are proposed decisions for review. Approval of this design is required
before producing the implementation plan; implementation starts only after that
plan is reviewed.

## Documentation verification (2026-10-04)

- Four document checks passed: required metadata/no placeholders, relative link
  resolution, design index entry, and byte-for-byte upstream spec preservation.
- Markdown formatting and whitespace checks passed.
- After restoring lockfile-pinned dependencies and building workspace packages,
  `pnpm build` and `pnpm test` passed: 138 test files and 2,037 tests across 14
  package test summaries.
- The future CP-01 through CP-17 management-plane tests remain unexecuted; these
  results validate the document and existing repository, not an implemented fleet
  management feature. No runtime behavior or shipped package structure changed.
