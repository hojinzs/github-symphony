# Reliability and maintainability review

- Date: 2026-09-05
- Status: Review complete; recommendations proposed, implementation not started
- Source revision: `19778b9ff69573b13827a988f59ee2648fb4fb07`
- Symphony Layers: Configuration, Coordination, Execution, Integration, Observability; cross-layer test infrastructure
- Scope: Four findings from the initial repository analysis. No runtime, configuration, dependency, or upstream-spec changes are included.
- Evidence: Local source inspection, test discovery, isolated diagnostic tests, and the repository unit suite. No production workload measurements or live tracker calls.

## Decision summary

Address the CI test-path mismatch first, then isolate malformed Linear list records. Measure historical-run read cost before changing storage architecture. Extract orchestrator responsibilities incrementally after the test baseline is consistent.

| Finding | Classification | Impact | Recommended action | Relative change risk |
| --- | --- | --- | --- | --- |
| R1: CI and package test execution differ | Confirmed verification gap | Three React test files are excluded; package setup and execution settings are bypassed | Make package-aware execution authoritative in CI, then consolidate coverage | Low for the CI gate; medium for coverage migration |
| R2: Orchestrator responsibility concentration | Confirmed maintainability concern, not a reproduced runtime defect | State, process, tracker, workspace, and retry changes are difficult to isolate | Extract pure decisions first, then small effect-owning collaborators | Medium; high for a wholesale rewrite |
| R3: Repeated full run-history reads | Confirmed access pattern; production performance impact unmeasured | Work per tick grows with retained history, including unrelated projects in shared/legacy layouts | Establish a baseline, add project-scoped bounded reads, then optimize measured hot paths | Medium; high for a new persistent index or database |
| R4: Linear malformed-record blast radius | Reproduced availability limitation | One invalid list record prevents otherwise valid candidates from being returned | Tolerant state-list normalization with diagnostics; strict ID refresh | Low to medium |

These priorities reflect certainty and breadth of impact, not measured incident frequency. If Linear is unused, R4 can follow the storage baseline. If a deployment already has measured polling delays, advance R3 ahead of structural extraction.

## R1: CI does not run the same test contract as package tests

### Evidence and failure scenario

[The CI workflow](../../.github/workflows/ci.yml) executes `npx vitest run --coverage.enabled --coverage.reporter=json-summary --coverage.reporter=json` from the repository root. [The root configuration](../../vitest.config.ts) includes only `**/*.test.ts`.

Actual discovery on the reviewed revision:

| Control-plane test file | Root discovery | Package discovery |
| --- | --- | --- |
| `src/server.test.ts` | Included | Included |
| `client/src/lib/api.test.ts` | Included | Included |
| `client/src/issueDetail.test.tsx` | Excluded | Included |
| `client/src/components/components.test.tsx` | Excluded | Included |
| `client/src/routes/-index.test.tsx` | Excluded | Included |

The excluded files contain 17 tests for rendering, status badges, retry errors, stale-data warnings, links, and component behavior. A regression confined to these assertions can escape the CI unit-test gate even though package tests would catch it. Compilation and linting do not execute these assertions; these tests are primarily static-render tests, not full browser interaction coverage.

The mismatch extends beyond filename patterns. [The orchestrator configuration](../../packages/orchestrator/vitest.config.ts) sets `fileParallelism: false`, uses source aliases, and loads [a setup file](../../packages/orchestrator/vitest.setup.ts) that provides an isolated default Git cache configuration directory. The root configuration does not import those package settings. Consequently, the root invocation does not provide the same serialization or default-cache isolation. This is a confirmed configuration difference, not evidence that a particular CI run contaminated a home directory or failed nondeterministically.

### Alternatives

| Option | Benefit | Cost or limitation |
| --- | --- | --- |
| Expand the root include to `.test.{ts,tsx}` | Small diff; closes the immediately visible omission | Does not preserve package setup, aliases, defines, or serialization; incomplete as the final fix |
| Use package scripts as the authoritative CI gate | Aligns with `pnpm test`, preserves existing package configuration, straightforward rollback | A transitional separate coverage run duplicates work; coverage collection still needs consolidation |
| Introduce one root Vitest project configuration referencing package configs | One coordinated discovery and coverage entry point | Must validate project roots, relative setup paths, aliases, package-specific scheduling, and packages without a local config; larger migration |

### Recommended direction

First add the existing `pnpm test` command as a mandatory CI gate. If keeping the current coverage invocation temporarily, describe it as a separate report path, not the complete gate. Then move coverage to a package-aware strategy: either a validated root project configuration or package reports with an explicit aggregation step. Do not remove the package gate until discovery and configuration parity are demonstrated.

