# TC-25: Expected-target local CLI stop (CP-08)

## Setup

Run `./e2e/run-expected-target-stop-e2e.sh`. The runner builds the packaged CLI,
uses the repository's isolated Compose project/image, and cleans up afterward.
The Linux image includes `procps` for real OS process identity evidence.
For native macOS validation, build first and run
`node e2e/expected-target-stop.mjs`. Native verification requires `ps` and `lsof`.

## Steps

1. Prepare a file-tracker project with no issues; start real CLI process A.
2. Use A's real lock identity to populate the typed daemon PID-record boundary.
   Foreground children let the runner reap exited processes on both platforms.
3. Reject incomplete expected arguments and `--force`; reject missing identity
   evidence without stopping A. Restore the PID record.
   Plant A's cached configuration under another folder's runtime key and verify
   that a stop addressed to that other folder cannot redirect shutdown to A.
4. Break the workflow (CP-03), then stop verified A through the local endpoint. Wait for actual exit and both
   locks to release; replay the target and verify `already_stopped` while
   preserving the stale matching PID record.
5. Restore the workflow, start B through the CLI and install B's real PID record. Replay A's persisted
   target through the packaged CLI and directly to B's local endpoint.
6. Simulate PID reuse by supplying B's PID with A's recorded identity.
7. Assert B remains alive and PID/project/folder-lock ownership fields are
   unchanged. Heartbeat timestamps may advance.
8. Break the workflow and confirm ordinary folder-only stop still stops B.
9. Repeat with `EXPECTED_STOP_PLANT_FORBIDDEN=1`: delete B's PID record just
   before the ownership assertion. Require that exact CP-08 assertion to fail.
   The Docker runner executes this negative probe automatically.

## Expected

Normal stop returns `signal_sent`, then actual exit and released locks are
observed. Replacement/reused identities return `superseded_target` without
signaling B or deleting its records. Missing evidence returns
`process_unverified`. Direct endpoint replay covers replacement between
caller-side verification and delivery. Unit tests inject per-record replacement,
unavailable OS evidence, missing locks and post-verification ownership changes.
This does not force actual kernel PID reuse or implement the management agent's
durable journal/completion protocol; those limits must be recorded separately.

## Cleanup

The Node runner terminates its own children and removes only its temporary
project/configuration/socket. Compose cleanup removes the isolated container and
image; no shared fixture mutations or fixed host ports are used.
