# TC-29: OTLP lifecycle and safe diagnostics (H)

## Setup

Run `pnpm build`, then `node e2e/otlp-lifecycle-contract.mjs` locally, or
`./e2e/run-otlp-lifecycle-e2e.sh` for the isolated Docker run and both probes.
The fixture creates temporary project state, an empty file tracker, a real
HTTP control-plane listener and a local receiver. Explicit injection enables
the built owned pipeline; default production startup still rejects enablement.
This is H integration evidence, not I packaged activation or Epic Collector proof.

## Steps

1. Verify enabled startup rejects unsupported capability and disabled startup
   constructs no pipeline.
2. Start the injected Logs/Metrics pipeline, commit status and append a durable
   event. The receiver returns a permanent failure with a secret-like body.
3. Disable policy; reload, then read `/api/v1/state` with bearer authentication.
   Verify applied enablement remains true, pending disable/restart is visible,
   construction occurs once, and exporter degradation leaves `lastError` null.
4. Reload an invalid credential-bearing endpoint. Verify last-known-good workflow
   and unchanged applied/pending status.
5. Revert to startup policy; verify pending clears and secret sentinels from
   credentials/receiver/invalid URLs are absent from HTTP output and diagnostics.
6. Shutdown and verify the shared telemetry operation completes in five seconds
   (100 ms measurement tolerance).
7. Plant each forbidden condition and require failure after its reached marker:
   `--probe=pending-disable` discards the applied owner before the disable reload;
   `--probe=secret-diagnostic` writes a credential sentinel into persisted status.

## Expected

The normal run prints `OTLP H lifecycle contract passed`. Every named assertion
prints `reached:` before evaluation. Each probe fails with `AssertionError` after
its matching marker. The Docker runner validates both conditions rather than
accepting any arbitrary non-zero process exit.

Real-provider unit fixtures separately verify both concurrent flushes start,
abort pending requests and clear timers within the same five-second deadline;
service fixtures verify SDK graph exclusion and post-append publication.

## Cleanup

The contract closes both HTTP servers, shuts down providers and removes its
own temporary directory. The Docker runner removes its isolated Compose project
and image. An unavailable unattended-worker Docker prerequisite is accepted only
when the runner's preflight returns status 69, as documented in AGENT_TEST.md.
