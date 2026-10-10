# TC-29 — Fleet lifecycle command ledger and recovery

**Symphony Layers:** Coordination (management only), Integration, Observability
**Issue:** #1011 (C07), Epic #983

Run after `pnpm build`:

```bash
node e2e/fleet-commands-e2e.mjs
node e2e/fleet-commands-mutations.mjs
./e2e/run-fleet-commands-e2e.sh
```

The Docker wrapper uses the per-worktree Compose identity, builds the Node 24
image and removes its containers/volumes/image. It runs both scripts in Linux.
The peer is independent IPC test infrastructure importing the compiled C04/C07
libraries. It owns project/session truth and enrollment credentials. It is not
a shipped HTTP server. A separate SQLite agent journal records receipt, effect
marker and result; its semantics exercise the typed agent boundary, not the
future agent implementation.

| Case                      | Trigger                                                                       | Expected                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| CP-06 offline             | Offline target submission                                                     | Explicit rejection; no offline queue                                                         |
| CP-06 claim race          | Separate connections race recovery and first claim at/before deadline         | At 30 seconds expired commits and claim fails; at 29.999 seconds original execution survives |
| CP-06 revoke              | C04 credential revocation with ledger invalidation                            | Unclaimed work expires atomically                                                            |
| CP-18 lost response       | Claim commits, response ignored, Control Plane restarted after claim deadline | Original ownership and claimedAt survive; executing replay does not reset deadline           |
| CP-19 marker              | Repeat journal effect attempt                                                 | Durable compare/update permits one fixture invocation                                        |
| CP-07 lost result         | Journal stores result, no upload, both sides reopen                           | Ledger becomes unknown; original durable result reconciles original ID                       |
| CP-07 lost acknowledgment | Result commits, response ignored, Control Plane restarts                      | Identical terminal replay acknowledged                                                       |
| CP-10 clock skew          | Agent observations behind/ahead; result replay after receipt time advances    | Skew accepted; first Control Plane completion time preserved                                 |
| CP-09 interrupted         | Unknown record then replacement click                                         | Project remains fenced; no replacement queue                                                 |
| CP-09 explicit closure    | Acknowledgment and reason                                                     | State remains unknown, actor/reason/time audited; fresh ID allowed                           |
| CP-19 reconnect           | Old and new untransferred sessions replay                                     | Stale session rejected; new session requires same-agent transfer                             |
| CP-19 transfer            | Transfer interrupted execution                                                | Original claim retained; unknown permits reconciliation only                                 |
| CP-09 history             | Query after explicit closure                                                  | Closed unknown remains visible                                                               |

The positive script prints `reached:` before each of 18 assertions.
The forbidden-condition runner copies compiled artifacts into an isolated
temporary directory, restores each mutation, and proves all 18 assertions fail
with their matching reached marker and an AssertionError. Two probes plant
forbidden conditions in the independent peer/journal boundary (effect marker
and fresh identity); the other probes alter compiled ledger behavior.

Unit coverage complements these probes with actor-scoped key conflicts,
invalid/unmanaged/unsupported targets, capacity, result evidence conflicts and clock-skew reconciliation,
terminal reconnect, revocation/audit rollback, bounded project-bound cursors,
90-day pruning, indefinite unresolved retention and late-result receipt retention.

Report macOS execution separately from Linux Docker execution. These tests
do not validate systemd/launchd isolation, real orchestrator signals, PID reuse,
or native agent-journal effect fencing; those belong to peer slices. Static
design examples are not used as runtime evidence.
