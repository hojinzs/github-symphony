# C07 lifecycle command ledger implementation plan

**Status:** Implemented — verification in TC-29; awaiting review
**Symphony Layers:** Coordination, Integration, Observability
**Delivery:** #1011, child of Epic #983; prerequisite C04 #1008 / merged #1031

## Ownership

This is the repository-local fleet management extension approved in the
[management design](2026-10-04-control-plane-management-agents-design.md).
It leaves upstream Symphony unchanged. Coordination covers only management
commands; orchestrator dispatch and tracker policy remain with their existing
owners.

## Internal files and interfaces

- `packages/fleet-control-plane/src/migrations.ts`: additive C04 migration for
  lifecycle records, actor/key deduplication and a partial unique project fence.
- `src/commands.ts`: trusted library API implementing operator submission,
  query, history and unknown closure, plus authenticated agent claims/results.
  Transactions use the existing `FleetStore` connection and `BEGIN IMMEDIATE`.
- Typed synchronous peer hooks on that connection resolve managed project
  identity, readiness/version, enrolled agent and exclusive current session.
  C07 does not implement inventory, session negotiation or an HTTP listener.
- Explicit recovery methods expire accepted records, mark overdue executing
  records unknown, transfer same-agent ownership for reconciliation only,
  invalidate unclaimed commands on revocation/removal, and prune eligible
  terminal/closed records and audits after the default 90 days.
- `src/commands.test.ts` and `test-fixtures/`: independent peer-owned SQLite
  session/project fixture contracts, file reopen, contention and rollback cases.
- `e2e/fleet-commands-*.mjs` and Docker runner: black-box service fixture against
  compiled library with lost-response, restart and forbidden-condition probes.
  This does not claim native Linux/macOS process lifecycle validation.

## Required semantics

Submission checks idempotency before target availability, rejects conflicting
reuse and never builds an offline backlog. A first claim races the 30-second
expiry transaction; same-owner replay preserves original claim time. A stale
session or foreign agent is rejected. Unknown/terminal replay never permits new
effects. Execution timeout is 60 seconds from the original claim. The agent's
durable effect marker and actual process checks belong to agent/adapter slices;
C07 must not claim exactly-once effects.

Explicit repository-local divergence from the approved management design:
transfer immediately converts executing → unknown while preserving the original
claim time. It grants reconciliation only, and late results still reconcile.

Terminal results reconcile unknown commands without replacement IDs and are
idempotently acknowledged. Agent `observedAt` never controls acceptance or
completion time; terminal completion uses the first Control Plane receipt time.
Unknown closure requires explicit acknowledgment
and a nonempty reason, is audited atomically, and preserves unknown state.
Open unresolved records cannot be pruned or bypassed. Closed records retain
actor/time/reason and use fresh IDs for subsequent commands.

## Verification and documentation

Exercise CP-06/07/09/18/19, offline/unmanaged/invalid targets, capacity, paging,
result conflicts, peer-hook failures and retention. Write mutation evidence for
each new/changed test. Run the full Completion Bar and Docker black-box checks.
Update package README, architecture/configuration references and E2E scenario
table as behavior lands. Add the required CLI patch changeset before handoff.
