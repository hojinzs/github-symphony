# Fleet Control Plane services

Internal repository extension for #1008 (C04, Epic #983), separate from the
per-project `@gh-symphony/control-plane` HTTP server. Requires Node.js 24 on
Linux/macOS. No fleet command or listener is installed by this package.

## Configuration and storage

`resolveFleetConfig({ dataDir, publicOrigin, bindAddress? })` validates an absolute
data directory and an HTTPS UI origin. The default bind address is `127.0.0.1`;
remote private-network binding requires an explicit address. The consuming
server owns TLS or a trusted HTTPS reverse proxy.

`openFleetStore(dataDir)` opens `fleet.sqlite`, enables foreign keys and a bounded
busy timeout, and transactionally applies versioned migrations. New directories
and the database have modes 0700 and 0600. Existing paths must be owned by the
service's Unix user with those modes; symlinks, hardlinked files and unsafe
sidecars are rejected. Use a realpath-resolved absolute path: every parent must be free of symlinks.
Resolve macOS `/var` or `/tmp` and symlinked Linux `/home` paths before choosing
the data directory. Do not store fleet state in
project folders or use a shared filesystem.

Close the store when the service stops. Back up after closing it or use a
SQLite-consistent snapshot; do not copy only an active database while ignoring
its journal. Backup metadata includes credential verifiers, never recoverable
remote workspaces.

## Enrollment and peer ownership

`createEnrollmentService(store, options)` implements the C01 environment creation,
list, regeneration, enrollment exchange and revocation method shapes. Environment
names are trimmed and limited to 256 UTF-8 bytes. Tokens and credentials use
256-bit random secrets; only SHA-256 verifiers are stored. Tokens expire after
ten minutes, including at the exact deadline. Exchange consumes a token, stores
the agent identity and writes its audit event in one immediate transaction.
The same request ID cannot recover or reuse a consumed token.

Pending records survive reopen without returning a token again. Regeneration
fences all previous tokens while preserving environment ID. An enrolled identity
must be explicitly revoked before replacement. Replacement creates a new agent
ID and clears old contact state; exchange alone remains awaiting first signal.

The required `invalidateManagementAccess(database, environmentId)` option is a
synchronous peer-owned database hook returning `undefined`. It must fence the
session owner's records and expire unclaimed commands on the supplied connection,
inside C04's revocation transaction. It may also fence projection identities
owned by that peer. It must not perform asynchronous work, commit separately,
call external services or stop orchestrators. A hook failure rolls back
credential deletion, environment state, audit and all peer writes together.
The implementation is required even when the peer has no records; this prevents
a consuming service from accidentally omitting its revocation contract.

`authenticate(identity)` rejects credentials for another environment/agent,
revoked credentials and malformed stored verifiers. The observation owner calls
`recordAuthenticatedSignal(identityWithSessionId, verifySession)` to change
connection state. That method rechecks the credential inside a transaction and
requires the supplied session-owner verifier to confirm the exclusive current
session. Zero projects are valid; enrollment is independent of project readiness.

Successful create/regenerate/revoke operations durably audit `local-owner`;
operator audit request IDs are NULL because these methods have no request identity.
Exchange audits the new agent identity and the supplied enrollment request ID. Audits contain no raw
tokens or credentials and commit with the mutation. These library methods are a
trusted server boundary: consuming browser routes must resolve their actor with
`createBrowserSecurity` before invoking them. No HTTP listener is provided here.

## Browser access boundary

`createBrowserSecurity(config, options?)` requires a canonical HTTPS origin.
`issueSession()` creates an ephemeral session and CSRF token. Its `__Host-` cookie
uses Secure, HttpOnly, SameSite=Strict and Path=/, without Domain. Mutating
POST/PUT/PATCH/DELETE requests require the exact configured Origin, exactly one
session cookie, and that session's CSRF token. Missing, duplicate, foreign,
expired or revoked values fail closed. GET/HEAD resolves the private listener's
local-owner read boundary; the consumer must keep that listener private.

Defaults are eight hours and 256 sessions. Typed options allow lifetimes from
one second through nineteen days and registry sizes from 1 through 10,000. Sessions
are bounded in memory and disappear on restart; SQLite enrollment survives.
At capacity, issuing a session evicts the oldest live session, whose next request
fails as unauthenticated. Repeated issuance by anyone with listener access can
invalidate the operator session; consumers should control or rate-limit issuance.
The consumer owns TLS, no-store responses, no permissive CORS and routing agent
credentials separately. Forwarded headers do not override Origin validation.

