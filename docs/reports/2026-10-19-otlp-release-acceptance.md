# OTLP ordinary-host release acceptance (#1084)

Status: Measurement complete; **release activation remains off**. Report recorded
2026-10-19T03:53:12Z. Draft delivery: [PR #1091](https://github.com/hojinzs/github-symphony/pull/1091).

Symphony Layers: Observability, Execution (audit boundaries only).

## Decision and scope

All three new native macOS baseline/candidate comparisons and all three separate
identical-artifact controls passed the unchanged startup, RSS and offer gates.
This series supplies ordinary-host macOS evidence under the owner's
[measurement-policy decision](https://github.com/hojinzs/github-symphony/issues/1084).
It does not erase the two historical macOS failures, the previously failed macOS
identical-artifact control, or Linux comparison-3. Activation remains off because
the retained failed gates have not been waived or cleared. No runtime activation,
configuration default, threshold or sample count changed.

The original idle-host prerequisite was explicitly replaced by the owner with
ordinary-host measurements and noise controls. This is a repository-local release
measurement policy, with no intentional divergence from the upstream Symphony
spec. The upstream spec is unchanged. This report does not claim an idle-host
experiment, causally attribute failures to scheduling, or grant Linux acceptance.

## Predeclared method and artifacts

The complete protocol was published in the issue workpad before the first audit;
it is retained verbatim in the [evidence JSON](2026-10-19-otlp-release-acceptance-evidence.json).
The sequence was comparison 1, control 1, comparison 2, control 2, comparison 3,
control 3. Exactly these six audits ran, sequentially. Builds and tests finished
before sampling; no other audits or suites from this checkout overlapped them.
No background services were stopped or disabled.

- Node executable: `/Users/steve/.nvm/versions/node/v24.18.0/bin/node`, v24.18.0
  throughout; native Darwin 27.0.0 arm64, 14 logical CPUs.
- Candidate source: `7df7f69765979848e76f0fc42b36f3cab9da64e6`, freshly built
  with `pnpm build:cli`; SHA-256
  `f3791b9153056650d51469a5bb24a2378ef93eecefc32ba0325876edf2609f4d`.
- Baseline source: `95ec5577cd1fe057b35f35770d1d4e359d2087b0`; reuse of the
  retained pre-SDK source/archive from #1055, SHA-256 verified as
  `7fc7883ee4f3ab596094f01c57ce208cae30df8381ef0ce31146c9cb71b6d436`.
- Each audit repacked the same unchanged candidate build. All six candidate
  hashes match; all comparison baseline hashes match the pre-SDK archive, and
  each control baseline hash matches its candidate hash. This candidate differs
  from the earlier #1055 candidate and is labelled separately.
- Each build starts 30 fresh processes against the same empty file-tracker
  project. Pair order alternates AB, BA, AB, BA, giving each build 15 first
  positions. Every startup/RSS sample and chronological timeline is retained.
- Startup allowance remains `max(10 ms, baseline p95 * 0.05)`; p95 is sorted
  observation 29 of 30. Median RSS growth must be at most 5 MiB, and every
  synchronous offer p95 must be strictly below 1 ms. No outlier filtering or
  averaging replaces an individual gate. Gate failures still write the report
  and return nonzero; all new audits happened to pass.

The unmodified driver command, run from `packages/cli`, was:

```sh
node scripts/otlp-package-audit.mjs <baseline.tgz> <external-report.json> <baseline-source> <baseline-sha> --production-cli
```

Controls substitute the prepacked candidate tarball and current source/SHA as
baseline input/metadata. Full commands, protocol, logs, exits, reports, source
report hashes and start/end observations are committed in the evidence JSON;
external originals remain under `/var/folders/vm/tn1q05bx5hxffc9f6v6p_1pc0000gn/T/symphony-1084.9NITDM/series`.

## Native macOS results

Rows preserve execution order. Times are rounded to three decimals for display;
gates use the unrounded values. RSS and offer gates pass in every row.

| Run          | Baseline / candidate median ms | Baseline / candidate p95 ms | p95 delta ms | Exit |
| ------------ | ------------------------------ | --------------------------- | ------------ | ---- |
| comparison-1 | 152.961 / 155.158              | 170.833 / 167.176           | -3.657       | 0    |
| control-1    | 150.401 / 151.520              | 167.115 / 164.517           | -2.598       | 0    |
| comparison-2 | 150.160 / 152.155              | 157.187 / 166.775           | +9.589       | 0    |
| control-2    | 157.112 / 156.253              | 215.283 / 171.991           | -43.292      | 0    |
| comparison-3 | 166.457 / 165.970              | 190.350 / 187.815           | -2.535       | 0    |
| control-3    | 156.963 / 156.900              | 165.945 / 164.280           | -1.665       | 0    |

No identical-artifact control failed in this series. That does not establish a
zero noise floor: control 2 has a -43.292 ms p95 delta between identical artifacts.
The approved gate is directional and remains unchanged; the baseline tail was
slower in that control. Its observations remain intact. The previously failed
+17.390 ms identical-artifact control remains in the historical evidence as a
finding about ordinary/shared-host gate sensitivity, without a waiver.

Candidate median deltas in the three comparisons are +2.197, +1.995 and -0.487 ms;
p95 deltas are -3.657, +9.589 and -2.535 ms. Comparison 2 passes by only 0.411 ms.
There is no persistent candidate-only slowdown across this declared series, so
the predeclared profiling condition did not trigger and no diagnostic CPU
profiles were collected. These six audits cannot exclude a smaller runtime cost
or establish causation for earlier failures. Profiling remains required if a
persistent candidate-only slowdown appears in a future controlled series.

## Ordinary-host observations

Host observations were taken immediately before and after each complete audit,
outside measured intervals. CPU idle below is the second `top` observation;
both observations are retained. Load is the one-minute average from `uptime`.

| Run          | Load before / after | CPU idle % before / after |
| ------------ | ------------------- | ------------------------- |
| comparison-1 | 3.74 / 5.42         | 89.33 / 93.7              |
| control-1    | 5.42 / 7.63         | 82.92 / 92.67             |
| comparison-2 | 7.26 / 7.21         | 91.25 / 72.62             |
| control-2    | 7.21 / 7.73         | 73.45 / 69.78             |
| comparison-3 | 7.73 / 9.52         | 70.51 / 72.72             |
| control-3    | 9.52 / 9.16         | 72.54 / 72.33             |

Every snapshot reports AC power, battery 100%, and no recorded thermal or
performance warning. These are boundary observations, not continuous thermal
telemetry. Swap use remained 12028 MiB of 13312 MiB; `memory_pressure -Q` reported
56–57% system-wide memory free. Raw `vm_stat` counters, both `top` observations,
and swap/power output are retained for each boundary. No requested command
reported an error. These metrics do not rule out transient scheduling/I/O stalls.

Notable concurrent workloads in the retained process-name snapshots include
Docker Desktop and its VM/backend, Safari/WebKit, WindowServer, Claude and other
Node/development processes, ChatGPT, Figma and Chrome. Process arguments and
environment variables were not collected. These ordinary workloads were left
running; their presence alone does not attribute any sample's duration.

## Historical native macOS and independent Linux evidence

The [2026-10-17 investigation](2026-10-17-otlp-startup-variance.md) and its
[retained evidence](2026-10-17-otlp-startup-evidence.json) remain authoritative for
the earlier series. No historical sample or gate was modified.

| Platform / retained run                   | Baseline / candidate p95 ms | p95 delta ms | Exit |
| ----------------------------------------- | --------------------------- | ------------ | ---- |
| Native macOS original                     | 357.729 / 416.249           | +58.520      | 1    |
| Native macOS isolated retry               | 193.903 / 210.678           | +16.775      | 1    |
| Native macOS identical-artifact control 1 | 187.073 / 204.464           | +17.390      | 1    |
| Linux/container comparison 3              | 86.169 / 96.824             | +10.655      | 1    |

Linux is reported independently: the retained Linux 6.12.76-linuxkit arm64 series
used Node v24.22.0 inside a Docker VM on the same physical Mac, versus native
Node v24.18.0 here. Its candidate was
`c8b86bc7e9d1fe49d78634f6db6e0e57c56b0617`, tarball hash
`2cc1870ffbf4c74a34032de26471e4784bcfda54651a6b8eaa31b48c2038b76d`;
its baseline hash matches the pre-SDK baseline above. It was a different
candidate/platform/Node combination, not a replication of this new native
series or independent hardware. Linux comparison-3 exceeds its 10 ms startup
allowance by 0.655 ms and remains failed. No new Linux audit was performed for
this native-host series, and absolute durations are not compared across OSes.
Passing native results cannot clear Linux failure, and Linux results cannot
clear historical native failures.

## Verification and requirement coverage

- Ordinary-host procedure: updated in
  [packages/cli/README.md](../../packages/cli/README.md#startup-repeatability-on-shared-hosts)
  per the owner override, with before/after load, CPU idle, memory/swap,
  power/thermal and concurrent-workload observations for every run.
- Predeclaration, fixed artifacts/Node, interleaving, independent controls and
  complete retention: protocol and all six complete reports in the companion
  evidence, including all offer/tick measurements and reached-assertion logs.
- Integrity TCs: recompute medians/p95/RSS and all gates from raw observations;
  verify 30 samples/build, all 60 timeline entries and order, matching hashes,
  Node/OS, exit codes and package-audit assertion reachability. All passed.
- Negative TCs: deleting a timeline entry, deleting a startup sample, changing
  a control hash and relabelling a computed startup gate were each rejected.
  These validate evidence integrity; they do not change the audit's gates.
- Persistent slowdown: not observed across all comparisons; profiling condition
  not triggered. Separate Linux reporting and all retained failures appear above.
- Release decision: **activation off**, no waiver. Runtime/configuration and the
  upstream spec remain unchanged. This is a documentation/evidence change with
  no integration behavior change; Docker E2E is not applicable.
