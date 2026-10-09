# TC-29: C05 foreground enrollment, sessions and outbound transport

## Setup

Run `pnpm build`, then `node e2e/agent-transport-e2e.mjs` for actual host
evidence or `./e2e/run-agent-transport-e2e.sh` for isolated Linux Docker evidence.
The scenario creates ephemeral trusted TLS material, private SQLite/registry
directories and a prepared file-tracker project with no issues. The packaged
management module runs in a separate foreground process. The independent HTTPS
peer invokes actual C04 enrollment and C05 sessions; C06 inventory projection and
global UUID allocation are typed/schema-validated fixture boundaries.

## Steps

1. Pack the CLI and verify JavaScript plus declaration artifacts for the
   management-agent module. Exchange a token over HTTPS, inspect private identity
   persistence and resume without another token.
2. Reject reused tokens, wrong credentials, incompatible wire version and a
   second live session. Upload empty inventory with a skewed agent timestamp and
   reject projection replacement by an older sequence.
3. Advance the injected server clock past the expiry boundary; reject the
   expired session and report offline. Start the real bundled local CLI daemon.
4. Start the foreground agent and observe connected/zero-project state. Supply
   the sibling publisher fixture with one registered prepared folder; C03 reads
   its real process observation.
5. Stop the HTTPS peer process while the foreground process and real orchestrator
   remain alive. Verify retrying and local exclusive lock retention. Change
   fixture inventory generation during the outage.
6. Restart the HTTPS peer against the same SQLite file and port. Verify explicitly
   offline/stale retained state, new current session and the latest inventory
   generation; verify the original orchestrator PID remains running.
7. Revoke through real C04/C05 transaction hooks. Verify terminal credential
   rejection, foreground lock release, saved identity preservation and independent
   orchestrator continuity. Child diagnostics contain neither token nor credential.
8. Enroll a separate empty agent, send SIGTERM and verify clean foreground exit
   without stopping the same orchestrator.

## Expected

Every assertion prints a reached marker. CP-05, CP-10, CP-11, CP-17 and CP-21,
plus the owned enrollment/zero-project operator walkthrough, have executable
evidence using real TLS, SQLite, process boundaries and local orchestrator.

The Docker runner additionally plants six forbidden conditions: missing packaged
declarations, premature online state, live-session replacement, extra stale
projection write, stopped orchestrator and credential output. Each probe must
reach its named assertion and fail with AssertionError. These probes establish
that assertions are executed; unit mutations independently remove implementation
guards.

Expiry and agent-clock skew use the service's injected clock. Report actual
macOS host execution separately from Linux container execution. This scenario
does not validate systemd/launchd installation, service isolation, logout/reboot
or CP-22/23. No complete C06 projection or command/read execution claim is made.

## Cleanup

The scenario closes registries, stops its foreground/peer processes, gracefully
stops its own real project daemon and removes only its temporary directory.
The Docker runner removes its isolated Compose resources and derived image.
