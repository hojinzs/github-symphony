# Run-history polling cost baseline

Issue: [#894](https://github.com/hojinzs/github-symphony/issues/894)

## Decision

At 10,000 historical runs, one real project reconciliation performs five full
run inventories. It read 50,006 `run.json` files and took 76.84–86.78 seconds
after warm-up on the reference machine. A single isolated inventory read the
same 10,001 files in 194–393 ms. The full-tick result also includes one per-run
lookup and the current
non-inventory reconciliation work, most notably producing and persisting the
project snapshot; it therefore replaces the earlier synthetic five-inventory
estimate rather than being directly comparable with it.

Before optimizing, adopt this target for the 10,000-history fixture:

- no more than one full run inventory plus the observed per-run lookup per
  project reconciliation tick (at most 10,002 `run.json` reads for this
  fixture), and
- no regression in active-run visibility while an update is in flight, legacy
  recovery, project isolation, retry state, metrics, or unpublished-work
  protection.

Use a 10,002-read warm-cache tick target as the deterministic optimization
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
|     100 | legacy | inventory    |    101 |       2.05 |        1.69 |          4.93 |         1,136 |
|     100 | legacy | polling tick |    506 |     713.54 |       52.12 |         59.46 |         5,264 |
|     100 | shared | inventory    |    101 |       4.67 |        4.11 |          8.30 |           224 |
|     100 | shared | polling tick |    506 |     755.78 |       48.17 |         65.72 |           560 |
|   1,000 | legacy | inventory    |  1,001 |      17.61 |       14.38 |         42.81 |        15,440 |
|   1,000 | legacy | polling tick |  5,006 |   7,059.73 |      363.54 |        576.83 |        41,664 |
|   1,000 | shared | inventory    |  1,001 |      16.99 |       15.49 |         32.71 |             0 |
|   1,000 | shared | polling tick |  5,006 |   7,673.18 |      311.09 |        540.67 |        55,728 |
|  10,000 | legacy | inventory    | 10,001 |     193.94 |      217.17 |        444.89 |        72,480 |
|  10,000 | legacy | polling tick | 50,006 |  76,838.99 |    3,290.04 |      5,728.87 |       169,872 |
|  10,000 | shared | inventory    | 10,001 |     392.88 |      227.53 |        523.39 |           240 |
|  10,000 | shared | polling tick | 50,006 |  86,782.83 |    3,836.01 |      7,511.35 |         3,248 |

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