## Verification

`pnpm --filter @gh-symphony/fleet-control-plane test` exercises real SQLite files,
private modes and ownership, unsafe paths, reopen durability, migration rollback
and future-schema rejection. Enrollment tests use C01 schemas, independently
owned peer session/command fixture tables, audit fault injection and simultaneous
SQLite connections on worker threads running actual compiled sources. See the
[C04 implementation plan](../../docs/designs/2026-10-06-fleet-control-plane-c04-plan.md)
for the delivery boundary. Browser tests cover cookie attributes, exact origins,
CSRF/session binding, expiry, revocation and bounded capacity.

After `pnpm build`, run `node e2e/fleet-enrollment-e2e.mjs` and
`node e2e/fleet-enrollment-mutations.mjs` for real HTTPS/SQLite process-restart
checks and eight forbidden-condition probes. `./e2e/run-fleet-enrollment-e2e.sh`
runs both in Linux Docker. The independent HTTP/session/command fixture is test
infrastructure, not a shipped fleet server. These checks do not validate native
service isolation or management of actual orchestrator processes.

## C05 exclusive sessions and authenticated first signal

Migration 3 adds `agent_sessions` to the same SQLite connection, after C07's
lifecycle command migration 2. Existing version-2 databases upgrade without
changing command records; version-2 binaries reject a version-3 database. Construct
`createSessionService(store, enrollment, { receiveObservation, now? })` with the
same C04 store/enrollment connection. Session negotiation authenticates the
environment/agent credential, validates v1, and atomically rejects another live
session. A session expires after 30 seconds without observations; a replacement
gets a new opaque UUID and resets sequence. Host/version metadata is projected
through environment listing. Negotiation alone stays awaiting first signal
(or offline for previously connected environments).

`observe(identity, request)` calls C04's authenticated-signal transaction.
Current session ownership is required even for zero projects. Freshness and
expiry use server receipt time, never agent clocks. Increasing sequence invokes
the required synchronous `receiveObservation(database, request)` sibling projection
hook; duplicate/older sequences acknowledge contact without replacing inventory.
Projection failure or an asynchronous/non-undefined hook rolls back sequence,
session renewal and connection state together.

Call `authenticateSession` before poll/claim/result work. Poll does not renew
heartbeat freshness. Call `expire()` on the consuming fleet liveness tick and
`recoverAfterRestart()` once before serving requests after process restart;
persisted sessions are fenced. Previously observed environments become offline
until a new authenticated observation; environments that have never sent a signal
remain awaiting-signal through both expiry and restart. Enrollment/credentials
survive this recovery.

C04's revocation hook must compose `sessions.invalidate(database, environmentId)`
with the command/projection owners' invalidation on that same transaction.
Session invalidation makes no local process calls. TLS listener routing and the
atomic inventory/query projection remain sibling-owned. Tests use real C04
enrollment, migrations and SQLite plus an independent typed projection table.
A composition regression wires the actual session verifier into C07 claims and
ownership transfer, covering expired/replaced sessions and revoked credentials.

## Lifecycle command ledger (C07)

`createCommandService(store, { peers, now? })` implements trusted library APIs
for `submitCommand`, `getCommand`, `listCommands`, `closeUnresolved`, agent
`claim` and `publishResult`. HTTP routing remains consumer-owned; browser
mutations require local-owner resolution and CSRF checks before calling them.
Agent methods take an authenticated credential identity separately from the
validated C01 envelope.

`CommandPeers.resolveTarget(database, projectId)` synchronously reads the
peer-owned project/session projection on the supplied transaction connection.
It returns stable project/environment/local identities, enrolled agent/current
session and managed/online/valid/supported flags. Missing projects are rejected.
`verifyAgent(database, identity)` must check both the C04 enrollment credential
and the exclusive current session. Never implement it as an unconditional
success or only a session-ID comparison. Both hooks must be synchronous and
must not open a nested transaction or perform network work.

Actor/key deduplication happens before availability checks. A replay returns the
original acceptance receipt (command ID and `accepted`), even if the durable
command has since completed; `getCommand` supplies its current outcome.
Different project/operation reuse conflicts. Fresh submissions reject offline,
unmanaged, invalid, unsupported and revoked targets, outstanding project work
and more than four active/unresolved commands per environment.

Schema v2 enforces one outstanding command per project, including unresolved
unknown records. A first claim and the 30-second expiry race in one immediate
transaction. At the exact deadline, expiry commits before a claim conflict is
returned. Same-owner replay preserves original ownership and claim time; after
60 seconds without a result, executing becomes unknown. Accepted records only
expire, including removal or revocation. Terminal/unknown replay conveys no new
execution permission; agent-owned journal effect markers remain required.

