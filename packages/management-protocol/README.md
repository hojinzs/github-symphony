# Management protocol

Private, dependency-free v1 wire contracts for the repository-local management
extension approved in [the design](../../docs/designs/2026-10-04-control-plane-management-agents-design.md).
This Configuration/Integration package provides transport types, runtime schemas,
stable diagnostics and capacity constants to the future management agent and fleet
service. It has no tracker, scheduler, HTTP, filesystem or database dependencies.
The existing per-project control plane keeps its own package and behavior.

## Public boundary

Import from `@gh-symphony/management-protocol`. `AgentControlPlaneClient` covers
agent enrollment, session opening, observations, polling, claims and result
acknowledgment. `OperatorManagementClient` covers environments, aggregate projects,
commands, explicit unresolved closure and bounded reads. These interfaces are
consumer contracts; C01 does not provide a running client/server implementation.
The wire version is `PROTOCOL_VERSION` (1), independent of CLI/package versions.

Every wire type has an exported `*Schema` with `parse(unknown)` returning its typed
value or throwing `ProtocolValidationError`. `pageSchema(itemSchema)` validates
paged collections. `parseObservationBody(text)` also bounds the original UTF-8
HTTP body (including whitespace) and normalizes malformed JSON errors. Parsing
does not coerce values, infer defaults, strip unknown fields or include rejected values in diagnostics. Error envelopes follow
`{ error: { code, message, requestId } }`; service consumers translate validation
failures to `invalid_input` and version negotiation failures to `unsupported_protocol`.
`ERROR_HTTP_STATUS` pins the common HTTP categories. The additional v1 diagnostic
names (`read_busy`, `invalid_input`, `unauthenticated`, `access_revoked`,
`not_found`, `session_conflict`) make the approved busy/input/auth/session categories
explicit; the approved stable error names remain available.

```ts
import { observationRequestSchema } from "@gh-symphony/management-protocol";

const observation = observationRequestSchema.parse(JSON.parse(body));
// At the HTTP boundary, use parseObservationBody(body) for the raw-byte limit.
// The service must now authenticate the environment/session, compare sequence
// and commit inventory pages before using this structurally valid observation.
```

Global environment/session/project/request/command IDs are opaque UUIDs.
Local folder-derived project IDs and local run IDs remain strings. Aggregate
project identity stays outside the redacted local snapshot. Timestamps are UTC
RFC3339; observation sequences are non-negative safe integers.

`LIMITS` uses milliseconds and UTF-8 bytes. Observations are limited to 4 MiB,
100 projects per page and a maximum of 100 pages in a revision. Log text is limited
to 256 KiB, run summaries to 100, polls to four commands and four reads, and pages
to 100 rows (consumer default 25). Wire JSON nesting is limited to 64 levels to
bound recursive validation. The page-count and nesting bounds are C01-local
representation choices, not changes to the upstream Symphony specification.
Neither encoded body size nor a page-local count establishes that an entire
multi-page revision is within the 100-project per-agent limit.

The command schema requires durable claim ownership and time for executing,
unknown and completed states; accepted/expired states have no claim. Only unknown
records can carry audited unresolved closure. Replayed claims retain command
identity, ownership and original claim time. Parsing a replay does not authorize
another effect. Read results preserve explicit expired/unavailable states and
log generation reset; a missing payload is never an empty completed read.

## Consumer responsibilities

Schemas validate individual messages. Service/agent slices still own:

- Authentication, revocation, CSRF/actor resolution, idempotency keys, exclusive
  sessions and server receipt time. Enrollment alone is awaiting first signal;
  online requires an enrolled agent and authenticated contact.
- Sequence monotonicity across messages, inventory-page completeness and combined
  100-project capacity, UUID-to-environment/local-ID mapping, snapshot redaction,
  run ordering and connection freshness. Partial pages cannot delete unseen projects.
- Atomic claim/expiry races, original claim/result persistence, session transfer,
  journal effect markers, replay deduplication and retention. Unresolved records
  cannot be pruned to unlock a project. Admission limits count outstanding work
  across requests; bounded poll arrays are not a concurrency limiter.
- Canonical path/symlink verification, allowlist membership, verified process
  identities and stop targets. Wire validation cannot establish filesystem safety.
- Registered run lookup, log containment, cursor generation/offset interpretation,
  request/result correlation and UTF-8 response size relative to the selected
  read's `maxBytes`. Cursors are opaque and read requests accept no filesystem path.

## Verification and acceptance scope

Run `pnpm --filter @gh-symphony/management-protocol test` and
`pnpm --filter @gh-symphony/management-protocol typecheck`. Independent literal
peer fixtures in `test-fixtures/v1.ts` are checked with `satisfies` against the
interfaces and round-tripped through JSON by the contract tests. The typed client
fixture exercises both sides' serialized messages; it does not simulate a live
HTTP service, persistent store or operating system.

| Approved cases                                | C01 executable evidence                                                                                     | Remaining runtime ownership                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| CP-01, CP-03, CP-05, CP-14                    | Qualified aggregate/local IDs; invalid project/stale snapshot diagnostics; process separate from connection | Mapping uniqueness, registration, allowlist removal and actual stale UI behavior           |
| CP-06–CP-09, CP-18–CP-19                      | Claim/state invariants; replay ownership/time; terminal evidence; unknown closure; fences and diagnostics   | Store transactions, durable journal, process control and recovery                          |
| CP-10, CP-17                                  | UTC/safe sequences; v1 rejection; session-qualified poll targets                                            | Receipt-time freshness, sequence comparisons, live session arbitration and tracker overlap |
| CP-11, CP-20–CP-21                            | Enrollment/session types; enrolled awaiting signal; online contact required; empty inventory allowed        | Token consumption/regeneration, credential checks and first authenticated signal           |
| CP-12                                         | Known-stream selector; extra path rejection; UTF-8 limits; reset/expired/unavailable results                | Filesystem containment, rotation, offline admission and live log reads                     |
| CP-02, CP-04, CP-13, CP-15–CP-16, CP-22–CP-23 | Stable identity/diagnostic/type boundaries only                                                             | OS/symlink/process isolation, noninteractive CLI, redaction and CSRF/service setup         |

Operator walkthroughs 1–7 and 9 have corresponding wire-state fixtures above;
UI interaction/accessibility (walkthrough 8), real commands and native service
behavior (walkthrough 10) belong to later slices. No actual Linux/macOS service
validation or Docker runtime integration is claimed by C01. It adds no CLI
commands, runtime configuration or environment variables.
