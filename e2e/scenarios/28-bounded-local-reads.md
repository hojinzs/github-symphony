# TC-28: Bounded local history and log reads (C09)

## Setup

Build the repository with `pnpm build`. Run `./e2e/run-bounded-read-e2e.sh`
for isolated Linux Docker evidence. Run `node e2e/bounded-read-contract.mjs`
separately for actual host OS evidence; Docker Linux is not native Linux or
macOS validation. The runner uses the shared worktree-derived Compose isolation.

## Steps

1. Start a real packaged CLI daemon through an alias to an existing prepared
   folder, then register its canonical folder with the local agent.
2. Persist 105 independent run fixtures through `createStore().saveRun` and
   read history/detail through the bundled `createLocalReadAdapter` factory.
3. Read the fixed worker, event and orchestrator streams. Follow a worker log
   larger than 256 KiB across chunks, EOF and append.
4. Replace and truncate the worker log. Request with the previous cursor.
5. Request missing logs, unknown runs/streams, traversal, a symlink to a file
   outside the runtime, a cross-stream cursor, and an expired read.
6. Invalidate the workflow and retain history access. Verify reads preserve the
   daemon's PID/process identity. Remove registration and verify read revocation.
7. The Docker runner repeats the scenario with five forbidden result probes:
   oversized text, absent reset, credential metadata, empty missing-log success,
   and symlink escape. Each run must fail with its specific named assertion.

## Expected

- CP-12: history is ordered and bounded to 100 summaries; log text is bounded
  to 256 KiB; offsets advance through append/EOF; rotation and truncation report
  explicit reset; missing/invalid/escaping selections report unavailable.
- CP-15: projected metadata excludes raw errors, prompt/config text and
  management credentials. Raw logs remain trusted-operator-only sensitive text.
- U04/U07: retained history stays readable with invalid workflow; follow may
  resume from a returned cursor or restart without one. Reads make no process
  effects and do not acquire lifecycle command slots.
- The scenario prints `bounded-read CP-12/15 blackbox passed (<platform>)`.
- Every forbidden probe reports `assertion reached and failed as required`.

Offline HTTP/UI state, poll/read-lane scheduling and raw-log server retention
belong to transport/server/UI slices. The adapter performs no background reads
or uploads. Native-service installation/isolation is outside this scenario.

## Cleanup

The script stops the daemon, closes the registry and removes its private temporary
fixture. The Docker runner removes its Compose resources and derived image.