`recover()` sweeps expired accepted and overdue executing records. The hosting
service must call it on startup and periodically, and mark its peer-owned
environments offline on restart. Reads/claims also check relevant deadlines.
`transferOwnership(identity, commandId)` accepts only the same enrolled agent's
current authenticated session. It preserves original claim time, fences the old
session and changes executing to unknown for reconciliation only. Terminal
results may transfer ownership for acknowledgment after a lost response.
It never invokes a local operation or promises exactly-once effects.

Agent results reconcile executing/unknown records and identical terminal replay
is acknowledged without rewriting evidence or first completion time. Agent
`observedAt` is evidence only and may precede the claim or be in the future due
to clock skew; terminal `completedAt` uses the Control Plane receipt time.
Results cannot conflict with a terminal outcome or rewrite an explicitly closed
unknown. Closure requires acknowledgment and a bounded nonempty reason;
it atomically audits local-owner/time/reason while preserving unknown state.
A fresh command gets a new identity and fresh target checks.

Call `invalidateEnvironment(database, environmentId)` inside C04's
`invalidateManagementAccess` callback on the same connection/transaction; it
expires unclaimed commands and writes audits with revocation. Combine it with
peer session invalidation. `invalidateProject(projectId)` expires unclaimed
removed-project work. Claimed work remains recoverable.

`prune()` applies the protocol default 90-day retention to completed, expired
or explicitly closed unknown records. A late reconciled result is retained for
at least 90 days after its receipt audit, even when its observation is older.
Unresolved command records and their
audits remain fenced and retained. History is newest-first with bounded pages
and project-bound command-ID cursors. Pruned cursors are rejected explicitly.
No new fleet listener or CLI command is shipped by this library slice.

The [C07 implementation plan](../../docs/designs/2026-10-09-control-plane-c07-plan.md)
records the package boundaries. After `pnpm build`, run
`node e2e/fleet-commands-e2e.mjs` and
`node e2e/fleet-commands-mutations.mjs`, or
`./e2e/run-fleet-commands-e2e.sh` for isolated Linux Docker.
[TC-29](../../e2e/scenarios/29-fleet-command-recovery.md) distinguishes
ledger/journal-fixture integration evidence from native OS lifecycle validation.

## C06 cached observations and atomic inventory

`createObservationService(store, { invalidateProject, now? })` owns migration 4:
server-issued UUIDs uniquely bind `(environmentId, localProjectId)`, completed
inventory membership, bounded in-flight page identity sets, and latest project
observations. Wire identities must be allocated with `identifyProjects` by trusted
authenticated composition before upload. Production identity negotiation and HTTP
route assembly remain typed consumer boundaries; this library does not expose an
unauthenticated allocation route.

Pass `receiveObservation` directly to the C05 session service on the same store.
The callback requires an active shared transaction; sequence, authenticated
receipt and projection commit or roll back together. Page zero begins a revision;
remaining page indexes may arrive in any order. Page count, identities, duplicate
pages and the 100-project aggregate limit are validated across pages. Only a
complete revision changes managed membership. Existing project status can advance
before completion; newly discovered projects appear after completion. Removed
projects retain last-known data marked unmanaged. The required synchronous
`invalidateProject(database, projectId)` peer expires unclaimed lifecycle commands
on removal or reported folder loss without stopping any process.

`listProjects` defaults to 25 rows (maximum 100) and uses project UUID keyset
paging, with cursors scoped to environment/process/connection filters. Invalid
cursors and filter changes return `cursor_reset`; invalid limits are rejected.
`getProject` adds receipt freshness, snapshot staleness and advisory scope
warnings to the protocol aggregate shape. `summary` counts only managed, fresh
running observations; offline/removed historical running processes are excluded.
Queries compute timeout freshness even before session-expiry maintenance runs.
Restart recovery belongs to C05 and preserves cached project state as stale.

Missing snapshots retain the last successful snapshot and its original timestamp,
with an explicit stale diagnostic. Missing snapshots and empty run summaries never
imply a stopped process. Normalized reported tracker metadata compares adapter,
binding and repository plus sorted/deduplicated state and label sets across
environments. Missing, stale or failed scope observations produce `unverified`
warnings, as do differing state/label filters on the same adapter/binding/repository.
Different adapter, binding or repository identities produce no warning; identical
known scopes produce `identical` warnings. This does not
reimplement provider eligibility, prevent starts, or provide global scheduling.