Coverage aggregation must avoid overwriting reports from recursive package execution and define how shared source modules tested from multiple packages are attributed. Preserve the explicit built-worker startup and package-entrypoint checks; they exercise built artifacts that source aliases alone cannot validate.

Acceptance: the three TSX files are discovered; package-specific cache isolation and serialization are effective; a deliberate temporary failing TSX assertion makes the CI-equivalent gate fail; the aggregate coverage artifact is nonempty and includes frontend source. Compare normalized file sets instead of permanently hard-coding today's total test count.

Symphony alignment: improves verification of observability and host behavior under §17. No new runtime divergence.

## R2: The orchestrator has too many reasons to change

### Evidence and failure scenario

[`service.ts`](../../packages/orchestrator/src/service.ts) has 7,096 lines. File size is an indicator, not proof of a defect. More significant is that it owns:

- Reconciliation and candidate dispatch (`reconcileProject`, around line 1452).
- Workspace preparation, hooks, environment construction, and worker startup (`startRun`, around line 3064).
- Run outcome classification and retry/recovery (`reconcileRun`, around line 3651; restart helpers around line 5223).
- Worker events, tracker state requests, Git publication, and process ownership.
- Workflow loading, last-known-good state, and status assembly.

The service also maintains separate queues for reconciliation and tracker-state requests, plus asynchronous worker-event writes. A refactor that accidentally merges those queues could block scheduling behind provider rate limits; an extraction that duplicates mutable state could miscount retries or concurrency reservations.

The practical concern is the number of invariants a maintainer must understand for a localized change, rather than a claim that the current service is broken. Existing focused helpers such as `dispatch-eligibility.ts`, `repository-cache.ts`, and core retry/state-transition contracts provide useful extraction patterns.

### Alternatives

| Option | Benefit | Cost or limitation |
| --- | --- | --- |
| Keep one service and reorganize methods/comments | Minimal behavioral risk | Improves navigation but leaves shared mutable state and coupling intact |
| Incrementally extract decisions, then cohesive effects | Smaller review scope, focused tests, no data migration | Requires careful interfaces and several changes; some façade complexity remains |
| Replace with a new workflow engine, actor model, or distributed services | Potentially clearer ownership at larger scale | Changes execution ordering, persistence, deployment, and failure modes simultaneously; benefits are not established by this review |

### Recommended direction

Keep `OrchestratorService` as the public façade and sole owner of scheduling coordination. Start with pure policy decisions that take explicit inputs and return a decision: retry eligibility, finalization classification, or reservation ordering. Preserve existing helpers instead of creating parallel implementations.

Next extract one cohesive effect boundary, such as workspace preparation. Its result should state whether preparation succeeded, the prepared paths, and the diagnostics needed by the caller. Keep claim changes and dispatch reservation ownership in the coordinating service. Do not pass the whole service or a large mutable context object into helpers; that relocates coupling without reducing it.

Only after these smaller steps should run reconciliation become a collaborator. Preserve effect order, persisted schemas, event names, and the distinction between worker failure, healthy continuation, and deferred finalization. File-length reduction is not an acceptance criterion; independently understandable ownership is.

Regression contracts: failed candidate startup does not starve later candidates; reserved retries do not exceed capacity or reset their due-time ordering; dirty-workspace failures consume the durable failure budget; shutdown signals only the intended processes; workflow hooks still precede the credential snapshot; unpublished work remains preserved. Existing service tests should remain at the façade boundary, with focused decision tests added for newly exposed decision boundaries.

Symphony alignment: strengthens §3.2 boundaries without changing behavior. Existing persistence, retry reservation, and cleanup divergences remain intentional repository choices; extraction must not silently remove them.

## R3: Polling cost grows with the entire run history

### Evidence and failure scenario

[`OrchestratorFsStore.loadAllRuns()`](../../packages/orchestrator/src/fs-store.ts), around line 225, enumerates legacy and project run directories and reads every `run.json` using `Promise.all`. Filtering by project and active status happens later in the caller.

The normal candidate-polling path contains five direct full-history reads in `reconcileProject` (around lines 1474, 1521, 1526, 1538, and 2383), before additional helper-dependent reads. Thus N retained records can result in approximately 5N JSON-file reads on that path. This describes the call pattern, not a measured latency or a guarantee that every error path performs five scans.

Additional scans support latest-run lookup and unpublished-work preservation. The store contract has no run-retention operation. Standalone runtime directories reduce the common cross-project case, but historical records within one project still accumulate.

