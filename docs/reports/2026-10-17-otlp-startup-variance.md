# OTLP startup variance on shared macOS hosts (#1055)

Status: Investigation complete; release acceptance remains unresolved and is tracked
in [#1084](https://github.com/hojinzs/github-symphony/issues/1084); [ordinary-host follow-up](2026-10-19-otlp-release-acceptance.md) retains activation off.

Symphony Layers: Observability, Configuration, Execution (audit boundaries only).

Evidence collected on 2026-10-17. The [startup evidence](2026-10-17-otlp-startup-evidence.json)
retains every startup/RSS observation, summary, gate and exit from 15 new complete
audits and the two historical failing reports. No observations were removed.

## Finding and acceptance boundary

Run-to-run variation can exceed the approved startup allowance without a package
change: an identical-tarball macOS control failed at 187.073/204.464 ms p95.
Its baseline and candidate SHA-256 match. The same control passed twice more.
All three current-head macOS comparisons and all three rebuilt-original macOS
comparisons passed. The original failure is therefore not deterministic under
the conditions measured here.

This does **not** establish that scheduling caused either historical failure,
prove the absence of a small package regression, or clear activation. No scheduler
trace or dedicated idle-host experiment was collected. A separate Linux comparison
also failed. Every failed gate remains a failed gate; later passes do not replace
it. No threshold, sample count, runtime capability or exit behavior changes in
this investigation.

## Artifacts and method

- Pre-SDK baseline: `95ec5577cd1fe057b35f35770d1d4e359d2087b0`, rebuilt from
  `git archive` with `pnpm install --frozen-lockfile` and `pnpm build:cli`.
  Its tarball SHA-256 is
  `7fc7883ee4f3ab596094f01c57ce208cae30df8381ef0ce31146c9cb71b6d436`,
  identical to the original reports' baseline hash.
- Current candidate/audit: `c8b86bc7e9d1fe49d78634f6db6e0e57c56b0617`.
  Tarball SHA-256:
  `2cc1870ffbf4c74a34032de26471e4784bcfda54651a6b8eaa31b48c2038b76d`.
  This is a newer runtime than the originally reported head; its results are
  labelled separately.
- Original candidate/audit: rebuilt archive of
  `f045202fa40198e849257e7d8ea73b35617cdad3`, using its unmodified audit.
  That driver did not record candidate hashes or chronological host context;
  the report does not invent those fields or assert byte identity with the
  historical candidate tarball.
- Native host: macOS 27.0.1 (26A434), Darwin 27.0.0 arm64, Node v24.18.0,
  14 logical CPUs. Initial `pmset -g therm` reported no recorded thermal or
  performance warning; this is not continuous thermal monitoring. Other users
  and background work remained active. During current startup batches, one-minute
  load averages ranged about 5.8–8.7 and aggregate CPU idle deltas about 66–69%.
  Neither number rules out brief scheduling or I/O stalls.
- Each complete audit installs production dependencies outside the checkout,
  uses the same empty file-tracker project, and starts 30 fresh processes per
  build. Current audit order gives each build 15 first positions. The original
  audit always starts baseline first. All observations count, with p95 equal to
  the 29th sorted observation. Two slow samples can therefore move p95 sharply.
- Before starting, three comparisons alternating with three identical-candidate
  controls were declared for native macOS, then separately for Linux. An
  additional three original-head native repetitions were declared before its
  rebuild. No worker builds/tests or other worker audits overlapped sampling.
  These are artifact-controlled shared-host experiments, **not** idle-host
  acceptance measurements. No other users' processes were stopped.

From the candidate's `packages/cli`, each comparison used:

```sh
node scripts/otlp-package-audit.mjs <baseline.tgz> <distinct-external-report.json> <baseline-source> 95ec5577cd1fe057b35f35770d1d4e359d2087b0 --production-cli
```

Controls used a separately packed current candidate as the baseline input and
the current source directory/SHA as baseline metadata. Matching hashes verify
identical input artifacts. Current native and Linux series used the same tarballs;
each audit repacked the unchanged built candidate. Original-head repetitions ran
the command from its archive with its own original script, preserving its fixed
order. They do not isolate runtime changes from schedule changes.

The unchanged startup predicate is
`candidate.p95 - baseline.p95 <= max(10 ms, baseline.p95 * 0.05)`.
RSS allows at most 5 MiB median growth; every offer-mode p95 must be strictly below
1 ms. Tables round to three decimal places; gate decisions use the unrounded data.
RSS and offer gates passed in **every** report below. An audit exit of 1 in
these tables is a startup failure after all package behavior checks completed.

## Historical macOS failures (original reports)

| Run            | Baseline/candidate median ms | Baseline/candidate p95 ms | p95 delta ms | Exit |
| -------------- | ---------------------------- | ------------------------- | ------------ | ---- |
| Original       | 175.181 / 177.480            | 357.729 / 416.249         | +58.520      | 1    |
| Isolated retry | 167.518 / 168.778            | 193.903 / 210.678         | +16.775      | 1    |

The retained original arrays confirm coincident outliers at zero-based samples
8/9: baseline 357.729/483.218 ms and candidate 416.249/419.465 ms. This supports
a common disturbance hypothesis, but is not causal evidence. The retry's large
observations do not align in the same way. Its +16.775 ms delta still fails the
10 ms allowance and must not be discarded.

Source comparison also identifies two limitations already corrected by
[PR #1041](https://github.com/hojinzs/github-symphony/pull/1041): fixed baseline-first
ordering and eager status/diagnostic loading on project startup. The current
project handler imports status only for that subcommand, and HTTP/TLS probe
transports load only when probing. These are real startup-boundary changes,
not evidence that all earlier overhead was host noise. This issue adds evidence
and diagnostics rather than changing those runtime fixes again.

## Native macOS: current head, counterbalanced

Rows retain execution order. Controls compare the exact same candidate tarball.

| Run          | Baseline/candidate median ms | Baseline/candidate p95 ms | p95 delta ms | Exit  |
| ------------ | ---------------------------- | ------------------------- | ------------ | ----- |
| Comparison 1 | 158.962 / 160.114            | 189.173 / 183.152         | -6.021       | 0     |
| Control 1    | 171.441 / 169.894            | 187.073 / 204.464         | +17.390      | **1** |
| Comparison 2 | 157.190 / 159.201            | 177.171 / 174.629         | -2.541       | 0     |
| Control 2    | 162.311 / 160.945            | 179.951 / 171.411         | -8.540       | 0     |
| Comparison 3 | 157.569 / 159.222            | 175.096 / 183.218         | +8.122       | 0     |
| Control 3    | 159.088 / 160.151            | 170.266 / 173.472         | +3.207       | 0     |

The failed control establishes measurement variation without a package
difference. It does not make a failed baseline/candidate audit acceptable.
Three comparisons are too few to exclude a smaller systematic regression.
Across all nine fresh baseline/candidate comparisons (including original-head
and Linux series), candidate medians are consistently about 1.15–2.63 ms higher.
That is compatible with a small real startup cost alongside tail variation;
these experiments do not attribute that cost to OTLP alone. Median differences
are diagnostic observations, not a replacement for the approved p95 gate.

## Native macOS: rebuilt original head, original fixed order

| Run          | Baseline/candidate median ms | Baseline/candidate p95 ms | p95 delta ms | Exit |
| ------------ | ---------------------------- | ------------------------- | ------------ | ---- |
| Repetition 1 | 160.945 / 162.122            | 177.289 / 181.841         | +4.552       | 0    |
| Repetition 2 | 159.033 / 161.662            | 171.183 / 172.406         | +1.224       | 0    |
| Repetition 3 | 170.982 / 173.203            | 192.281 / 192.236         | -0.045       | 0    |

These repeat the original source and method, but cannot recreate historical
host scheduling, OS patch state or the unrecorded historical candidate hash.
They are additional observations, not replacements for the two historical
failures.

## Linux/container: current head, counterbalanced

Docker prerequisite preflight passed. Container image:
`node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`
(`node:24-bookworm-slim` at execution), with Git and CA certificates installed
before sampling. Actual runtime: Node v24.22.0, Linux 6.12.76-linuxkit arm64.
This is a Docker Linux VM on the same physical host, **not** independent hardware
or native macOS evidence. No native measurement overlapped it. Node versions
differ, so absolute durations are not compared across operating systems.

| Run          | Baseline/candidate median ms | Baseline/candidate p95 ms | p95 delta ms | Exit  |
| ------------ | ---------------------------- | ------------------------- | ------------ | ----- |
| Comparison 1 | 97.947 / 99.715              | 144.843 / 137.871         | -6.972       | 0     |
| Control 1    | 80.751 / 80.543              | 94.987 / 87.633           | -7.355       | 0     |
| Comparison 2 | 79.265 / 81.268              | 92.809 / 96.025           | +3.216       | 0     |
| Control 2    | 92.661 / 92.325              | 108.179 / 100.205         | -7.974       | 0     |
| Comparison 3 | 78.920 / 81.502              | 86.169 / 96.824           | +10.655      | **1** |
| Control 3    | 80.072 / 79.504              | 83.232 / 82.260           | -0.972       | 0     |

Comparison 3 exceeds the 10 ms allowance by 0.655 ms. It remains a failure.
Passing controls do not establish whether this is candidate work or incidental
variation. Linux evidence cannot clear a macOS failure, and this Linux set does
not supply unqualified Linux activation acceptance either.

## Reusable diagnostics and validation

The audit now records chronological pair/position/start timestamps, elapsed
durations, candidate hash and host snapshots immediately before/after startup
sampling. Snapshots contain load, memory, CPU model/count and aggregate CPU time
counters, without process command lines, hostnames or environment data. Snapshot
collection is outside the measured interval. None of these fields filters a
sample or participates in a gate decision. The existing final assertion still
writes the report before returning nonzero on any performance failure.

The [repeatability procedure](../../packages/cli/README.md#startup-repeatability-on-shared-hosts)
requires predeclared repetitions, matching-hash controls, retention of every
exit/report, and separate OS reporting. A quieter native-host series is the
remaining **release acceptance** requirement; this investigation does not grant
a waiver. Persistent candidate-only slowdown under controlled conditions still
requires profiling. Never average away a failing run, select only passes, remove
outliers, inflate the baseline or change thresholds to obtain acceptance.

Evidence integrity checks recomputed every median/p95 and all three gates from
the retained observations, checked 30 samples per build, matched each exit,
verified each current 60-entry timeline against its samples/order and 15 first
positions per build, and verified control hashes. All checks passed. Deleting a
timeline entry was rejected; changing the failed macOS control's gate to true
was also rejected. The committed JSON is a startup-focused projection; it omits
loaded-module lists and reconciliation tick arrays, and records the SHA-256 of
each full source report. Full reports/logs/protocols remain in the external
evidence directory recorded in the issue workpad. Historical exits come from
the issue's recorded command outcomes; new exits come from retained wrapper logs.

The new host-context unit test fails when per-CPU summation is replaced with the
last CPU's counters, then passes after restoration. Existing threshold tests
remain unchanged. This is an audit/reporting change within upstream Symphony
observability expectations, with no intentional specification divergence.