`observations.test.ts` composes real C04 enrollment/C05 sessions with SQLite and
typed independent project observations for CP-01/03/05/10/14/17/21. The management
plane remains a repository-local extension; `docs/symphony-spec.md` is unchanged.

The query projection fields are validated by the additive v1 aggregate protocol
schema. An identical known pair and unverified comparisons can coexist. Related
UUID lists are bounded to 100 per warning; they are examples of reported matches,
not an exhaustive global ownership guarantee. Absence of a warning does not
establish disjoint eligibility. Queries normalize scopes once, index identity and
filter groups, and cache each environment lookup per projection. Comparisons use
linear counts with bounded related-UUID lists rather than all-project pair scans. Cached run summaries retain local times/statuses
and sort newest first. Default query pages include retained unmanaged history;
`summary` counts only current managed projects.

Wire the required invalidation peer as
`(database, id) => commands.invalidateProject(id, database)`; C07 accepts the
shared active transaction without nesting `BEGIN`. A peer failure rolls back
command expiry, projection writes, authenticated sequence and contact together.
Use `resolveTarget` as the C07 project peer on that same database.

[TC-31](../../e2e/scenarios/31-fleet-observations.md) exercises real C04/C05/C06/C07
composition, TLS transport and the bundled publisher. Production route/UI
composition and native OS service acceptance are not supplied by these fixtures.

Retained revoked projects return `access_revoked` for new command submissions.
Enrollment and offline preconditions are checked before active-session UUIDs,
since revocation intentionally deletes the session without deleting observations.

Project UUIDs are scoped to environment, enrolled agent ID and canonical local
project ID. Replacement enrollment creates new project identities; prior
generation observations remain historical, unmanaged and stale, even during a
partial replacement revision. Same-agent reconnects retain their UUIDs. Migration
5 retains v4 history with an unknown generation and fences it until the current
agent publishes newly allocated identities; it never infers ownership from a
replacement credential.

Identity allocation permits at most 100 outstanding unpublished mappings per
environment across calls. Existing mappings and intentionally published history
remain available at capacity. Overflow rolls back the entire allocation batch;
completed publication releases pending capacity. Abandoned unpublished mappings
from retired generations are reclaimed during allocation.

## Bounded read lane (C10)

`createReadService(store, { peers, now?, maximumEntries? })` exposes `submitRead`
and `getRead` plus agent `poll` and `publishResult`. Supply the same authenticated
project/session peers as the command ledger. Reads never acquire a lifecycle
command slot. Admission requires a managed, valid, supported online target;
four pending reads per agent and one per project are allowed. Requests expire
at 30 seconds using server time. Terminal results remain in memory for 60 seconds,
including logs; they never enter SQLite. The result registry defaults to 1024
entries (configurable from 1 to 10000); full registries reject new reads with
`read_busy` rather than evicting a result before its retention ends.

Poll and result publication require the current enrolled session. Results must
match the selected kind/run/stream and requested UTF-8 byte limit. Completion
uses receipt time, and identical completed replay preserves that first receipt.
Disconnection, removal or session replacement makes pending work unavailable.
Expired reads stay expired despite late results. Call `recover()` when restarting
an in-process service; a newly constructed service has no retained results and
unknown IDs explicitly return unavailable. Already completed content retains
its completion timestamp when disconnected; consuming views must display it
as historical and pause follow. Local C09 adapters own file containment, rotation,
truncation and cursor generation; the fleet service preserves reset diagnostics.

`createReadRoutes(reads, browserSecurity)` supplies an HTTP-framework-independent
request dispatcher for `POST /api/v1/projects/:id/reads` (202) and
`GET /api/v1/reads/:id` (200). Mount it only behind the fleet private listener.
POST resolves the actual local-owner CSRF session before parsing/admission.
Errors use the v1 `{ error: { code, message, requestId } }` shape; unmatched routes
return undefined for the owning server to dispatch. The listener must enforce
its existing JSON body limit before invoking this dispatcher. Agent poll/results
remain service composition boundaries shared with lifecycle commands.

`getReadView(id)` returns the v1 result plus a historical flag based on the
current project/session/connection projection. The detail dispatcher preserves
the v1 JSON result and supplies `X-Symphony-Historical: true|false` and
`Cache-Control: no-store`; mounting listeners must forward those headers.
Completed results keep their first receipt timestamp. Non-log payload JSON is
limited to 256 KiB before retention. Serialized log payloads, including cursors,
are limited to 256 KiB plus 1 KiB of metadata overhead, in addition to the
request-specific UTF-8 text limit. Read submission receipts contain only `readId`;
completed JSON replays ignore object key order while preserving array order.