One isolated diagnostic confirmed that an inventory containing an old success, an active run, and a different project's failure returns all three. Production-scale latency, memory pressure, and filesystem concurrency limits were not benchmarked. Unbounded `Promise.all` creates read fan-out, but file-descriptor exhaustion has not been reproduced.

### Alternatives

| Option | Benefit | Cost or limitation |
| --- | --- | --- |
| Reuse one snapshot throughout a tick | Reduces repeated scans with little storage change | Can hide asynchronous worker or tracker writes; an immutable snapshot reused blindly may make concurrency or completion decisions stale |
| Add project-scoped reads and bounded I/O, then reduce redundant reads at explicit boundaries | Limits unrelated work and read fan-out; preserves JSON storage and rollback | Still scales with that project's history; requires legacy-layout compatibility and careful refresh points |
| Maintain an active/latest-run index and incremental historical aggregates | Can make steady-state cost depend mainly on active runs | Introduces index consistency, crash recovery, rebuild, and multi-writer questions; metrics must remain exact |
| Move state to SQLite | Indexed queries and transactional updates | Migration, packaging, backup, lock-contention, and rollback work; does not by itself fix inefficient query patterns |

### Recommended direction

Measure before selecting a storage replacement. Capture tick duration, inventory duration, record count, read count, and resource usage with identical active runs and growing completed histories (for example 100, 1,000, and 10,000 records). Include shared and legacy layouts, realistic run sizes, and a concurrent worker update. Compare repeated runs and distinguish warm-cache measurements from a production claim. Use a proposed investigation threshold such as inventory consuming over 10% of the configured poll interval; this is a decision aid, not an existing SLO.

The first storage change should introduce a project-scoped query behind the core store contract, with explicit compatibility for legacy records and bounded concurrent reads. A temporary fallback to `loadAllRuns().filter(...)` can ease migration of test stores, but should be visible so it does not conceal the original cost indefinitely.

Then reduce repeated reads only where freshness requirements are documented. Worker-channel updates and tracker-state writes can occur outside the reconcile queue, so "the tick is serialized" does not justify caching all records for its duration. Preserve fresh reads for active-run decisions or implement an explicitly owned update mechanism before adopting a tick-wide view.

If measurements still justify it, add a rebuildable index of active runs and latest run per issue, with historical aggregates. The authoritative JSON records can remain the recovery source initially. A database is a separate later decision.

Do not solve scan cost by deleting old records or reading only active runs: [snapshot construction](../../packages/core/src/observability/snapshot-builder.ts) uses history for cumulative token usage, and cleanup consults historical publication outcomes. Such shortcuts can change billing visibility or lose recovery evidence.

Acceptance: identical dispatch/retry choices and cumulative totals before/after; fresh heartbeat and finalization state remains visible; project isolation and legacy recovery work; unpublished work remains protected; measured improvement at the agreed history size. Prefer deterministic read-count/behavior assertions in unit tests and a separate benchmark over fragile millisecond limits in CI.

Symphony alignment: storage is a repository-local extension beyond upstream restart semantics (§14.3). Optimizing it introduces no intended semantic divergence, provided safety and observability contracts remain intact.

## R4: One malformed Linear list record rejects all candidates

### Evidence and failure scenario

[`listLinearIssues`](../../packages/tracker-linear/src/orchestrator-adapter.ts), around line 555, serves both state-list queries and ID refreshes. It first completes pagination, then maps every record through `normalizeLinearIssue`. Required-field validation throws, so an invalid record aborts normalization of the whole list.

An isolated test supplied one valid issue and one issue with `state: null` to `listIssues`; the call rejected with `Linear issue state name is required.` The same fixture correctly rejected an ID refresh. A bad active-list record can therefore prevent dispatch of valid new candidates on each poll until the data becomes valid. This does not imply that all existing workers immediately stop: active-run reconciliation begins before candidate listing and has its own error handling.

Important correction to severity: upstream §11.1 says a state-list call **MAY** omit an individually malformed record. Tolerating it is permitted, not mandatory. It also says an ID refresh **MUST** fail on malformed requested records, because omission means an issue is no longer visible. This finding is an availability improvement and provider-parity gap, not by itself a demonstrated MUST-level violation.

### Alternatives

| Option | Benefit | Cost or limitation |
| --- | --- | --- |
| Keep strict lists and improve diagnostics | Smallest change, clearly exposes data problems | One bad candidate continues blocking valid candidates |
| Tolerate known record-validation failures in state lists, keep ID refresh strict | Valid work continues; preserves the meaning of refresh omission | Needs bounded diagnostics and metadata preservation; skipped data requires operator visibility |
| Catch all failures and return whatever was collected | Appears resilient | Can hide programming, auth, or paging failures and misrepresent an incomplete response as complete; reject this option |

