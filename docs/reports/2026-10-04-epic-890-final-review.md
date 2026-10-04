# Epic #890 final reliability and maintainability review

- Date: 2026-10-04
- Status: Final documentation closeout; validation results below
- Epic: [#890](https://github.com/hojinzs/github-symphony/issues/890)
- Project: [GitHub Symphony #14](https://github.com/users/hojinzs/projects/14)
- Source revision: `dcfcaffc00925082bd7d98e3b2a7e00438ec4b4c` (latest `origin/main` at audit start)
- Symphony Layers: Configuration, Coordination, Execution, Integration, Observability; cross-layer verification. Policy hook ownership is a preserved boundary.
- Change classification: documentation only, spanning Configuration/Execution boundary descriptions and Observability evidence. No runtime, CLI, package, or configuration behavior changes.

## Decision

The eight approved implementation slices are present on main. No residual code
change was identified within this Epic. The remaining work is documentation
closeout: resolve the original review status and index, mark the implemented
extraction scope Shipped, index the benchmark and this audit, and correct living
documentation that still describes the removed instance registry, bare cache,
and worktree population. The original review and design bodies remain historical
snapshots; only their status headers change.

At inspection, the Epic remained OPEN and project status was In progress. The
native sub-issue API returned exactly #891–#898, each closed with
`state_reason=completed`. Every associated PR below is MERGED, approved by
`hojinzs`, and its merge commit is an ancestor of the audited main. These facts
establish provenance; completion also depends on the source and fresh validation
below, rather than issue state alone.

## Completion evidence

Paths refer to the audited revision. All rows include implementation, verification,
fulfillment, and residual work. The test cases below exercise the combined current
implementation, including changes that landed after individual children.

| Child / finding                                                   | Implementation and completion criteria                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Verification evidence                                                                                                                                                                                                                                                                                                                                                                             | Fulfillment / remaining work                                                                                                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#891](https://github.com/hojinzs/github-symphony/issues/891), R1 | `.github/workflows/ci.yml`, `package.json`, root and package Vitest configs. PR CI's Test job fails on the package-aware test contract, including all three control-plane TSX files. Built-worker startup, package-entrypoint, and container checks remain.                                                                                                                                                                                                                                                               | [#964](https://github.com/hojinzs/github-symphony/pull/964), merge `106e3108`; TC-01/02/06 below. Package setup is loaded through projects; root `fileParallelism: false` preserves orchestrator serialization.                                                                                                                                                                                   | Met through the approved #892 replacement, rather than retaining duplicate test executions. No code remainder.                                                                                               |
| [#892](https://github.com/hojinzs/github-symphony/issues/892), R1 | `vitest.config.ts` loads `packages/*` projects, preserving roots, aliases, setup and defines. `scripts/verify-coverage-discovery.mjs` compares normalized discovery and runs the two-file exclusive-lock serialization probe. `scripts/verify-coverage-report.mjs` requires covered frontend source. Shared source is attributed in one Vitest/V8 aggregate, not overwritten recursive reports. CI uploads the complete `coverage/` directory with `if: always()`.                                                        | [#971](https://github.com/hojinzs/github-symphony/pull/971), merge `8f823a74`; TC-01/02/06. Inspect `coverage-final.json` and `coverage-summary.json` after the single aggregate run.                                                                                                                                                                                                             | Met. CI uses `pnpm test:coverage`; local `pnpm test` remains authoritative. No code remainder.                                                                                                               |
| [#893](https://github.com/hojinzs/github-symphony/issues/893), R4 | `packages/tracker-linear/src/orchestrator-adapter.ts` catches only `LinearRecordValidationError` for state lists; `id-refresh` rethrows. It retains at most 50 sanitized samples plus the complete count and rate limits through pickup-label filtering. Unexpected normalization, auth, transport, GraphQL and pagination failures remain atomic. Empty inputs avoid requests; optional fields retain fallback behavior. Service isolates failed supplemental refreshes and retains unresolved ID/identifier identities. | [#970](https://github.com/hojinzs/github-symphony/pull/970), merge `72e63ddd`; `tracker-linear.test.ts` mixed/all-invalid, label metadata, unexpected failure, paging/maxPages/missing cursor, empty input, strict malformed refresh and optional-blocker cases; `service.test.ts` supplemental refresh and startup diagnostic cases; TC-03.                                                      | Met. `docs/trackers/linear.md` and the architecture §17 matrix match shipped semantics. No live Linear call is needed for malformed fixture acceptance.                                                      |
| [#894](https://github.com/hojinzs/github-symphony/issues/894), R3 | `history-benchmark.ts`, `history-benchmark-cli.ts` and the dated [baseline report](2026-09-14-run-history-polling-cost.md). Isolated temporary fixtures contain 100/1,000/10,000 historical runs plus identical active work in legacy/shared layouts, with atomic concurrent updates. JSON-boundary observation counts inventory and per-run reads; elapsed/CPU/RSS are descriptive. Cleanup uses `finally`; tick writes are suppressed to preserve layout/update evidence.                                               | [#969](https://github.com/hojinzs/github-symphony/pull/969), merge `37916e28`; `fs-store.test.ts` fixture/read-accounting/update/cleanup regressions; TC-04/05 and fresh matrix below.                                                                                                                                                                                                            | Met. Production latency and cold-cache distributions remain outside this benchmark's claim and outside Epic closure requirements.                                                                            |
| [#895](https://github.com/hojinzs/github-symphony/issues/895), R3 | Core `contracts/state-store.ts` exposes `loadRuns({ projectId })` while retaining `loadAllRuns()`. `fs-store.ts` reads the encoded target project directory plus legacy flat records, filters authoritative JSON project IDs, prefers scoped duplicates and caps reads at eight for both APIs. It neither rewrites nor deletes history.                                                                                                                                                                                   | [#978](https://github.com/hojinzs/github-symphony/pull/978), merge `8f24f855`; `fs-store.test.ts` scoped/legacy identity and duplicate precedence, encoded IDs, eight concurrent reads for scoped/global paths; TC-04.                                                                                                                                                                            | Met. The flat legacy compatibility scan still reads other projects' legacy JSON to determine identity; unrelated scoped project directories are avoided. No index, schema migration or database is required. |
| [#896](https://github.com/hojinzs/github-symphony/issues/896), R3 | `service.ts` takes one scoped history inventory and refreshes known active/current IDs after reconciliation, before candidates, after suppression/pre-cleanup, and before final status. Terminal cleanup consumes scoped evidence and freshly checks identity-aware live candidates. History still feeds cumulative tokens and publication/recovery protection; absent legacy scoped lookups retain inventory evidence.                                                                                                   | [#981](https://github.com/hojinzs/github-symphony/pull/981), merge `dcfcaffc`; `fs-store.test.ts` observes one inventory/eight reads for the three-record fixture; `service.test.ts` fresh token snapshot, no global scan, retry/recovery and terminal publication/dirty-workspace sentinel rows; core `snapshot-builder.test.ts` history token totals and cumulative retry runtime; TC-04/05/07. | Met against the approved 10,006-read result, 40,000 fewer reads than baseline. Four freshness boundaries protect same-tick publication evidence. No code remainder.                                          |
| [#897](https://github.com/hojinzs/github-symphony/issues/897), R2 | [Extraction scope](../designs/2026-09-14-orchestrator-extraction-scope.md) maps retain/extract/remove responsibilities, layers, invariants, dependencies and non-goals after #847/#844/#879. Hooks own population; the façade owns effects and separate queues; existing safety divergences remain explicit.                                                                                                                                                                                                              | [#965](https://github.com/hojinzs/github-symphony/pull/965), merge `41afaad9`, human approval; source/design comparison and TC-08. Subsequent approved [#973](https://github.com/hojinzs/github-symphony/pull/973) implements the selected scope.                                                                                                                                                 | Met. This closeout corrects the stale Draft header/index to Shipped. The historical design body is preserved.                                                                                                |
| [#898](https://github.com/hojinzs/github-symphony/issues/898), R2 | `retained-decisions.ts` contains explicitly typed pure finalization and retry plan/resolve functions. `service.ts` retains writes, clocks/policy loading, events, queue ownership and effects. Restart eligibility, reservation ordering and capacity remain established façade/helpers, as permitted by Q8's bounded scope.                                                                                                                                                                                              | [#973](https://github.com/hojinzs/github-symphony/pull/973), merge `1b13420c`; 14 focused decision cases plus façade regressions for below-bound running claims, exhausted deferrals, suppression, advanced attempts, five requeue delay outcomes, retained due times, capacity/order, recovery budget and event/schema behavior; TC-04.                                                          | Met. No whole-service helper input or new mutable collaborator; reconciliation and tracker-state queues remain separate. No code remainder.                                                                  |

Two older #893 follow-ups are also resolved on current main: #972 was closed
as a duplicate of #966, whose [#968](https://github.com/hojinzs/github-symphony/pull/968)
fixed the Docker `jq` prerequisite and the end-to-end standalone runner;
[#976](https://github.com/hojinzs/github-symphony/pull/976) fixed #974's omitted-total/rendering bounds. The current
Docker runner passes, and current adapter/service tests verify complete skip
totals and bounded rendered diagnostics. Neither is an outstanding blocker.

All original child PRs show successful Test and Container Smoke checks on their
recorded heads. #981 also shows successful Standalone Docker E2E. Check results
were read from GitHub PR metadata; fresh source validation is recorded separately
below. A failing CI job is the contract under review; this audit does not change
repository branch-protection or required-check settings.

## Approved changes to the original plan

1. #891's transitional `pnpm test` CI step was replaced by the approved #892
   aggregate execution only after normalized discovery, package configuration,
   behavioral serialization and frontend coverage parity were proved. Restoring
   two full suite executions would contradict that approved consolidation.
2. #894 proposed 10,002 reads at 10,000 history. #896 review required fresh
   post-suppression publication evidence, then reconciliation with #977's live
   terminal-worker cleanup protection. The approved final implementation uses
   10,006 reads. See [#896 Cycle 3 evidence](https://github.com/hojinzs/github-symphony/issues/896#issuecomment-5678801031)
   and the approved/merged #981. The extra reads protect correctness; they do
   not restore history amplification. The original 10,002 target is not an
   undisclosed failed gate.
3. The original R2 report suggested later effectful workspace/reconciliation
   collaborators. #897/#898 approved only retained pure finalization and retry
   decisions for this Epic. Existing reservation/capacity helpers remain;
   no later effect extraction is required to close #890.
4. #847 is completed. Its hook-owned population and removal of repo-embedded
   mode, registry, cache management, credential broker, quarantine/attribution
   and orchestrator-authored comments govern the current design. Old plans and
   reports are historical evidence, not authorization to restore those systems.

## Residual documentation corrected

- Original reliability report status and `docs/README.md`: Resolved with a link
  to #890 and this completion evidence; report body unchanged.
- Extraction design status and index: Shipped, with approved design and
  implementation PR links; design body unchanged.
- `README.md` and `packages/cli/README.md`: diagnostic selection now matches
  `inspectManagedProjectSelection`: explicit selection, cached cwd, sole
  configured project, otherwise selection required. Removed registry and legacy
  `activeProject` fallback claims.
- `AGENT_TEST.md`: describes hook-populated full clones and the runner's current
  recovery/publication checks, calls issue directories workspaces, and removes
  the deleted cache-maintenance scenario from the living scenario table.
- `docs/architecture.md`, `docs/configuration.md` and the Linear profile already
  reflect the current store/freshness, hook, credential and provider boundaries;
  no behavior or package mapping changed in this closeout.

## Test cases and fresh verification

These are audit TCs added for this documentation closeout; existing meaningful
production regressions are reused rather than adding tests that mirror prose.

| TC    | Procedure and expected result                                                                                                                                                                                                                           | Result                                                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| TC-01 | Run `pnpm test`; verify all package scripts including all three TSX files. Run `pnpm test:coverage`; normalized package/aggregate file sets must match, setup/serialization probe must pass, and aggregate frontend statements must be covered.         | Pass                                                   |
| TC-02 | Create a temporary failing `.test.tsx` sentinel in control-plane frontend; run CI-equivalent `pnpm test:coverage`. Expect nonzero and the sentinel assertion failure, then remove the sentinel in `finally`.                                            | Pass                                                   |
| TC-03 | Full Linear adapter and service regressions: valid candidates survive malformed state-list records, diagnostics/filter metadata persist, requested IDs and unexpected/paging failures reject atomically.                                                | Pass                                                   |
| TC-04 | Full fs-store, service, retained-decision, dispatch and snapshot regressions: scoped/legacy inventory and eight-way I/O bound, fresh tokens, cumulative totals, retry capacity/order/budget, deferred claims, recovery and unpublished-work protection. | Pass                                                   |
| TC-05 | Re-run `benchmark:history`; all 12 cells must retain fixture identity and cleanup, one tick inventory and history+6 reads. Compare deterministic counts with baseline; do not assert machine timing.                                                    | Pass                                                   |
| TC-06 | Run built-worker startup, CLI package entrypoint, Compose-project and fixture-replacement helper tests.                                                                                                                                                 | Pass                                                   |
| TC-07 | Run `./e2e/run-standalone-project-e2e.sh`; require status 0 and final confirmation. If preflight alone exits 69 for unavailable Docker, record the allowed environment limitation without a new issue.                                                  | Pass: status 0; `standalone-project Docker E2E passed` |
| TC-08 | Verify relative document links, historical body preservation, current selector implementation, shipped design/index statuses, clean diff and unchanged upstream spec.                                                                                   | Pass                                                   |

- `pnpm install --frozen-lockfile` — pass. The first lint attempt preceded dependency installation and failed with missing `eslint`; the installed-checkout rerun passed.
- `pnpm lint`, `pnpm build`, `pnpm test`, `pnpm typecheck` — pass. All 14 tested workspace packages; 138 files / 2,037 tests (orchestrator 392, Linear 52, control-plane 38 including three TSX files).
- `pnpm test:coverage` — pass: normalized discovery matches 138 files; behavioral serialization probe passes; 2,037 tests; 17 frontend files / 721 covered statements. One nonempty aggregate JSON report contains shared-source attribution.
- `pnpm test:worker-startup` — pass, 10 tests.
- `pnpm --filter @gh-symphony/cli test:package` — pass, packaged runtime entrypoint smoke tests.
- `pnpm e2e:compose-project-test`, `pnpm e2e:fixture-replacement-test` — pass.
- `./e2e/run-standalone-project-e2e.sh` — pass with final marker; Docker was available, so no status-69 exception was used.
- Benchmark matrix — pass, all 12 cells; read counts and one inventory per tick reproduced.
- TSX negative control — expected status 1: only `epic-890-sentinel.test.tsx` failed; the other 138 files / 2,037 tests passed. Temporary sentinel removed in `finally`; the restored clean coverage suite passed again (138 files / 2,037 tests).
- Relative links in the index/audit, original report/design body preservation and unchanged upstream spec — pass. `git diff --check` — pass. Whole-repository `pnpm format` passed after removing the intentionally unformatted temporary sentinel.

## Fresh benchmark matrix

Command: `pnpm --silent --filter @gh-symphony/orchestrator benchmark:history`.
Node v24.18.0, Darwin arm64; one warm-cache sample per cell, with identical
fixtures and measurement boundaries from the baseline report. Full test/build
and Docker work overlapped this local measurement, so elapsed and resource
values include host contention and are not a controlled latency comparison.

| History | Layout | Scenario     |  Reads | Inventories | Elapsed ms | User CPU ms | System CPU ms | Max RSS delta KiB |
| ------: | ------ | ------------ | -----: | ----------: | ---------: | ----------: | ------------: | ----------------: |
|     100 | legacy | inventory    |    101 |           1 |       2.35 |        2.16 |          4.63 |               720 |
|     100 | legacy | polling-tick |    106 |           1 |     867.39 |       66.51 |         63.28 |             5,712 |
|     100 | shared | inventory    |    101 |           1 |       2.04 |        2.49 |          3.00 |               144 |
|     100 | shared | polling-tick |    106 |           1 |     935.30 |       55.50 |         63.77 |               704 |
|   1,000 | legacy | inventory    |  1,001 |           1 |      20.33 |       24.70 |         41.15 |             7,552 |
|   1,000 | legacy | polling-tick |  1,006 |           1 |   8,040.36 |      435.07 |        572.71 |            20,096 |
|   1,000 | shared | inventory    |  1,001 |           1 |      14.65 |       13.66 |         26.01 |             1,264 |
|   1,000 | shared | polling-tick |  1,006 |           1 |   7,950.01 |      403.36 |        558.60 |               992 |
|  10,000 | legacy | inventory    | 10,001 |           1 |     448.49 |      204.79 |        798.89 |             9,248 |
|  10,000 | legacy | polling-tick | 10,006 |           1 |  82,077.25 |    3,945.61 |      6,133.64 |            23,840 |
|  10,000 | shared | inventory    | 10,001 |           1 |     172.91 |      173.61 |        401.43 |               240 |
|  10,000 | shared | polling-tick | 10,006 |           1 |  82,183.85 |    4,002.34 |      5,838.01 |             4,288 |

Both 10,000-history ticks read 10,006 records versus 50,006 in the baseline:
40,000 fewer, or 79.99%. The deterministic improvement is reproduced. Today's
82-second ticks do not establish a latency improvement over the original
76.84/86.78-second samples. Earlier approved #896 measurements recorded the
latency comparison; timing remains host-dependent, dominated by per-record
non-inventory reconciliation work, and is never a unit-test threshold. The
fixture excludes run-record persistence and production network/provider costs;
RSS is the process-wide high-water delta, not per-cell retained memory.

## Spec conformance and operator closeout

The reviewed slices preserve upstream §§3.2, 8, 9, 11.1–11.3, 13 and 17.
Recognized state-list omission is permitted; requested-ID malformed records still
fail. Repository population remains hook-owned. Provider payloads and credentials
remain adapter-owned; pure decisions consume normalized facts. Cumulative metrics,
retry effects and queue separation are preserved. No upstream-spec file was edited.

No new intentional divergence is introduced. Existing restart-persistent scheduler
state (§14.3), retry reservations, unpublished-work retention (§8.6), recovery
workspace routing, hook repository-subdirectory cwd (§9.4), workflow polling and
credential safety backstop remain repository choices documented in the architecture
and are preserved, not silently normalized to upstream behavior.

After this PR is reviewed and merged, the operator can finish #890: link the merged
closeout PR/commit in a final Epic comment summarizing R1–R4, reconcile the completion
checkboxes, and mark the project completed. This PR uses `Closes #890` only after the audited criteria pass; GitHub will close the Epic when the operator merges it. This audit does not close the issue,
change project status, or merge the PR. Production latency monitoring is a separate
operational activity; live Linear sandbox checks were not run for these mocked
malformed-record semantics. Current-head PR CI must also pass before merge.
