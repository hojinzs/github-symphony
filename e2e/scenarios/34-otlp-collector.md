# TC-34 / OT-14 — Collector receipt and endpoint interruption

Run `./e2e/run-otlp-collector-e2e.sh` from the checkout. Requires Docker
Compose and a reachable daemon. It builds the existing standalone E2E image,
uses the existing file tracker, hook and stub worker, and starts the normal
bundled CLI without a coding-agent token. No host port is published. Compose
project/image isolation follows `e2e/lib/compose-project.sh`; output is a new
host temporary directory printed even on failure.

The Collector is pinned to `otel/opentelemetry-collector-contrib:0.123.0`.
Its OTLP/HTTP receivers accept protobuf on plain port 4318 and Basic-authenticated
port 4319. The Basic credentials and htpasswd entry are public test fixtures.
An unauthenticated POST must return 401 before authenticated receipt is tested.
The Collector's [file exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/v0.123.0/exporter/fileexporter)
serializes decoded protobuf-derived Logs and Metrics as OTLP JSON lines.
No synthetic JSON is sent to stand in for SDK receipt.

## Cases

1. Plain receiver: dispatch a file-tracker issue to successful completion,
   terminate the CLI gracefully and verify final export.
2. Authenticated receiver: restart the same project with a new issue and the
   fixture Authorization header. Confirm attributable receipt through the
   authenticated-only receiver.
3. Restart: start the same project again. Project identity stays stable;
   the process UUID changes. History is a gauge; tick outcomes remain a
   monotonic cumulative sum with positive data points.
4. Endpoint interruption: stop the actual Collector, then dispatch another
   issue. File evidence and the completed stub worker must remain intact;
   shutdown finishes within ten seconds. The CLI log must contain an
   `otlp-diagnostic` transport failure proving an attempted export. No receipt
   is claimed for this run.

Each successful-receiver case must contain timestamped Logs with its exact
run ID and project/file-tracker Resource identity, and Metrics sharing its
process UUID. `symphony.runtime.total` must be a gauge and
`symphony.tick.outcomes` a cumulative monotonic sum. Do not sum history across
process UUIDs. The runner then corrupts copied evidence with 17 forbidden-result
probes; every probe must fail at its named reached assertion.

## Evidence and gates

The printed evidence directory retains `commit.txt`, `collector.yaml`, resolved
image IDs (`images.json`), `collector.log`, `logs.jsonl`, `metrics.jsonl`, and
per-case CLI logs, manifests, run metadata, worker logs and `events.ndjson`.
Cleanup captures available image IDs before container removal on success or failure.
Manifests record endpoint (without credentials), run/project IDs, completion
time and shutdown result. Collector log timestamps and OTLP timestamps provide
receipt attribution. Keep the directory with the command's complete output;
review for secrets before sharing any operational evidence.

Exit 69 during the shared Docker prerequisite preflight is the narrow accepted
unattended-worker limitation documented in AGENT_TEST.md. Record the command,
status and intended OT-14 scenario, finish available gates and leave actual
receipt confirmation to operator/CI. Do not install a daemon. Status 125 and
all failures after successful preflight are failures, including missing receipt
or failed forbidden-condition probes.

`node e2e/otlp/receipt-self-test.mjs` only tests the evidence verifier with
synthetic Collector JSON; it is not Collector acceptance. `pnpm test` includes
this verifier regression. Existing in-process wire and lifecycle tests cover
protocol failures beyond this scenario (partial success, stalls and recovery).
Operator/CI must run this Docker scenario and link its attributable receipt
before Epic closure. Dogfood delivery and Collector receipt are separate gates;
this scenario supplies no production-reachability or dogfood claim.

## OT-09 auth removal regression (#1095)

1. Start a project daemon with OTLP enabled, an empty file-tracker issue list,
   and `Authorization: $OTLP_AUTH` resolved only from the project `.env`.
2. After startup, remove `OTLP_AUTH` from `.env`, retaining reserved
   `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_LOGS_HEADERS` canaries.
3. Add a Ready issue. Verify an invalid workflow reload diagnostic naming
   `OTLP_AUTH`, last-known-good fallback, successful dispatch and no failed run.
4. Verify the worker has none of the three credential variables and the applied
   exporter remains unchanged. Stop the daemon gracefully.

The deterministic service regression `OT-09 dispatches with LKG after enabled
exporter auth disappears` covers this sequence and its dispatch mutation.
The Collector runner remains the independent Docker transport/dispatch check.
