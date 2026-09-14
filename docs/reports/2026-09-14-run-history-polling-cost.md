# Run-history polling cost baseline

Issue: [#894](https://github.com/hojinzs/github-symphony/issues/894)

## Decision

At 10,000 historical runs, one real project reconciliation performs five full
run inventories. It read 50,005 `run.json` files and took 80.12–83.59 seconds
after warm-up on the reference machine. A single isolated inventory read the
same 10,001 files in 303–551 ms. The full-tick result also includes the current
non-inventory reconciliation work, most notably producing and persisting the
project snapshot; it therefore replaces the earlier synthetic five-inventory
estimate rather than being directly comparable with it.

Before optimizing, adopt this target for the 10,000-history fixture:

- no more than one full run inventory per project reconciliation tick (at most
  10,001 `run.json` reads for this fixture), and
- no regression in active-run visibility while an update is in flight, legacy
  recovery, project isolation, retry state, metrics, or unpublished-work
  protection.

Use a 10,001-read warm-cache tick target as the deterministic optimization
gate. Do not use these elapsed values as CI thresholds: they are one local
sample, and production latency needs separate telemetry. After reducing the
inventory count, rerun the entire matrix before proposing an elapsed-time
budget because the real tick exposes material non-inventory scaling work.

## Reproduce

From the repository root on a revision containing this report:

```bash
pnpm --silent --filter @gh-symphony/orchestrator benchmark:history \
  > /tmp/symphony-history-benchmark.json
```

The command creates a new temporary root for every history-size/layout pair,
warms each fixture once, prints one JSON document, and removes every fixture in
a `finally` block. It covers 100, 1,000, and 10,000 historical records plus one
identical active run in both layouts:

- `legacy`: `<runtime>/runs/<run-id>/run.json`
- `shared`: `<runtime>/projects/benchmark-project/runs/<run-id>/run.json`

Each measured scenario starts one atomic active-run update concurrently with
the measured operation. `inventory` performs one full inventory pass.
`polling-tick` invokes the public `OrchestratorService.runOnce()` entry point
with a successful file-tracker/workflow fixture and observes every
`loadAllRuns()` call made by that reconciliation. The reconciliation's active
run refresh is suppressed in this isolated harness so it cannot migrate the
legacy fixture or overwrite the in-flight active update; its other work,
including status persistence, remains active. The measurement stops when the
inventory or tick completes; only then does cleanup await the update.

Read counts come from a scoped observer at the store module's JSON file
boundary, not from fixture-size arithmetic, and exclude the warm-up pass. It
records every file named `run.json`, including full inventories, per-run lookup,
and direct JSON reads. The three-record regression fixture observes 16 reads:
five full inventories and one per-run lookup. Negative controls that add either
direct JSON reads inside `loadAllRuns()` or per-run `loadRun()` calls in
reconciliation increase that total and make its assertion fail.

## Baseline results

Recorded 2026-09-14 on Node.js v24.18.0, Darwin arm64. Times are elapsed wall
clock milliseconds. CPU columns are process CPU consumed during the measured
window. RSS is the increase in Node's process-wide maximum resident-set size,
so later rows can report a small delta after an earlier row established a high
water mark.

| History | Layout | Scenario     |  Reads | Elapsed ms | User CPU ms | System CPU ms | Max RSS Δ KiB |
| ------: | :----- | :----------- | -----: | ---------: | ----------: | ------------: | ------------: |
|     100 | legacy | inventory    |    101 |       2.62 |        2.19 |          6.22 |           704 |
|     100 | legacy | polling tick |    505 |   1,165.58 |       80.37 |        121.09 |         5,856 |
|     100 | shared | inventory    |    101 |      14.52 |        3.41 |          7.06 |           112 |
|     100 | shared | polling tick |    505 |     940.96 |       55.12 |         81.24 |           720 |
|   1,000 | legacy | inventory    |  1,001 |      24.14 |       16.35 |         61.36 |         9,488 |
|   1,000 | legacy | polling tick |  5,005 |   6,885.14 |      345.21 |        605.32 |        25,616 |
|   1,000 | shared | inventory    |  1,001 |      21.05 |       15.83 |         31.61 |         1,184 |
|   1,000 | shared | polling tick |  5,005 |   9,431.57 |      356.76 |        579.13 |         7,568 |
|  10,000 | legacy | inventory    | 10,001 |     302.90 |      232.69 |        835.00 |        31,808 |
|  10,000 | legacy | polling tick | 50,005 |  80,115.62 |    3,660.09 |      7,468.79 |       212,208 |
|  10,000 | shared | inventory    | 10,001 |     550.59 |      230.69 |        996.08 |             0 |
|  10,000 | shared | polling tick | 50,005 |  83,590.34 |    3,771.94 |      7,603.96 |             0 |

Isolated inventory time grows approximately linearly with record reads. The
real tick grows much faster in this single run, showing that its cost cannot be
explained by the fivefold inventory amplification alone. Profiling the other
tick work belongs after the deterministic inventory reduction proposed here.

## Limitations

- These are isolated, warm-cache filesystem measurements, not production disk,
  network filesystem, container, or cold-cache latency.
- One sample per matrix cell is a reproducible baseline, not a statistical
  latency distribution. Repeat runs are appropriate when evaluating an
  optimization, and production SLOs require production telemetry.
- Fixture creation and cleanup are outside the measured window.
- The process-wide maximum RSS metric is a high-water mark and cannot attribute
  retained memory to an individual scenario.
- The tick uses the local file tracker and an external workflow, so it includes
  local workflow loading, reconciliation, snapshot construction, and status
  persistence but not production provider or network latency.
- The concurrent update is awaited only after timing/resource counters stop.
  It still runs in the same process and can contend for event-loop or filesystem
  resources during the measured operation.
- Timings are recorded in a report only; unit tests assert fixture contents,
  read accounting, active-run visibility, and cleanup without millisecond
  thresholds.

## Compatibility

This benchmark adds a scoped read-observation seam at the filesystem store's
JSON file boundary but does not change default runtime behavior. It observes
the Coordination layer through that store boundary and records an Observability baseline.
Provider behavior remains in adapters, and persistence, retry, metric, and
unpublished-work contracts are unchanged. There is no intentional divergence
from `docs/symphony-spec.md`; the upstream specification was not edited.
