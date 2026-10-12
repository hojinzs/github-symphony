# TC-31 — Fleet bounded read lane and detail routes

Issue #1014 / C10 / Epic #983. CP-12, relevant CP-10 receipt timestamps and
CP-11 session scope; U04 detail/history and U07 log follow/reset.

After `pnpm build`:

```bash
node e2e/fleet-reads-e2e.mjs
node e2e/fleet-reads-mutations.mjs
./e2e/run-fleet-reads-e2e.sh
```

The blackbox imports built artifacts, opens real private SQLite storage,
exchanges a real C04 enrollment and C05 exclusive session, and submits browser
requests through a trusted HTTPS listener using actual CSRF sessions. An
independent typed project projection fixture provides stable target identity.
The actual C09 AgentRegistry/LocalReadAdapter reads real run metadata and files.
No read implementation is mocked. The optional C06 projection hook persists
only validated summaries in an independent fixture table.

Every acceptance assertion prints a `reached:` marker. The nineteen forbidden
condition probes copy compiled artifacts outside the checkout, alter one
condition, and require both a reached marker and the named assertion failure.
Every listed acceptance assertion has a matching forbidden-condition probe.
Most alter copied service artifacts; the cached-history survival probe plants
physical loss of the independent peer fixture table in the copied runner.
This proves the cache-survival assertion executes and rejects lost history.

| Case                                | Expected result                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| Lifecycle command outstanding       | Read history still succeeds; no lifecycle-slot dependency                          |
| Unknown stream/path selector        | 400 structured invalid-input error                                                 |
| Registered run metadata             | Bounded safe summaries and selected detail, no prompt leakage                      |
| Log chunk and append                | At most requested bytes, opaque cursor continues at byte offset                    |
| Rotation or truncation              | Explicit reset survives fleet result publication                                   |
| Missing log / traversal run ID      | Unavailable diagnostic, no false empty success                                     |
| Second pending project read         | Busy diagnostic                                                                    |
| Offline pending detail              | Unavailable; cached completed content preserved and marked historical              |
| Offline admission                   | Agent-offline diagnostic                                                           |
| Exact 30-second deadline            | Expired result                                                                     |
| Exact 60-second completed retention | Unavailable after removal                                                          |
| In-memory service recreation        | Unknown read unavailable; peer summaries survive, raw logs absent from persistence |

Host output identifies actual OS. The Docker runner is an isolated Linux
simulation and runs the same contract and probes. Neither is native
systemd/launchd isolation or managed-process lifecycle evidence. Fleet listener
installation, shared agent transport wiring and C06 production projection are
separately owned; this scenario validates their typed composition boundaries.
