# Run-history polling cost baseline

Issue: [#894](https://github.com/hojinzs/github-symphony/issues/894)

## Decision

At 10,000 historical runs, repeated full inventories dominate the isolated
polling cost. The representative five-pass tick read 50,005 `run.json` files
and took 1.30–1.56 seconds after warm-up on the reference machine. A single
inventory read the same 10,001 files in 239–352 ms.

Before optimizing, adopt this target for the 10,000-history fixture:

- no more than one full run inventory per project reconciliation tick (at most
  10,001 `run.json` reads for this fixture), and
- no regression in active-run visibility while an update is in flight, legacy
  recovery, project isolation, retry state, metrics, or unpublished-work
  protection.

Use a 400 ms warm-cache tick budget on the reference machine as a directional
engineering check, not a CI assertion. The deterministic read target is the
portable acceptance gate; production latency needs separate telemetry.

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
the first inventory. `inventory` performs one full inventory pass.
`polling-tick` performs five passes, matching the repeated `loadAllRuns()` calls
on the current minimal successful `reconcileProject()` path. The read count is
calculated as `(historical records + active record) × inventory passes` and
excludes the warm-up pass.

## Baseline results

Recorded 2026-09-14 on Node.js v24.18.0, Darwin arm64. Times are elapsed wall
clock milliseconds. CPU columns are process CPU consumed during the measured
window. RSS is the increase in Node's process-wide maximum resident-set size,
so later rows can report a small delta after an earlier row established a high
water mark.

| History | Layout | Scenario     |  Reads | Elapsed ms | User CPU ms | System CPU ms | Max RSS Δ KiB |
| ------: | :----- | :----------- | -----: | ---------: | ----------: | ------------: | ------------: |
|     100 | legacy | inventory    |    101 |       2.44 |        1.96 |          6.11 |         1,120 |
|     100 | legacy | polling tick |    505 |       9.49 |        9.66 |         21.96 |           128 |
|     100 | shared | inventory    |    101 |      15.33 |        3.72 |          6.43 |           208 |
|     100 | shared | polling tick |    505 |      29.38 |       11.72 |         30.31 |         1,552 |
|   1,000 | legacy | inventory    |  1,001 |      24.89 |       20.89 |         64.51 |         7,088 |
|   1,000 | legacy | polling tick |  5,005 |     111.52 |       87.20 |        305.32 |        15,760 |
|   1,000 | shared | inventory    |  1,001 |      30.04 |       18.76 |         53.03 |         1,168 |
|   1,000 | shared | polling tick |  5,005 |     532.03 |       91.10 |        393.49 |         7,120 |
|  10,000 | legacy | inventory    | 10,001 |     352.31 |      208.67 |      1,123.41 |        63,008 |
|  10,000 | legacy | polling tick | 50,005 |   1,562.43 |      915.65 |      4,774.38 |        88,608 |
|  10,000 | shared | inventory    | 10,001 |     239.38 |      200.39 |        577.84 |            64 |
|  10,000 | shared | polling tick | 50,005 |   1,304.73 |      978.62 |      3,491.49 |           272 |

The result grows approximately linearly with record reads. Layout differences
are small at 1,000 and 10,000 histories compared with the roughly fivefold read
amplification in the representative tick.

## Limitations

- These are isolated, warm-cache filesystem measurements, not production disk,
  network filesystem, container, or cold-cache latency.
- One sample per matrix cell is a reproducible baseline, not a statistical
  latency distribution. Repeat runs are appropriate when evaluating an
  optimization, and production SLOs require production telemetry.
- Fixture creation and cleanup are outside the measured window.
- The process-wide maximum RSS metric is a high-water mark and cannot attribute
  retained memory to an individual scenario.
- The tick model isolates run inventory cost. It does not include tracker API
  latency, workflow loading, workspace inspection, serialization, or dispatch.
- Timings are recorded in a report only; unit tests assert fixture contents,
  read accounting, active-run visibility, and cleanup without millisecond
  thresholds.

## Compatibility

This benchmark changes no runtime behavior. It observes the Coordination layer
through the existing filesystem store and records an Observability baseline.
Provider behavior remains in adapters, and persistence, retry, metric, and
unpublished-work contracts are unchanged. There is no intentional divergence
from `docs/symphony-spec.md`; the upstream specification was not edited.
