# Run-history polling cost baseline

- Date: 2026-09-14
- Status: Baseline and #896 optimization measured

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
regression guard, not as the expected latency win. On the reference machine,
five legacy inventories account for approximately `5 × 193.94 ms = 970 ms` of
the 76,838.99 ms tick, or 1.3%; reducing five inventories to one would save
about 776 ms, or 1.0% of tick time. An independent Linux run measured a larger
but still secondary share: `5 × 1,174 ms` of 56,352 ms, or 10.4%, with an
estimated saving of about 8%. The latency opportunity is therefore
host-dependent and substantially smaller than the deterministic read-count
reduction.

Do not use these elapsed values as CI thresholds: they are one local sample,
and production latency needs separate telemetry. The optimization follow-up
should first profile the per-record non-inventory reconciliation work, which is
the dominant term in this baseline, then reduce inventory amplification and
rerun the entire matrix before proposing an elapsed-time budget.

## Optimization result (#896)

On 2026-09-15, issue #896 replaced the five global inventories with one
project-scoped historical inventory and bounded current-run reads at explicit
freshness boundaries. The same command and reference machine measured 10,005
`run.json` reads for both 10,000-history polling ticks: 40,001 fewer reads, or
a 79.99% reduction from the 50,006-read baseline. The result is three reads
above the original 10,002-read planning target because the implementation
retains separate post-reconciliation, pre-candidate, and final-snapshot
observations of the active run instead of treating one immutable snapshot as
fresh across asynchronous worker updates.

Elapsed results remain descriptive rather than a CI threshold. The legacy
10,000-history tick improved from 76,838.99 ms to 71,597.28 ms (6.8%), while
the shared-layout tick improved from 86,782.83 ms to 84,057.41 ms (3.1%). This
confirms the baseline conclusion that repeated inventories were measurable but
not the dominant per-record cost.

| History | Layout | Scenario     |  Reads | Elapsed ms | User CPU ms | System CPU ms | Max RSS Δ KiB |
| ------: | :----- | :----------- | -----: | ---------: | ----------: | ------------: | ------------: |
|     100 | legacy | inventory    |    101 |       2.02 |        1.92 |          3.43 |           752 |
|     100 | legacy | polling tick |    105 |     730.75 |       41.63 |         38.96 |         5,680 |
|     100 | shared | inventory    |    101 |       3.44 |        4.12 |          3.38 |           848 |
|     100 | shared | polling tick |    105 |     682.69 |       30.17 |         36.92 |           448 |
|   1,000 | legacy | inventory    |  1,001 |      18.18 |       22.41 |         33.25 |         5,904 |
|   1,000 | legacy | polling tick |  1,005 |   5,981.21 |      243.75 |        349.83 |        18,592 |
|   1,000 | shared | inventory    |  1,001 |      18.30 |       28.01 |         31.10 |         3,376 |
|   1,000 | shared | polling tick |  1,005 |   7,388.08 |      228.58 |        362.70 |        32,800 |
|  10,000 | legacy | inventory    | 10,001 |     153.61 |      167.94 |        359.63 |         8,128 |
|  10,000 | legacy | polling tick | 10,005 |  71,597.28 |    2,561.00 |      4,119.44 |        35,744 |
|  10,000 | shared | inventory    | 10,001 |     167.32 |      162.88 |        446.66 |            96 |
|  10,000 | shared | polling tick | 10,005 |  84,057.41 |    2,842.85 |      4,398.28 |         4,144 |

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
`loadAllRuns()` call made by that reconciliation. Every `saveRun` call is
suppressed in the measured tick so reconciliation cannot migrate the legacy
fixture or overwrite the in-flight active update. The three-record fixture
suppresses two calls, a count that scales with active runs rather than history,
so elapsed tick measurements exclude run-record writes. Other reconciliation
work, including project-status persistence, remains active. The measurement
stops when the inventory or tick completes; only then does cleanup await the
update.

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
real tick is also approximately linear over these history sizes: legacy
inventory grows 8.59× then 11.01×, while the legacy tick grows 9.89× then
10.88×. The distinction is a large constant factor, not a different growth
rate. At 10,000 records, the legacy tick costs about 7.68 ms per historical
record compared with 0.019 ms per record for one inventory, roughly 400× more.
This localizes the dominant cost in per-record non-inventory reconciliation
work rather than the five inventory passes alone.

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
  persistence but not production provider or network latency. All `saveRun`
  persistence is stubbed during the measured tick (two calls for this fixture,
  scaling with active runs rather than history), so elapsed results exclude
  run-record writes.
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