### Recommended direction

Make query purpose explicit at the shared normalization boundary: state-list versus requested-ID refresh. For a state list, omit only recognized record-validation failures and preserve an explainable diagnostic. For ID refresh, keep the current rejection behavior. Keep transport, GraphQL, authentication, and pagination failures atomic for the whole operation.

A small typed validation error is preferable to catching every exception or matching arbitrary error messages. Apply existing optional-field fallbacks before calling a record malformed. If a record lacks an identity, a diagnostic may use a clearly non-dispatchable page/record location; never invent a routable issue ID.

Reuse the existing `TrackedIssueList.skippedItems` path where possible: the orchestrator already records a skipped count and reason. Preserve both `skippedItems` and `rateLimits` through the outer pickup-label filter, which may allocate a new array. Keep this separate from changing Linear's existing label-routing semantics. Bound and sanitize diagnostics; raw provider payloads and descriptions need not enter logs.

For an all-malformed state list, return no dispatchable issues with explicit skipped diagnostics. For a state-list used in terminal cleanup, omitting an invalid record conservatively postpones cleanup. Never treat malformed requested IDs as missing, terminal, or authorized for cleanup.

Acceptance: mixed lists return valid issues plus diagnostics; malformed requested-ID responses reject; empty input performs no network request; later-page failures reject the whole response; optional metadata does not incorrectly invalidate an issue; diagnostics survive label filtering. Update the Linear adapter profile and the architecture test matrix in the implementation change.

Symphony alignment: uses the permission in §11.1 while preserving mandatory strict refresh behavior and Integration-layer ownership. No new divergence is proposed.

## Delivery and rollback

1. **CI parity:** add the package gate; validate discovery and setup. Consolidate coverage separately if necessary. Keep existing artifact checks.
2. **Linear normalization:** implement operation-specific handling in the adapter with focused fixtures. Reverting this change restores strict list behavior without a data migration.
3. **Storage baseline and first optimization:** agree on a measured workload; add scoped reads and bounded I/O; retain JSON compatibility. Avoid combining this with a service rewrite.
4. **Orchestrator extraction:** one responsibility per change, preserving façade tests and persisted formats. Revert individual extractions independently.

No precise calendar estimate is warranted without agreeing on the coverage strategy and storage performance target. R1's gate is the smallest change; R4 is a contained adapter change; R2 should be several reviewable changes; R3 ranges from a query optimization to a substantially larger persistence project.

## Test cases and verification

| TC | Verification | Result or implementation acceptance |
| --- | --- | --- |
| TC-01 | Compare root and control-plane package discovery | Executed: root finds 2 files; package finds 5, including the 3 TSX files |
| TC-02 | Mixed valid/malformed Linear state list | Executed diagnostic: current implementation rejects the entire list |
| TC-03 | Malformed requested-ID refresh | Executed diagnostic: rejects rather than implying omission |
| TC-04 | Historical and cross-project run inventory | Executed diagnostic: all 3 fixture records are returned |
| TC-05 | Complete repository unit suite | Fresh verification result recorded below |
| TC-06 | CI-equivalent failing TSX sentinel, setup isolation, coverage merge | Required when implementing R1; not executed as a repository mutation here |
| TC-07 | Retry reservation, bounded recovery, shutdown, hook order, unpublished work | Preserve façade regressions for R2; run relevant Docker scenarios after execution changes |
| TC-08 | History growth, update freshness, legacy layout, cumulative metrics | Required when implementing R3; no performance claim from this report |
| TC-09 | Mixed/all-invalid lists, strict refresh, page failure, label metadata | Required when implementing R4; use mocked Linear responses and the existing live-provider acceptance procedure when needed |

The three diagnostic cases were written in an external temporary directory and executed against current source: 3 passed. They describe existing behavior, not implemented fixes. No production credentials or network calls were used by these probes.

Repository unit-suite verification: `pnpm test` exited successfully; 138 test files and 2,029 tests passed across 14 packages. The report's local file links also resolved, and `git diff --check` passed.

The prior analysis on the same revision also passed `pnpm typecheck`; that is prior evidence, not a new typecheck execution for this report. No source behavior changed, so lint, build, Docker E2E, live-provider acceptance, and production benchmarks were not rerun for the report. Future implementation must follow `AGENT_TEST.md`, including the required lint/test/typecheck/build checks and applicable integration scenarios.

Post-review conformance check: the recommended changes preserve the upstream layer boundaries and introduce no intended new divergence. Existing repository-local persistence and lifecycle choices remain explicit. `docs/symphony-spec.md` is unchanged. Only this point-in-time report and its documentation-index entry are added.