Optional `receiveRunSummaries(database, projectId, runs, receivedAt)` hands
validated completed summaries to C06 on the shared transaction connection,
newest first and capped at 100. The projection owner must merge/prune its cached
history to at most 100 per project, retain it offline and after restart, and
label it using receipt/observation times. The hook must synchronously return
undefined; failure rolls back its writes and leaves the read pending for retry.
Identical completed replay does not invoke it twice. C10 never sends log text
or arbitrary run detail to this persistence hook. Production observation/project
projection remains C06-owned; independent SQLite fixture tables exercise this
boundary while that sibling is unavailable.

[TC-31](../../e2e/scenarios/31-fleet-bounded-reads.md) describes the built-service
HTTPS/C04/C05/C09 contract and nineteen forbidden-condition probes. Run
`node e2e/fleet-reads-e2e.mjs` and `node e2e/fleet-reads-mutations.mjs` after
`pnpm build`, or `./e2e/run-fleet-reads-e2e.sh` for Linux Docker.

## Project presentation boundary (C16)

`src/project-presentation.ts` maps C06 `ObservedProject` values to fleet/detail
widget data. Connection, process, health, agent observation time and receipt time
stay separate. Historical process and snapshot values remain available with
explicit historical flags; missing work counts remain unknown.
`summarizeProjects` requires the complete workspace inventory and labels its
scope; never pass a filtered page. Running totals require fresh managed process
observations, while active-work totals also require a fresh snapshot.

Start/Stop disabled reasons are presentation guidance only. Invalid workflow
blocks Start while a verified running process can remain eligible for Stop;
offline, stale, unmanaged and incompatible targets carry adjacent reasons.
C17 owns command authorization and dispatch. Scope overlap stays advisory.
These internal helpers do not install a fleet listener or alter per-project web
behavior.

`createProjectRoutes(observations, { environments, links?, now? })` returns a
read-only request dispatcher for `GET /projects`, `GET /projects/:projectId`
and allowlisted `/fleet-assets/*`. The consuming **private fleet HTTPS listener**
passes the request pathname plus query and sends the returned status, headers
and body. The dispatcher does not bind a port. Assets ship in this package's
`assets/` directory; preserve that directory next to `dist/`.

The fleet form supports search, environment/state filters, and Previous/Next
pagination. Filters reset the page, counts refer to all matching rows, and the
fresh-only summary explicitly remains workspace-wide. Running/Stopped/Unknown process filters require fresh, online, managed
observations. The stale filter and Offline / stale metric share one predicate:
offline, stale observation/snapshot, or unmanaged. That metric covers all inventory,
including unmanaged projects; running/work totals cover managed projects. Pages are snapshots at request time; refresh
to fetch new observations. Native HTML forms and links work without JavaScript;
the small local script adds a loading announcement during form navigation.

`links` is the typed C17/C18/#1019 composition boundary: optional local-only
environment, lifecycle, runs and commands destinations. Lifecycle links navigate
to confirmation flows; they must never perform mutations on GET. Without a
destination, an otherwise eligible action explains that it is not connected.
Invalid workflow never independently disables eligible Stop. Command results
and run/log history are sibling-owned and are not fabricated in this view.
Only local asset, stylesheet and script sources are permitted by page CSP;
names, paths, diagnostics, filters and URLs are HTML escaped.

Verification: `node e2e/fleet-projects-e2e.mjs` and
`node e2e/fleet-projects-mutations.mjs` after building, or
`./e2e/run-fleet-projects-e2e.sh` for Linux Docker. These exercise actual
enrollment, session, inventory and route services; the loopback HTTP fixture
does not claim native lifecycle or production HTTPS deployment validation.

### Lifecycle presentation compositions (C17)

`src/command-pages.ts` contains typed command history, CommandProgress,
RecoveryPanel and start/stop/unresolved-closure confirmation compositions.
They consume protocol `CommandRecord` values separately from C16 project
observations: accepted/executing never changes process state, superseded targets
do not imply replacement-process termination, and audited closure preserves
unknown with actor/time/reason. Unresolved recovery offers no replay control.
`CommandContext.disabledReasons` carries service-owned admission reasons in
addition to observation eligibility. Forms describe intent only; the consuming
private fleet route must authenticate CSRF, validate input and recheck command
admission. These compositions do not install routes or change the per-project
web server. Graphite responsive styles cover desktop, tablet and phone widths.
