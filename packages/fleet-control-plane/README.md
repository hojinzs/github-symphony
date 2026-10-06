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
sidecars are rejected. Paths must use canonical parents (for example resolve
macOS `/var` before using a temporary directory). Do not store fleet state in
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
exchange audits the new agent identity and request ID. Audits contain no raw
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
one second through seven days and registry sizes from 1 through 10,000. Sessions
are bounded in memory and disappear on restart; SQLite enrollment survives.
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
