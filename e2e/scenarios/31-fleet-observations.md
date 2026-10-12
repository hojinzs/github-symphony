# TC-31: Fleet observations, atomic inventory and tracker-scope warnings

C06 (#1010, Epic #983), Integration and Observability. This scenario composes
actual C04/C05/C06/C07 services over SQLite in a separate TLS peer process with
the actual bundled agent inventory publisher. The invalid prepared-folder case
uses the shipped local inspector; large payloads and extra project observations
are independent typed protocol fixtures. Fixture identity negotiation and IPC
operator queries exercise library boundaries, not production HTTP/UI assembly.

## Execution

```bash
pnpm build
node e2e/fleet-observations-e2e.mjs
node e2e/fleet-observations-mutations.mjs
./e2e/run-fleet-observations-e2e.sh
```

The Docker runner uses the path-isolated Compose project and shared availability
checks from `AGENT_TEST.md`. All temporary databases, certificates, registry files
and mutated artifacts live outside the repository and are cleaned up. The
production checkout is never mutated by the black-box fault runner. Each assertion
prints `reached:` before evaluating; the mutation runner requires the intended
marker, an assertion failure and a nonzero exit, rejecting startup/timeout errors
as mutation evidence.

## Owned cases and evidence

| Case                           | Normal, invalid and recovery evidence                                                                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CP-01                          | Two enrolled environments report the same local ID; server-issued UUIDs differ; foreign project uploads rejected                                                                                                                  |
| CP-02                          | Existing C03 canonical registry tests guard alias deduplication; C06 joins UUIDs by canonical local identity, never a path                                                                                                        |
| CP-03                          | Actual unprepared folder is visible with invalid workflow; no fabricated readiness                                                                                                                                                |
| CP-05                          | Cached running observations persist through peer restart as explicitly stale; current-session upload recovers freshness                                                                                                           |
| CP-10                          | Future agent timestamps cannot keep counts fresh; stale sessions rejected; C05 sequence tests and C06 unit cases cover old uploads                                                                                                |
| CP-14                          | Complete revision removal expires real C07 unclaimed commands; partial revision retains unseen membership; removed local registration absent from next publication                                                                |
| CP-15                          | Publisher unit fixture contains credential/OS-command canaries that never reach wire pages; existing C03 tests own child environment isolation                                                                                    |
| CP-17                          | Sorted/deduplicated reported scope sets identify known identical scopes; differing, missing, failed or stale metadata remains unverified; no provider eligibility or global scheduling                                            |
| CP-21                          | Authenticated empty inventory becomes online with zero projects                                                                                                                                                                   |
| U01/U03 and outage walkthrough | Paged fleet query defaults to 25 rows, retains unmanaged history, rejects filter-changed cursors, excludes stale running processes, retains failed snapshots and timestamps                                                       |
| Atomic faults/capacity         | Duplicate pages/identities, inconsistent page counts, foreign bindings and >100 projects rejected; command invalidation fault rolls back inventory, command state, sequence and receipt together; later bounded revision recovers |

CP-04/06–09/12–13/16/18–20/22–23 remain owned by lifecycle, enrollment,
bounded reads, browser security and native-service slices. Existing regression
suites remain in the full `pnpm test` gate; C06 does not claim native
systemd/launchd, live UI, tracker scheduling or service isolation acceptance.

The C06/C07 revocation boundary also verifies CP-11: cached observations survive
credential/session deletion and new commands report `access_revoked`. Full
enrollment authentication and native-process continuity remain C04/C05 ownership.
The pre-existing C07 invalid-workflow stop-submission gap is tracked separately
in #1050; CP-03 evidence here covers visible invalid inventory, not stop execution.

## Results and fault sensitivity

The scenario reaches 20 assertions. Eighteen isolated mutations in compiled
fleet/session/enrollment/command/store artifacts and bundled agent artifacts prove
first signal, partial/complete membership, duplicate rejection, rollback,
invalidation, snapshot retention, page splitting, normalized scope warning,
identity fencing, receipt-based totals, cached offline process state, session
fencing, unverified overlap, paging/cursors and allowlist removal assertions fail.
Unit mutations additionally cover publisher identity validation, fresh allowlist
reads after outage, capacity, sorted runs, mixed identical/unverified warnings and
wire compatibility.

Report actual host OS separately from container evidence. During #1010 validation,
actual macOS passed both scripts. The Docker runner and isolated user-socket retry
both returned exit 69 before container execution: daemon unreachable. Environment
follow-up #1049 records the documented exception; no Linux container or native
Linux acceptance is claimed from the macOS result.
