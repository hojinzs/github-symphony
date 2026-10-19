# OTLP ordinary-host release acceptance (#1084)

Status: **activation approved** under the revised owner policy; actual runtime
default remains off in this PR. Updated 2026-10-19T04:30:16Z.
Delivery: [PR #1091](https://github.com/hojinzs/github-symphony/pull/1091).

Symphony Layers: Policy, Observability and Execution (release audit boundaries).

## Decision and scope

The owner revised release acceptance in
[PR #1091 review](https://github.com/hojinzs/github-symphony/pull/1091):
evaluate the latest complete predeclared current-candidate series per platform.
Startup now uses median delta ≤ `max(10 ms, 5% baseline median)`; at least two
of three comparisons must pass and none may exceed twice its allowance.
RSS median growth ≤ 5 MiB and each offer p95 < 1 ms remain per-comparison
hard gates. Identical controls must pass. p95 startup remains informational,
with a flag when a comparison delta exceeds the largest absolute control delta.

This is an explicit owner-approved repository release-policy revision, not a
waiver or an upstream-spec rewrite. It supersedes this issue's original
unchanged-threshold requirement. The original ordinary-host procedure and
AB/BA samples remain intact; no service was stopped. There is no intentional
divergence from the Symphony specification and no runtime/default flip.

The original native JSON and earlier investigation JSON are immutable historical
evidence. Their embedded descriptions, validator and gate booleans record the
policy and claims at collection time. **Correction:** native offer records retain
only sample count and derived p95, not raw offer timings. The historical integrity
validator recomputes startup/RSS summaries; it checks reported offer p95 against
the threshold but cannot recompute it or detect filtered offer observations.
Earlier claims of retaining every offer measurement/recomputing every gate were
too broad. The new Linux driver retains raw offer timings and verifies them.

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
- At collection time, startup allowance was `max(10 ms, baseline p95 * 0.05)`; p95 is sorted
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
The historical p95 gate was directional; the baseline tail was
slower in that control. Its observations remain intact. Under the revised median rule all six rows pass;
all comparison allowances are 10 ms, the control noise floor is 43.292 ms,
and no comparison has an informational p95 flag. The previously failed
+17.390 ms identical-artifact control remains in the historical evidence as a
finding about ordinary/shared-host gate sensitivity. It is superseded by a later
series on a different candidate under the explicit revised policy, without
changing its samples, exit or original gate.

Candidate median deltas in the three comparisons are +2.197, +1.995 and -0.487 ms;
p95 deltas are -3.657, +9.589 and -2.535 ms. Under the historical p95 rule, comparison 2 passed by only 0.411 ms;
under the revised median rule its margin is 8.005 ms.
There is no persistent candidate-only slowdown across this declared series, so
the predeclared profiling condition did not trigger and no diagnostic CPU
profiles were collected during the native series. These six audits cannot exclude a smaller runtime cost
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
series or independent hardware. The retained Linux comparison-3 exceeded its historical 10 ms p95 allowance
by 0.655 ms, and its original failure/exit remains unchanged. All four historical
failures in the table are now labelled **superseded by a later series on a
different candidate** under the explicit owner policy. They are not relabelled
as passes. The current native and Linux series are evaluated independently;
absolute durations are not compared across OSes.

## New independent Linux/container series

The [policy evidence JSON](2026-10-19-otlp-release-policy-evidence.json) retains
the protocol published in cycle 2 before sampling, all six reports/logs/exits,
all raw startup/RSS/offer samples and tick measurements, host/container boundary
snapshots, evaluator output, validator and negative-test output, and six raw
CPU profiles. No acceptance run was omitted or rerun; exits were 0/0/0/0/0/0.

The current acceptance candidate is the frozen macOS artifact above, not a fresh
build from the changing documentation branch. Its extracted package repacked on
Linux with exactly the same SHA-256. The revised audit driver is from
`1bb3f5060c667fec9debd3e34d251beef12bef88`; audit scripts are outside packed
files. All six candidate hashes match the macOS archive; comparisons retain the
same pre-SDK baseline and controls match the candidate hash. Neither source
runtime nor packed candidate code changed during sampling.

Linux uses `/usr/local/bin/node` v24.22.0 in a pinned Node Bookworm image with
git/procps added, on Linux 6.12.76-linuxkit arm64. Its immutable image ID and
Dockerfile are retained. This is a Docker VM on the same physical Mac, not
independent hardware or a macOS scheduling control. Native macOS remains Node
v24.18.0. No builds, test suites or native audits overlapped the Linux series;
no background service was stopped. Each audit uses the same 30-process AB/BA
counterbalance. Physical-host load/CPU idle/memory/swap/power/thermal and process
names, plus container load/CPU/memory/pressure, were recorded before and after
each run. Container power/thermal is explicitly unavailable; host observations
are boundary measurements, not continuous telemetry.

All RSS/offer gates pass. Each startup allowance is 10 ms; the 2× cap is 20 ms.
The largest absolute control p95 delta is 12.172 ms. Informational flags on
comparisons 1 and 2 are retained, without converting them into failing gates.

| Run          | Baseline / candidate median ms | Baseline / candidate p95 ms | Median delta ms | p95 delta ms | p95 flag | Exit |
| ------------ | ------------------------------ | --------------------------- | --------------- | ------------ | -------- | ---- |
| comparison-1 | 78.161 / 80.733                | 81.770 / 95.669             | +2.572          | +13.898      | yes      | 0    |
| control-1    | 80.383 / 79.550                | 84.825 / 96.996             | -0.832          | +12.172      | no       | 0    |
| comparison-2 | 78.682 / 81.402                | 86.211 / 102.541            | +2.720          | +16.330      | yes      | 0    |
| control-2    | 81.301 / 79.986                | 106.479 / 99.216            | -1.314          | -7.263       | no       | 0    |
| comparison-3 | 79.571 / 81.152                | 91.668 / 94.898             | +1.582          | +3.229       | no       | 0    |
| control-3    | 80.663 / 81.021                | 101.654 / 94.882            | +0.358          | -6.772       | no       | 0    |

Linux has three of three median startup passes and all controls pass. macOS
independently has three of three passes and all controls pass; no native p95
flags exceed its 43.292 ms noise floor. Thus **activation approved** under the
revised owner rule. This approval uses the retained native offer p95 summaries
with the explicit raw-data limitation above, not a claim to have reconstructed
missing timings. The actual default flip belongs in a separate issue/PR, with
any other release prerequisites reviewed there.

## Persistent slowdown profiling

All three Linux comparison median deltas are positive (+2.572/+2.720/+1.582 ms),
although within the 10 ms allowance. As a conservative follow-up to the issue's
profiling requirement, three separate CPU profiles per installed artifact were
collected after the entire acceptance series in AB/BA/AB order, using the same
Node/image and disabled single-reconciliation CLI command. All six exited 0.
These are diagnostic runs, not replacement acceptance samples.

Across three profiles, baseline/candidate sampled durations total
309.561/301.279 ms including idle time. ESM compilation self time is
23.534/27.790 ms, internal loader compilation 19.960/28.400 ms and LiquidJS
normalization 17.835/20.579 ms. The candidate's larger ESM bundle and loader work
are plausible contributors, but these coarse profiles do not establish a causal
2 ms regression: total sampled duration reverses direction and profiles include
startup instrumentation, scheduling and I/O. No forbidden SDK evaluation was
observed by the packed audit's disabled guard. No samples were excluded and no
threshold was relaxed in response to these results. The six profiles and full
top-function summaries are retained for review.

## Verification and requirement coverage

- Policy: median per-run gates and separate six-report evaluator implement the
  owner's explicit revision. 30 samples/build, AB/BA order, RSS/offer hard gates
  and nonzero per-run failure exits remain enforced.
- Native evidence: original JSON unchanged; revised evaluation is separate.
  Startup/RSS are independently recomputable; native offer raw timings are
  unavailable and the earlier retention/recomputation claims are corrected.
- Linux evidence: integrity checks recompute startup/RSS and all 1,000 raw offer
  timings per mode, verify 60 chronological entries, hashes, Node/OS, gates,
  exits, packed-audit assertion reachability and every host/container boundary.
- Negative TCs: missing/filtered raw offer samples, altered offer percentile,
  missing startup sample, wrong control hash and relabelled startup gate are
  all rejected. Script and output are embedded in the new evidence JSON.
- Historical failures: preserved byte-for-byte, separately labelled superseded
  by a later series on a different candidate; no waiver or sample filtering.
- Release decision: **activation approved**; actual runtime defaults unchanged.
  No orchestration integration behavior changed, so Docker lifecycle E2E is N/A;
  the six Linux Docker packed audits supply the requested platform evidence.
