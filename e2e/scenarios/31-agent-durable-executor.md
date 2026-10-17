# TC-31: Agent durable executor and process reconciliation

## Setup

Run `pnpm build`. The runner creates private temporary agent/fleet directories
and one prepared project with a file tracker and no issues. It uses the bundled
CLI `management-agent`/`management-local` entries, real registry/journal files,
actual C04 enrollment and C07 SQLite command storage, and separate agent/CLI
daemon OS processes. Session/project projections are an independent fixture;
server-clock advancement simulates deadline passage. This is not fleet HTTP route
assembly or a native systemd/launchd service test.

## Steps

1. Run `node e2e/agent-executor-e2e.mjs` on the host.
2. Verify invalid local workflow fails without spawning. Lose its result
   acknowledgment, kill the agent and move its folder. Redeliver the same command
   after restart and verify the saved result resends unchanged without live folder
   access or new effects. Restore the folder and workflow afterward.
3. Commit a real fleet claim but lose its response before an effect. Kill the
   agent, advance the fixture server clock past the claim deadline, restart the
   agent and replay. Verify the original claim time and one ready CLI daemon.
4. Stop normally, commit the real result but lose its acknowledgment. Kill the
   agent and reopen the fleet store; transfer the original same-agent owner to a
   fresh fixture session. Verify the saved result resends unchanged on an empty
   poll and the journal acknowledges it.
5. Kill the agent after its durable marker but before invoking CLI start. Verify
   recovery remains unknown, invokes nothing and fences another fleet command.
   Explicitly close unresolved, verify its durable local-owner audit, and verify
   journal retirement preserves the unknown outcome.
6. Advance the fixture server clock after receipt but before first claim. Verify
   the unclaimed command expires without effects or an unknown result.
7. Pause a real ephemeral CLI daemon. An independent driver-port fixture verifies
   its journaled PID/identity, queues an actual SIGTERM, and returns `signal_sent`.
   Verify no completion while it remains alive. Resume it and verify real target
   exit plus released locks before success. The production expected-stop socket
   cannot answer while OS-paused; other stop cases use that concrete CLI path.
8. Kill the agent after concrete expected-target CLI stop but before its result.
   Wait for target A to exit, start B through the local CLI, then restart agent
   recovery. Verify failed `superseded_target`, no extra signal, B's continued
   readiness, unchanged ownership records and no raw OS identity in uploaded
   evidence.
9. Kill the agent while B runs. Verify B continues and stale-session claim replay
   is rejected by the actual fleet service.
10. Run `node e2e/agent-executor-mutations.mjs`. Six isolated runs plant lost cached
    result after folder removal, changed
    claim time in real SQLite, a changed retry result in the real journal, a
    removed marker, a fabricated expired result, or a shutdown of B. Each must
    print its named reached assertion and fail with that assertion's error.
11. Run `./e2e/run-agent-executor-e2e.sh` for isolated Linux Docker baseline and
    the same forbidden-condition probes. The runtime image must include both
    `agent-executor-e2e.mjs` and `agent-executor-mutations.mjs`; a missing runner
    after successful preflight is a test failure. The Compose service uses an
    init process to reap orphaned daemons after stop/crash cases; without it,
    zombies can prevent verified stopped-state observation. Record preflight
    status 69 separately when the unattended worker cannot access Docker;
    it is not Linux evidence.

## Expected

- Baseline prints 27 reached assertions and `agent executor black-box passed`,
  identifying the actual host OS and the simulated peer/clock boundaries.
- CP-04/05/06/07/08/09/18/19 and applicable U04 lifecycle/U07 recovery library
  paths use actual durable agent and fleet records. Existing local CLI readiness,
  locks and expected-target shutdown remain authoritative.
- All nine probes fail at their named assertions. An unrelated exception or
  timeout does not count as mutation evidence.
- Unit tests separately cover foreign ownership, terminal/unknown replay,
  readiness absence, held locks, target PID/runtime reuse, authoritative execution
  expiry and local observation windows with server clocks ±40/65 seconds skewed, terminal authority, private malformed files and retention. The
  foreground factory test covers empty-poll recovery under its owner lock.
- No native-service isolation, HTTP/browser flow or actual Linux validation is
  inferred from a macOS run or a peer fixture.

## Cleanup

The runner terminates only its test agents at intentional crash boundaries,
resumes any paused test daemon, gracefully stops the current managed daemon with
the verified local adapter, closes SQLite/registry owners and removes temporary
directories. The Docker runner tears down its worktree-scoped Compose project.

CP-03 / #1050 / C07 #1011: invalidate the workflow of a real running daemon;
report invalid readiness to C07, reject start, reject an unverified stop without
an effect, then submit and execute verified stop through the real C03 adapter.
Verify the workflow stays invalid, the process exits and locks are released.
