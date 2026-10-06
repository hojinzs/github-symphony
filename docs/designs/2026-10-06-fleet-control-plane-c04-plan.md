# C04: Fleet configuration, storage and enrollment implementation plan

**Status:** Implemented, pending review (#1008; PR #1031; Epic #983)
**Symphony Layers:** Configuration, Integration, Observability

## Scope and conformance

This slice implements the persistence and access boundary from the
[approved management design](2026-10-04-control-plane-management-agents-design.md),
using the merged C01 contracts in `@gh-symphony/management-protocol`.
It is an explicit repository extension to the upstream Symphony specification,
not a change to its scheduling, workflow loading or tracker model.
The upstream specification remains unchanged. Existing per-project
`packages/control-plane`, `project` commands and `--web` behavior retain their
separate ownership.

C04 exports composable services for subsequent fleet server and CLI consumers.
It does not implement agent services, session negotiation, command scheduling,
aggregate projections, browser UI or CLI installation. Revocation exposes a
transactional integration hook for the command/session owner rather than
inventing that owner's schema.

## Files and interfaces

| File under `packages/fleet-control-plane/` | Responsibility                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `src/config.ts`                            | Validate typed data-directory, bind address and HTTPS public-origin settings; loopback bind default          |
| `src/persistence.ts`                       | Create/check user-owned directory and SQLite file; reject symlinks, foreign ownership and unsafe permissions |
| `src/migrations.ts`                        | Ordered versioned SQLite migrations, transactional application and rejection of newer schemas                |
| `src/store.ts`                             | Database lifecycle, environment queries and transaction helpers                                              |
| `src/enrollment.ts`                        | Create/regenerate/exchange/revoke with protocol request/response types                                       |
| `src/browser-security.ts`                  | Origin and session CSRF verification, local-owner actor resolution                                           |
| `src/index.ts`                             | Narrow public exports for fleet consumers                                                                    |
| `src/*.test.ts`                            | Real temporary SQLite files, independent protocol fixtures and security checks                               |
| `README.md`                                | Service contracts, ownership, security and backup guidance                                                   |

Use Node 24's built-in `node:sqlite` driver, avoiding native addon installation.
Synchronous short transactions are acceptable for the single-process local
control plane. SQL statements use bound parameters. Store connections use
foreign keys and a bounded busy timeout. Schema versions are advanced only in
the same transaction as their migration; a failed migration rolls back.

Expose a storage service whose enrollment operations implement the C01 shapes:
`createEnvironment(CreateEnvironmentRequest)`,
`listEnvironments()`, `regenerateEnrollment(environmentId)`,
`enroll(EnrollmentRequest)`, and `revoke(environmentId)`.
Authentication verifies both environment and agent identity against a credential
verifier. Clock and entropy inputs may be injected for expiry tests, while tests
still operate on a real database. A first-signal integration method is distinct
from token exchange; exchange never asserts online state.

## Durable identity and lifecycle

Initial tables hold schema version, environments, enrollment token verifiers,
agent credential verifiers and audit records. Environment identity survives
expiry, regeneration, restart and revocation. Raw tokens and credentials are
returned once and never persisted or included in audit records.

Generate cryptographically random secrets; persist SHA-256 verifiers. Enrollment
tokens expire after ten minutes. Exchange uses an immediate transaction to
check expiry, consume exactly one token, persist new agent identity/credential
and update the environment atomically. Competing connections cannot both
succeed; retries with a consumed token fail even with the same request ID.

Regeneration fences any earlier token without changing environment identity.
It rejects an enrolled live identity until explicit revocation. Revocation
invalidates both pending tokens and enrolled credentials, marks management
disconnected, and invokes the future session/command invalidator inside the
same transaction. Failure of that hook rolls back revocation. The hook must
only perform database work on the provided transaction, never network or
process effects. It must eventually expire unclaimed commands and fence sessions.
No orchestrator is stopped by revocation.

New environments are pending and awaiting signal. Successful exchange sets
enrolled and awaiting signal. First authenticated observation transitions to
online through the observation owner's boundary; absence of inventory is not
enrollment failure. Revoked identities cannot restore online state.

## Private browser and persistence boundary

Require a canonical HTTPS origin, without userinfo, query, fragment or a
non-root path. A reverse proxy may terminate HTTPS; the service validates the
configured origin rather than trusting forwarded headers. Bind to loopback
unless explicitly configured otherwise. The eventual HTTP server must provide
the configured HTTPS endpoint or sit behind that trusted proxy.

Browser mutations require an exact configured Origin and a random,
session-bound CSRF token. Compare tokens safely; reject absent, malformed,
foreign-origin and mismatched-session requests. Return the `local-owner` actor
only after verification. Do not enable permissive CORS. Browser actor identity
never substitutes for agent credentials. Session cookie issuance/routing belongs
to the consuming server, with Secure, HttpOnly and SameSite attributes.

Store state outside prepared project folders, in an explicitly resolved
user-owned directory, with directory mode 0700 and database mode 0600.
Check existing paths before opening; reject unsafe paths rather than silently
taking ownership or broadening access. SQLite sidecar files must remain inside
the protected directory. Backups contain management metadata and verifiers,
not remote workspace contents. Back up using SQLite-consistent snapshots or
after closing the service; filesystem copying an active WAL database alone
is insufficient.

Audit durable successful browser operations with actor, target, operation,
request/command identity where available, time and outcome, in the mutation's
transaction. Rejected security checks must not leak secrets in diagnostics.

## Verification and acceptance mapping

| Requirement                                 | Executable evidence planned                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| CP-11 token reuse/wrong identity/revocation | Real SQLite exchange, concurrent connections, credential cross-environment rejection, revocation invalidation and rollback          |
| CP-16 origin/CSRF and audit                 | Independent browser session fixtures; foreign/missing origins and tokens fail; valid local-owner mutation persists audit            |
| CP-20 pending modal lifecycle               | Reopen store, list pending record without raw token, expire/regenerate, reject old token, exchange remains awaiting signal          |
| Storage recovery                            | Reopen migration idempotence, failed migration rollback, newer-schema rejection, unsafe ownership/mode/symlink refusal              |
| Dependency boundaries                       | C01 typed fixtures validated by protocol schemas against actual enrollment output; transactional invalidation fixture owned by peer |
| Black-box boundary                          | External process opens the built package against temporary user data and exercises enrollment/security/restart without mocks        |

Each new test must go red when its guarded behavior is removed. Record mutations
and outcomes in the issue workpad. Run package tests and the repository
`pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm build` gates.
Run applicable Docker black-box verification under `AGENT_TEST.md`; a preflight
69 prerequisite limitation is recorded separately from actual scenario evidence.
Report macOS host evidence and Linux/container evidence independently; this
slice cannot claim native-service stop/restart isolation from storage tests.

Update the configuration and architecture living documents when the package
lands, plus package usage, root/CLI documentation where relevant and the
`AGENT_TEST.md` scenario table. Add a patch changeset for
`@gh-symphony/cli` referencing #1008 before review handoff.
