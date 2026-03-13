# CLI Symphony Dashboard — Elixir-Parity Status Rendering

## TL;DR

> **Summary**: Replace the current rudimentary `status --watch` dashboard with a full-screen, clear-and-redraw ANSI dashboard matching the Elixir Symphony prototype. Requires extending core types with live worker data (turn count, session, tokens), adding live worker polling to the orchestrator snapshot, and building a hand-rolled ANSI renderer.
> **Deliverables**: Full-screen dashboard in `status --watch`, extended `TenantStatusSnapshot` with live worker fields, live worker polling during orchestrator ticks, JSON fallback for non-TTY
> **Effort**: Medium
> **Parallel**: YES - 4 waves
> **Critical Path**: Task 1 (ANSI utils) → Task 4 (core types) → Task 6 (snapshot builder) → Task 8 (live polling) → Task 9 (renderer) → Task 10 (integration)

## Context

### Original Request

Replicate the Elixir Symphony prototype's CLI status dashboard in the TypeScript GitHub Symphony implementation. The dashboard must show: header with agents/runtime/tokens/rate-limits, a running table with ID/STAGE/PID/AGE-TURN/TOKENS/SESSION/EVENT columns with colored status dots, and a backoff queue with retry info. Full-screen clear-and-redraw rendering, hand-rolled ANSI (no external TUI library).

### Interview Summary

- **Dashboard home**: `status --watch` only. `start` keeps its log-style output.
- **Refresh rate**: Decoupled from orchestrator tick (30s). Dashboard polls worker `/api/v1/state` independently every 2s.
- **Phase 1 scope**: Defer throughput, project URL, dashboard URL metrics. Focus on running table, backoff queue, header basics.
- **Non-TTY**: Fallback to JSON output (reuse existing `--json` flag behavior).
- **Multi-tenant**: Show all tenants grouped with section headers.
- **Turn count propagation**: Option B (Worker → Orchestrator via live polling, spec-aligned with Symphony 4.1.6, 13.3, 13.7.2).

### Metis Review (gaps addressed)

- All new `TenantStatusSnapshot` fields MUST be optional (`?:`) for backward compatibility
- Worker polling MUST use `Promise.allSettled()` with timeout (200ms default for dashboard, existing behavior for reconcile)
- Handle SIGWINCH (terminal resize), non-TTY detection, cleanup on crash
- Snapshot builder needs tests before modification (no tests exist currently)
- MUST NOT modify `docs/symphony-spec.md` or add external TUI dependencies
- Dashboard renderer must be a pure function (snapshot → string) for testability
- `start` command must NOT be changed (keeps log-style output per user decision)

## Work Objectives

### Core Objective

Implement an Elixir-parity full-screen ANSI dashboard for `gh-symphony status --watch` that renders live worker state including turn counts, token usage, session IDs, and backoff queue status.

### Deliverables

1. Shared ANSI utility module (`packages/cli/src/ansi.ts`)
2. Extended `TenantStatusSnapshot` and `OrchestratorRunRecord` types with live worker fields
3. Snapshot builder updated to pass through live worker data
4. Live worker state polling integrated into orchestrator snapshot building
5. Full-screen dashboard renderer (`packages/cli/src/dashboard/renderer.ts`)
6. Updated `status --watch` command with full-screen rendering + non-TTY JSON fallback

### Definition of Done (verifiable conditions with commands)

- `pnpm lint` passes with zero errors
- `pnpm test` passes (all existing + new tests)
- `pnpm typecheck` passes with strict mode
- `pnpm build` succeeds across all packages
- `gh-symphony status --watch` renders a full-screen dashboard when TTY is available
- `gh-symphony status --watch --json` outputs JSON snapshot
- `gh-symphony status --watch | cat` outputs JSON (non-TTY fallback)
- Dashboard shows: header (agents count, runtime, tokens in/out/total, rate limits), running table (ID, STAGE, PID, AGE/TURN, TOKENS, SESSION, EVENT), backoff queue
- All new type fields are optional (backward compatible)
- No external TUI dependencies added
- `start` command behavior unchanged

### Must Have

- Elixir-parity column layout: ID(8), STAGE(14), PID(8), AGE/TURN(12), TOKENS(10, right-aligned), SESSION(14), EVENT(dynamic, min 12)
- Status dot colors: none→red, token_count→yellow, task_started→green, turn_completed→magenta, default→blue
- Session ID compaction: first4 + "..." + last6 when length > 10
- Full-screen clear-and-redraw rendering (ESC[2J + ESC[H)
- SIGWINCH handling for terminal resize
- Graceful cleanup on SIGINT/SIGTERM (restore cursor, clear alternate screen)
- Multi-tenant grouped display with section headers per workspace

### Must NOT Have (guardrails)

- NO external TUI library dependencies (blessed, ink, etc.)
- NO modifications to `docs/symphony-spec.md`
- NO changes to `start` command behavior
- NO breaking changes to existing `TenantStatusSnapshot` consumers (all new fields optional)
- NO direct file reads for status data (use status API or snapshot)
- NO hardcoded terminal width assumptions (detect via `process.stdout.columns`)

## Verification Strategy

> ZERO HUMAN INTERVENTION — all verification is agent-executed.

- Test decision: Tests-after + framework: Vitest (existing)
- QA policy: Every task has agent-executed scenarios (happy + failure)
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.{ext}`

## Execution Strategy

### Parallel Execution Waves

**Wave 1** (Foundation — 3 parallel tasks): Extract shared ANSI utils, add snapshot builder tests, explore existing test patterns
**Wave 2** (Core types — 2 parallel tasks): Extend core types, update snapshot builder
**Wave 3** (Integration — 2 parallel tasks): Live worker polling, dashboard renderer
**Wave 4** (Wiring + Final — 2 parallel tasks): CLI integration, final verification

### Dependency Matrix

| Task                                   | Depends On | Blocks  |
| -------------------------------------- | ---------- | ------- |
| 1. ANSI utils                          | —          | 9       |
| 2. Snapshot builder tests              | —          | 6       |
| 3. Core barrel export audit            | —          | 4       |
| 4. Extend core types                   | 3          | 6, 8, 9 |
| 5. Worker state-server audit           | —          | 8       |
| 6. Update snapshot builder             | 2, 4       | 8, 9    |
| 7. Dashboard renderer tests (fixtures) | —          | 9       |
| 8. Live worker polling                 | 4, 5, 6    | 10      |
| 9. Dashboard renderer                  | 1, 4, 6, 7 | 10      |
| 10. CLI integration                    | 8, 9       | F1-F4   |

### Agent Dispatch Summary

| Wave  | Tasks             | Categories                                       |
| ----- | ----------------- | ------------------------------------------------ |
| 1     | 3 (Tasks 1, 2, 3) | quick, quick, quick                              |
| 2     | 3 (Tasks 4, 5, 7) | quick, quick, unspecified-low                    |
| 3     | 3 (Tasks 6, 8, 9) | quick, unspecified-high, unspecified-high        |
| 4     | 1 (Task 10)       | unspecified-high                                 |
| Final | 4 (F1-F4)         | oracle, unspecified-high, unspecified-high, deep |

## TODOs

<!-- TASKS START -->

- [x] 1. Extract Shared ANSI Utilities

  **What to do**: Create `packages/cli/src/ansi.ts` extracting duplicated ANSI color/formatting helpers from `status.ts` (lines 12-41) and `start.ts` (lines 18-34). The module must export:
  - Color functions: `bold`, `dim`, `green`, `red`, `yellow`, `cyan`, `magenta`, `blue` — each taking `(s: string) => string`
  - A `noColor` toggle: `setNoColor(value: boolean)` + `getNoColor(): boolean`
  - `stripAnsi(s: string): string` — remove ANSI escape sequences
  - `ESC` constant for raw escape sequences
  - Terminal helpers: `clearScreen(): string` (returns `ESC[2J` + `ESC[H`), `hideCursor(): string`, `showCursor(): string`

  After creating, update `start.ts` and `status.ts` to import from `./ansi.js` instead of defining their own helpers. Remove all inline ANSI helper definitions from both files. The `noColor` state in `start.ts` (line 28) should use `setNoColor()`.

  **Must NOT do**: Add any external dependency. Do not change the visual output of `start` command.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: Simple extraction refactor, single new file + two file updates
  - Skills: [] — No special skills needed
  - Omitted: [`playwright`] — No browser testing needed

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [9] | Blocked By: []

  **References**:
  - Pattern: `packages/cli/src/commands/start.ts:18-34` — ANSI helpers to extract (ESC const, \_bold, \_dim, \_green, \_red, \_yellow, \_cyan, noColor toggle)
  - Pattern: `packages/cli/src/commands/status.ts:12-41` — ANSI helpers to extract (bold, dim, green, red, yellow, cyan, stripAnsi)
  - API/Type: Both files use `\x1b[` escape prefix — standardize to `ESC` const

  **Acceptance Criteria**:
  - [ ] `packages/cli/src/ansi.ts` exists and exports: bold, dim, green, red, yellow, cyan, magenta, blue, stripAnsi, setNoColor, getNoColor, ESC, clearScreen, hideCursor, showCursor
  - [ ] `packages/cli/src/commands/start.ts` imports from `../ansi.js` — zero inline ANSI helper definitions remain
  - [ ] `packages/cli/src/commands/status.ts` imports from `../ansi.js` — zero inline ANSI helper definitions remain
  - [ ] `pnpm --filter @gh-symphony/cli build` succeeds
  - [ ] `pnpm --filter @gh-symphony/cli typecheck` succeeds (if available, else `pnpm typecheck`)

  **QA Scenarios**:

  ```
  Scenario: ANSI module exports all expected symbols
    Tool: Bash
    Steps: Run `node -e "const m = require('./packages/cli/dist/ansi.js'); console.log(Object.keys(m).sort().join(','))"` (or equivalent ESM import)
    Expected: Output contains: ESC, blue, bold, clearScreen, cyan, dim, getNoColor, green, hideCursor, magenta, red, setNoColor, showCursor, stripAnsi, yellow
    Evidence: .sisyphus/evidence/task-1-ansi-exports.txt

  Scenario: stripAnsi removes escape codes
    Tool: Bash
    Steps: Run node script that calls `stripAnsi(bold("hello"))` and asserts result === "hello"
    Expected: Assertion passes
    Evidence: .sisyphus/evidence/task-1-strip-ansi.txt
  ```

  **Commit**: YES | Message: `refactor(cli): extract shared ANSI utilities to ansi.ts` | Files: [packages/cli/src/ansi.ts, packages/cli/src/commands/start.ts, packages/cli/src/commands/status.ts]

- [x] 2. Add Snapshot Builder Baseline Tests

  **What to do**: Create `packages/core/src/observability/snapshot-builder.test.ts` with tests covering the current `buildTenantSnapshot()` behavior. This establishes a safety net before modifying the builder in Task 6. Tests should cover:
  1. **Idle state**: No active runs → health = "idle", empty activeRuns/retryQueue
  2. **Running state**: Active runs present → health = "running", correct activeRuns mapping
  3. **Degraded state**: lastError present → health = "degraded"
  4. **Retry queue partitioning**: Runs with status="retrying" appear in retryQueue
  5. **Token aggregation**: Multiple runs with tokenUsage → correct codexTotals
  6. **Missing optional fields**: Runs without tokenUsage/runtimeSession → no crash, graceful defaults

  Use Vitest. Create a `mockTenant()` helper and `mockRun()` helper for test fixtures.

  **Must NOT do**: Modify `snapshot-builder.ts` itself. Tests must pass against the current implementation.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: Write tests for existing code, no design decisions
  - Skills: [] — No special skills needed

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [6] | Blocked By: []

  **References**:
  - Pattern: `packages/core/src/observability/snapshot-builder.ts:1-119` — Full source to test
  - API/Type: `packages/core/src/contracts/status-surface.ts:15-27` — `SnapshotInput` type
  - API/Type: `packages/core/src/contracts/status-surface.ts:45-75` — `OrchestratorRunRecord` fields
  - API/Type: `packages/core/src/contracts/status-surface.ts:95-133` — `TenantStatusSnapshot` output shape
  - Test: `packages/core/src/workflow-loader.test.ts` — Existing test patterns in core package (Vitest, import style)
  - Config: `vitest.config.ts` at repo root — test configuration

  **Acceptance Criteria**:
  - [ ] `packages/core/src/observability/snapshot-builder.test.ts` exists with ≥6 test cases
  - [ ] `npx vitest run packages/core/src/observability/snapshot-builder.test.ts` passes
  - [ ] Tests cover: idle, running, degraded, retry queue, token aggregation, missing optionals

  **QA Scenarios**:

  ```
  Scenario: All snapshot builder tests pass
    Tool: Bash
    Steps: Run `npx vitest run packages/core/src/observability/snapshot-builder.test.ts`
    Expected: All tests pass, exit code 0
    Evidence: .sisyphus/evidence/task-2-snapshot-tests.txt

  Scenario: Tests fail if builder logic changes unexpectedly
    Tool: Bash
    Steps: Temporarily modify buildTenantSnapshot to always return health="idle", run tests
    Expected: At least one test fails (running/degraded case)
    Evidence: .sisyphus/evidence/task-2-regression-check.txt
  ```

  **Commit**: YES | Message: `test(core): add baseline tests for snapshot builder` | Files: [packages/core/src/observability/snapshot-builder.test.ts]

- [x] 3. Audit Core Barrel Exports

  **What to do**: Read `packages/core/src/index.ts` and `packages/core/src/observability/index.ts`. Verify that `TenantStatusSnapshot`, `OrchestratorRunRecord`, `RuntimeSessionRow`, `SnapshotInput`, and `buildTenantSnapshot` are all exported from the package entrypoint. Document any missing exports so Task 4 can add them alongside the type extensions. Create a brief audit note in the commit message listing what's already exported and what needs adding.

  This is a read-only audit task — only create a commit if exports actually need adding. If all exports are already present, just confirm and move on.

  **Must NOT do**: Add new types yet (that's Task 4). Only fix missing barrel exports for existing types.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: Read files, possibly add a few export lines
  - Skills: [] — No special skills needed

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: [4] | Blocked By: []

  **References**:
  - Pattern: `packages/core/src/index.ts` — Main barrel file
  - Pattern: `packages/core/src/observability/index.ts` — Observability sub-barrel
  - API/Type: `packages/core/src/contracts/status-surface.ts` — Types that must be exported
  - API/Type: `packages/core/src/observability/snapshot-builder.ts:15-27` — `SnapshotInput` type

  **Acceptance Criteria**:
  - [ ] All existing status-surface types are reachable via `import { X } from "@gh-symphony/core"`
  - [ ] `pnpm --filter @gh-symphony/core build` succeeds
  - [ ] Audit findings documented (in commit message or task evidence)

  **QA Scenarios**:

  ```
  Scenario: Core exports are importable
    Tool: Bash
    Steps: After build, run node script importing TenantStatusSnapshot, OrchestratorRunRecord, RuntimeSessionRow from @gh-symphony/core dist
    Expected: No import errors
    Evidence: .sisyphus/evidence/task-3-exports-audit.txt
  ```

  **Commit**: YES (only if changes needed) | Message: `fix(core): add missing barrel exports for status-surface types` | Files: [packages/core/src/index.ts, packages/core/src/observability/index.ts]

- [x] 4. Extend Core Types for Live Worker Data

  **What to do**: Add new optional fields to types in `packages/core/src/contracts/status-surface.ts`:

  **A. `OrchestratorRunRecord`** — add after line 74 (after `tokenUsage`):

  ```typescript
  /** Turn count from live worker polling (Symphony spec 4.1.6) */
  turnCount?: number;
  /** Worker start time for AGE calculation */
  startedAtMs?: number;
  /** Last event description from worker */
  lastEvent?: string | null;
  /** Last event timestamp */
  lastEventAt?: string | null;
  ```

  **B. `TenantStatusSnapshot.activeRuns` array element** — extend the object type at lines 110-117:

  ```typescript
  // Add to existing fields:
  processId?: number | null;
  turnCount?: number;
  startedAt?: string | null;
  lastEvent?: string | null;
  lastEventAt?: string | null;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  ```

  **C. New type for live worker poll result** — add after `RuntimeSessionRow`:

  ```typescript
  export type LiveWorkerState = {
    tokenUsage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    } | null;
    sessionId: string | null;
    turnCount: number;
    lastError: string | null;
    lastEvent: string | null;
    lastEventAt: string | null;
    status: "idle" | "starting" | "running" | "failed" | "completed";
  };
  ```

  ALL new fields on existing types MUST use `?:` (optional) for backward compatibility.

  **Must NOT do**: Change any existing field types. Remove any existing fields. Make new fields required.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: Adding optional fields to existing types, straightforward
  - Skills: [] — No special skills needed

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [6, 8, 9] | Blocked By: [3]

  **References**:
  - API/Type: `packages/core/src/contracts/status-surface.ts:45-75` — `OrchestratorRunRecord` (add after tokenUsage)
  - API/Type: `packages/core/src/contracts/status-surface.ts:110-117` — `activeRuns` element type (extend)
  - API/Type: `packages/core/src/contracts/status-surface.ts:86-93` — `RuntimeSessionRow` (add new type after)
  - External: Symphony spec sections 4.1.6, 13.3, 13.7.2 — turn_count is spec-aligned

  **Acceptance Criteria**:
  - [ ] `OrchestratorRunRecord` has optional `turnCount`, `startedAtMs`, `lastEvent`, `lastEventAt` fields
  - [ ] `TenantStatusSnapshot.activeRuns[]` element has optional `processId`, `turnCount`, `startedAt`, `lastEvent`, `lastEventAt`, `tokenUsage` fields
  - [ ] `LiveWorkerState` type exists and is exported
  - [ ] `pnpm typecheck` passes — no existing code breaks
  - [ ] `pnpm build` succeeds

  **QA Scenarios**:

  ```
  Scenario: Type extensions are backward compatible
    Tool: Bash
    Steps: Run `pnpm typecheck` (checks all packages that depend on core)
    Expected: Zero type errors, exit code 0
    Evidence: .sisyphus/evidence/task-4-typecheck.txt

  Scenario: New types are importable
    Tool: Bash
    Steps: After build, verify `LiveWorkerState` can be imported from @gh-symphony/core
    Expected: Import succeeds
    Evidence: .sisyphus/evidence/task-4-import.txt
  ```

  **Commit**: YES | Message: `feat(core): extend status-surface types with live worker fields` | Files: [packages/core/src/contracts/status-surface.ts]

- [x] 5. Audit Worker State Server Response Shape

  **What to do**: Read `packages/worker/src/state-server.ts` and `packages/worker/src/index.ts` to document the exact shape of the `/api/v1/state` response. Verify that `turnCount` and `tokenUsage` are already present. Document the response shape as a reference for Task 8 (live worker polling).

  Specifically confirm:
  - `state.tokenUsage` → `{ inputTokens, outputTokens, totalTokens }`
  - `state.sessionInfo` → `{ threadId: string | null, turnCount: number }`
  - `state.run` → `{ runId, issueId, issueIdentifier, state, processId, lastError, ... }`
  - `state.status` → `"idle" | "starting" | "running" | "failed" | "completed"`

  Check if the worker emits any "last event" data. If not, document this gap — the dashboard's EVENT column will need a fallback (show status changes or "—").

  This is a read-only audit. Create evidence file with findings.

  **Must NOT do**: Modify any worker code.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: Read-only audit, document findings
  - Skills: [] — No special skills needed

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [8] | Blocked By: []

  **References**:
  - Pattern: `packages/worker/src/state-server.ts:6-47` — `WorkerRuntimeState` type definition
  - Pattern: `packages/worker/src/state-server.ts:49-103` — `buildWorkerRuntimeState()` function
  - Pattern: `packages/worker/src/index.ts` — Where turnCount and tokenUsage are updated at runtime

  **Acceptance Criteria**:
  - [ ] Evidence file documents exact `/api/v1/state` response shape
  - [ ] Confirms presence/absence of: tokenUsage, sessionInfo.turnCount, lastEvent
  - [ ] Documents any gaps requiring fallback in dashboard renderer

  **QA Scenarios**:

  ```
  Scenario: Worker state shape documented
    Tool: Bash
    Steps: Create evidence file with documented response shape from state-server.ts
    Expected: Evidence file exists and contains structured documentation
    Evidence: .sisyphus/evidence/task-5-worker-state-audit.txt
  ```

  **Commit**: NO — Read-only audit task

- [x] 6. Update Snapshot Builder to Pass Through Live Worker Data

  **What to do**: Modify `packages/core/src/observability/snapshot-builder.ts` to pass through the new live worker fields added in Task 4.

  **A. Update `SnapshotInput`** (line 15-27): No changes needed — the input already receives `OrchestratorRunRecord[]` which now has the new optional fields.

  **B. Update `buildTenantSnapshot` active runs mapping** (lines 55-63): Add the new fields to the `activeRuns.map()`:

  ```typescript
  activeRuns: activeRuns.map((run) => ({
    runId: run.runId,
    issueIdentifier: run.issueIdentifier,
    issueState: run.issueState,
    status: run.status,
    retryKind: run.retryKind,
    port: run.port,
    runtimeSession: run.runtimeSession ?? null,
    // New fields from live worker data
    processId: run.processId ?? null,
    turnCount: run.turnCount,
    startedAt: run.startedAt ?? null,
    lastEvent: run.lastEvent ?? null,
    lastEventAt: run.lastEventAt ?? null,
    tokenUsage: run.tokenUsage,
  })),
  ```

  **C. Add new tests** to `snapshot-builder.test.ts` (created in Task 2):
  - Test that new fields pass through when present on run records
  - Test that new fields are undefined/null when absent (backward compat)

  **Must NOT do**: Change health derivation logic. Change retry queue logic. Break existing tests.

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: Small modification to existing function + test additions
  - Skills: [] — No special skills needed

  **Parallelization**: Can Parallel: YES (with 8, 9 in Wave 3 if 4 is done) | Wave 3 | Blocks: [8, 9] | Blocked By: [2, 4]

  **References**:
  - Pattern: `packages/core/src/observability/snapshot-builder.ts:55-63` — activeRuns mapping to update
  - Test: `packages/core/src/observability/snapshot-builder.test.ts` — Tests from Task 2 to extend
  - API/Type: `packages/core/src/contracts/status-surface.ts:110-117` — Extended activeRuns element type (from Task 4)

  **Acceptance Criteria**:
  - [ ] `buildTenantSnapshot()` maps processId, turnCount, startedAt, lastEvent, lastEventAt, tokenUsage to activeRuns
  - [ ] All existing snapshot builder tests still pass
  - [ ] New tests verify pass-through of live worker fields
  - [ ] `pnpm typecheck` passes
  - [ ] `npx vitest run packages/core/src/observability/snapshot-builder.test.ts` passes

  **QA Scenarios**:

  ```
  Scenario: Live fields pass through correctly
    Tool: Bash
    Steps: Run `npx vitest run packages/core/src/observability/snapshot-builder.test.ts`
    Expected: All tests pass including new live-field tests
    Evidence: .sisyphus/evidence/task-6-snapshot-passthrough.txt

  Scenario: Backward compatibility preserved
    Tool: Bash
    Steps: Run `pnpm typecheck` to verify no consumers break
    Expected: Exit code 0, no type errors
    Evidence: .sisyphus/evidence/task-6-compat.txt
  ```

  **Commit**: YES | Message: `feat(core): pass through live worker fields in snapshot builder` | Files: [packages/core/src/observability/snapshot-builder.ts, packages/core/src/observability/snapshot-builder.test.ts]

- [x] 7. Create Dashboard Renderer Test Fixtures

  **What to do**: Create `packages/cli/src/dashboard/__tests__/fixtures/` with snapshot fixture files matching the Elixir reference. These fixtures will be used by the renderer tests (Task 9). Create:
  1. `idle.snapshot.json` — Zero active runs, no rate limits, single tenant
  2. `busy.snapshot.json` — 2 active runs with full token/turn/session data, rate limits present
  3. `backoff.snapshot.json` — 1 running + 3 retrying (in backoff queue), various retry kinds
  4. `multi-tenant.snapshot.json` — 2 tenants, each with different states

  Each fixture is a JSON file containing either a single `TenantStatusSnapshot` (fixtures 1-3) or an array of them (fixture 4), using the extended type from Task 4.

  Also create `packages/cli/src/dashboard/__tests__/` directory structure.

  **Elixir reference for column data** (from analyzed Elixir fixtures):
  - Idle: `Agents 0/4, Throughput: -- issues/hour, Runtime: 0h 0m`
  - Busy: `Agents 2/4`, runs with turn counts (e.g., "3m/7"), token counts (e.g., "12,450"), session IDs (compact), events
  - Backoff: Retry entries with `↻` symbol, attempt number, time-until-retry, error message

  **Must NOT do**: Create the renderer itself (that's Task 9). These are just test data fixtures.

  **Recommended Agent Profile**:
  - Category: `unspecified-low` — Reason: Creating test fixture JSON files with realistic data
  - Skills: [] — No special skills needed

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: [9] | Blocked By: []

  **References**:
  - API/Type: `packages/core/src/contracts/status-surface.ts:95-133` — `TenantStatusSnapshot` shape (with Task 4 extensions)
  - External: Elixir fixture analysis from planning session — column widths, data shapes, formatting rules

  **Acceptance Criteria**:
  - [ ] 4 fixture files exist in `packages/cli/src/dashboard/__tests__/fixtures/`
  - [ ] Each fixture is valid JSON matching `TenantStatusSnapshot` type shape
  - [ ] Fixtures cover: idle, busy (with live data), backoff queue, multi-tenant
  - [ ] Fixture data includes realistic values for turnCount, tokenUsage, sessionInfo, lastEvent

  **QA Scenarios**:

  ```
  Scenario: Fixtures are valid JSON
    Tool: Bash
    Steps: Run `node -e "for (const f of ['idle','busy','backoff','multi-tenant']) { JSON.parse(require('fs').readFileSync('packages/cli/src/dashboard/__tests__/fixtures/' + f + '.snapshot.json', 'utf8')); console.log(f + ': OK'); }"`
    Expected: All 4 fixtures parse without error
    Evidence: .sisyphus/evidence/task-7-fixtures-valid.txt
  ```

  **Commit**: YES | Message: `test(cli): add dashboard renderer test fixtures` | Files: [packages/cli/src/dashboard/__tests__/fixtures/*.snapshot.json]

- [x] 8. Add Live Worker Polling to Orchestrator Snapshot Building

  **What to do**: Modify `packages/orchestrator/src/service.ts` to fetch live worker state during `reconcileRun()` for running processes, so the snapshot has live data for the dashboard.

  **Current gap** (lines 614-642): When `isProcessRunning()` returns true, `reconcileRun()` just marks the run as "running" and returns WITHOUT fetching live worker state. `fetchWorkerRunInfo()` is only called AFTER the process exits (line 647).

  **Changes needed**:

  **A. Enrich the "running" branch** (lines 631-642): Before saving the running record, call `fetchLiveWorkerState()` to get live data:

  ```typescript
  } else {
    // Fetch live state for dashboard enrichment
    const liveState = await this.fetchLiveWorkerState(run);
    const runningRecord: OrchestratorRunRecord = {
      ...run,
      status: "running",
      updatedAt: now.toISOString(),
      // Enrich with live worker data
      turnCount: liveState.turnCount ?? undefined,
      tokenUsage: liveState.tokenUsage ?? run.tokenUsage,
      lastEvent: liveState.lastEvent ?? undefined,
      lastEventAt: liveState.lastEventAt ?? undefined,
    };
    await this.store.saveRun(runningRecord);
    return { leases, recovered: false };
  }
  ```

  **B. Extend `fetchLiveWorkerState()` return type** (lines 828-872): Add `turnCount`, `lastEvent`, `lastEventAt`, `status` to the return type and parse them from the worker response. The worker's `WorkerRuntimeState` already has `sessionInfo.turnCount` and `status`. For `lastEvent`, use the worker's `status` field as a fallback (e.g., "running", "completed").

  Updated return type:

  ```typescript
  private async fetchLiveWorkerState(run: OrchestratorRunRecord): Promise<{
    tokenUsage: OrchestratorRunRecord["tokenUsage"] | null;
    sessionId: string | null;
    turnCount: number | null;
    lastError: string | null;
    lastEvent: string | null;
    lastEventAt: string | null;
    status: string | null;
  }>
  ```

  **C. Handle fetch timeout**: The existing `fetchLiveWorkerState` already catches errors. Add a 2-second timeout using `AbortSignal.timeout(2000)` to the fetch call to prevent blocking the orchestrator tick.

  **Must NOT do**: Change the retry/failure reconciliation logic. Break the existing `fetchWorkerRunInfo` flow. Remove any existing error handling.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: Modifying critical orchestrator reconciliation path, needs careful attention
  - Skills: [] — No special skills needed

  **Parallelization**: Can Parallel: YES (with 9 in Wave 3) | Wave 3 | Blocks: [10] | Blocked By: [4, 5, 6]

  **References**:
  - Pattern: `packages/orchestrator/src/service.ts:614-642` — reconcileRun running branch (THE KEY GAP)
  - Pattern: `packages/orchestrator/src/service.ts:828-872` — fetchLiveWorkerState (to extend)
  - Pattern: `packages/orchestrator/src/service.ts:808-826` — fetchWorkerRunInfo (calls fetchLiveWorkerState)
  - API/Type: `packages/worker/src/state-server.ts:6-47` — WorkerRuntimeState response shape
  - API/Type: `packages/core/src/contracts/status-surface.ts` — Extended OrchestratorRunRecord (from Task 4)

  **Acceptance Criteria**:
  - [ ] `reconcileRun()` fetches live worker state when process is running (not just on exit)
  - [ ] `fetchLiveWorkerState()` returns turnCount, lastEvent, lastEventAt, status
  - [ ] Fetch has 2-second timeout via `AbortSignal.timeout(2000)`
  - [ ] Existing reconciliation logic unchanged (retry, failure, stuck-worker detection)
  - [ ] `pnpm typecheck` passes
  - [ ] `pnpm test` passes (existing orchestrator tests)
  - [ ] `pnpm build` succeeds

  **QA Scenarios**:

  ```
  Scenario: Live worker state enriches running record
    Tool: Bash
    Steps: Run `pnpm --filter @gh-symphony/orchestrator test` (or `pnpm test`)
    Expected: All tests pass, no regressions
    Evidence: .sisyphus/evidence/task-8-orchestrator-tests.txt

  Scenario: Fetch timeout doesn't block orchestrator
    Tool: Bash
    Steps: Run `pnpm typecheck` to verify type safety of new return shape
    Expected: No type errors
    Evidence: .sisyphus/evidence/task-8-typecheck.txt
  ```

  **Commit**: YES | Message: `feat(orchestrator): poll live worker state during reconciliation for dashboard` | Files: [packages/orchestrator/src/service.ts]

- [x] 9. Build Dashboard Renderer

  **What to do**: Create `packages/cli/src/dashboard/renderer.ts` — a pure function that takes `TenantStatusSnapshot[]` and terminal width, and returns a string containing the full-screen ANSI dashboard. Also create `packages/cli/src/dashboard/renderer.test.ts`.

  **Renderer signature**:

  ```typescript
  export type DashboardOptions = {
    terminalWidth: number;
    noColor: boolean;
    maxAgents?: number; // from config, for "Agents N/max" display
  };

  export function renderDashboard(
    snapshots: TenantStatusSnapshot[],
    options: DashboardOptions
  ): string;
  ```

  **Layout (Elixir parity)**:

  ```
  ═══════════════════════════════════ gh-symphony ══════════════════════════════════
    Agents  2/4          Runtime  1h 23m        Tokens  12,450 in / 8,200 out / 20,650 total
    Rate Limits  standard                       Next refresh  2s

  ── {tenant-slug} ──────────────────────────────────────────────────────────────────
    ID          STAGE          PID       AGE/TURN      TOKENS    SESSION         EVENT
    ● acme#42   In Progress    12345     3m/7           12,450   abc4...ef0123   turn_completed
    ● beta#17   Planning       12346     1m/2            3,200   —               task_started

  ── Backoff Queue ──────────────────────────────────────────────────────────────────
    ↻ acme#99  attempt 3  retrying in 45s  Worker process exited unexpectedly.
  ```

  **Column widths** (from Elixir): ID=8, STAGE=14, PID=8, AGE/TURN=12, TOKENS=10(right-align), SESSION=14, EVENT=dynamic(remaining width, min 12)
  **Default terminal width**: 115 (fallback if `process.stdout.columns` unavailable)
  **Row chrome**: 4 chars (2 indent + 2 padding)

  **Status dot colors**:
  - No event / failed → red `●`
  - token_count event → yellow `●`
  - task_started → green `●`
  - turn_completed → magenta `●`
  - Default → blue `●`

  **Formatting rules**:
  - AGE: `Xm` (minutes since startedAt) or `Xh Ym` if > 60min
  - TURN: integer from turnCount (e.g., `/7`)
  - AGE/TURN combined: `3m/7`
  - TOKENS: comma-formatted total (e.g., `12,450`), right-aligned in column
  - SESSION: Compact session ID — if length > 10, show `first4...last6`
  - Multi-tenant: Section header per tenant slug with `──` decoration

  **Import ANSI helpers from `../ansi.js`** (Task 1).

  **Tests** (`renderer.test.ts`):
  - Load fixture JSONs from Task 7
  - Render each fixture
  - Assert: contains expected column headers, contains expected issue identifiers, contains expected status dots
  - Assert: output width doesn't exceed terminal width (per non-ANSI content)
  - Assert: noColor mode produces zero ANSI escape sequences

  **Must NOT do**: Add external dependencies. Render to anything other than a string. Handle I/O (no process.stdout.write — caller handles that).

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: Complex rendering logic with precise column layout, color mapping, and formatting rules
  - Skills: [] — No special skills needed

  **Parallelization**: Can Parallel: YES (with 8 in Wave 3) | Wave 3 | Blocks: [10] | Blocked By: [1, 4, 6, 7]

  **References**:
  - Pattern: `packages/cli/src/ansi.ts` — ANSI helpers (from Task 1)
  - API/Type: `packages/core/src/contracts/status-surface.ts:95-133` — `TenantStatusSnapshot` (with Task 4 extensions)
  - Test: `packages/cli/src/dashboard/__tests__/fixtures/` — Test fixtures (from Task 7)
  - External: Elixir `status_dashboard.ex` analysis — Column widths (ID=8, STAGE=14, PID=8, AGE/TURN=12, TOKENS=10, SESSION=14, EVENT=dynamic), color mapping, session compaction rules

  **Acceptance Criteria**:
  - [ ] `packages/cli/src/dashboard/renderer.ts` exists with `renderDashboard()` function
  - [ ] Renderer is a pure function: `(TenantStatusSnapshot[], DashboardOptions) => string`
  - [ ] Column layout matches Elixir spec: ID=8, STAGE=14, PID=8, AGE/TURN=12, TOKENS=10, SESSION=14, EVENT=dynamic
  - [ ] Status dot colors correct: red=none/failed, yellow=token_count, green=task_started, magenta=turn_completed, blue=default
  - [ ] Session compaction works: first4...last6 when length > 10
  - [ ] Multi-tenant sections with headers
  - [ ] Backoff queue rendering with ↻ symbol, attempt, time-until-retry, error message
  - [ ] `npx vitest run packages/cli/src/dashboard/renderer.test.ts` passes
  - [ ] `pnpm typecheck` passes

  **QA Scenarios**:

  ```
  Scenario: Idle dashboard renders correctly
    Tool: Bash
    Steps: Run renderer test with idle fixture, check output contains "Agents 0" and "No active runs" or empty table
    Expected: Test passes
    Evidence: .sisyphus/evidence/task-9-idle-render.txt

  Scenario: Busy dashboard renders all columns
    Tool: Bash
    Steps: Run renderer test with busy fixture, check output contains issue identifiers, turn counts, token counts, session IDs
    Expected: Test passes, all columns present and properly aligned
    Evidence: .sisyphus/evidence/task-9-busy-render.txt

  Scenario: noColor mode strips all ANSI
    Tool: Bash
    Steps: Render with noColor=true, assert zero `\x1b[` sequences in output
    Expected: No ANSI escape codes in output
    Evidence: .sisyphus/evidence/task-9-nocolor.txt

  Scenario: Terminal width respected
    Tool: Bash
    Steps: Render with terminalWidth=80, verify no visible line exceeds 80 chars (after stripping ANSI)
    Expected: All lines ≤ 80 chars wide
    Evidence: .sisyphus/evidence/task-9-width.txt
  ```

  **Commit**: YES | Message: `feat(cli): add Elixir-parity dashboard renderer` | Files: [packages/cli/src/dashboard/renderer.ts, packages/cli/src/dashboard/renderer.test.ts]

- [x] 10. Integrate Dashboard Renderer into `status --watch`

  **What to do**: Update `packages/cli/src/commands/status.ts` to use the new dashboard renderer for `--watch` mode. Keep single-query mode (`status` without `--watch`) using the existing `renderDashboard()` — or update it too to use the new renderer for consistency.

  **Changes**:

  **A. Replace watch mode rendering** (lines 235-265): Instead of polling `status.json` files, make the watch loop:
  1. Fetch snapshots from the status API (`http://127.0.0.1:4680/api/v1/status`) OR read `status.json` files (fallback)
  2. For each snapshot with active runs that have ports, poll each worker's `/api/v1/state` to get live data (turnCount, tokenUsage, session, lastEvent)
  3. Merge live worker data into snapshot's `activeRuns` entries
  4. Pass enriched snapshots to `renderDashboard()` from `../dashboard/renderer.js`
  5. Clear screen + write rendered output

  **B. Non-TTY detection**: At the start of watch mode, check `process.stdout.isTTY`. If false, fall back to JSON output (same as `--json` mode) for each refresh cycle.

  **C. SIGWINCH handling**: Listen for `SIGWINCH` event and update `terminalWidth` used by renderer.

  **D. Cleanup on exit**: On SIGINT/SIGTERM, show cursor (`showCursor()`), write newline, then exit.

  **E. Multi-tenant support**: Read ALL tenant status files (or fetch from API), collect into array, pass all to renderer.

  **F. Rename old `renderDashboard`**: Rename the existing `renderDashboard()` function (lines 71-174) to `renderLegacyStatus()` and keep it for single-query mode. Or, update single-query mode to also use the new renderer (preferred for consistency).

  **Import map**:

  ```typescript
  import { renderDashboard } from "../dashboard/renderer.js";
  import { clearScreen, showCursor, hideCursor } from "../ansi.js";
  ```

  **Must NOT do**: Change the `start` command. Break `status` single-query mode. Add external dependencies.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: CLI integration with multiple concerns (TTY detection, signal handling, API polling, renderer wiring)
  - Skills: [] — No special skills needed

  **Parallelization**: Can Parallel: NO | Wave 4 | Blocks: [F1-F4] | Blocked By: [8, 9]

  **References**:
  - Pattern: `packages/cli/src/commands/status.ts:235-265` — Current watch mode (to replace)
  - Pattern: `packages/cli/src/commands/status.ts:71-174` — Current renderDashboard (to rename/replace)
  - Pattern: `packages/cli/src/dashboard/renderer.ts` — New renderer (from Task 9)
  - Pattern: `packages/cli/src/ansi.ts` — ANSI helpers (from Task 1)
  - Pattern: `packages/orchestrator/src/status-server.ts` — Status API shape for fetching snapshots

  **Acceptance Criteria**:
  - [ ] `status --watch` renders full-screen dashboard in TTY mode
  - [ ] `status --watch` outputs JSON in non-TTY mode (piped)
  - [ ] `status --watch --json` always outputs JSON
  - [ ] SIGWINCH updates terminal width for next render cycle
  - [ ] SIGINT/SIGTERM restores cursor and exits cleanly
  - [ ] Multi-tenant: all tenants shown in dashboard
  - [ ] Single-query `status` still works (not broken)
  - [ ] `pnpm typecheck` passes
  - [ ] `pnpm build` succeeds
  - [ ] `pnpm lint` passes

  **QA Scenarios**:

  ```
  Scenario: Watch mode renders dashboard
    Tool: Bash
    Steps: Start orchestrator, run `gh-symphony status --watch` in a PTY, capture first frame
    Expected: Output contains column headers (ID, STAGE, PID, AGE/TURN, TOKENS, SESSION, EVENT)
    Evidence: .sisyphus/evidence/task-10-watch-mode.txt

  Scenario: Non-TTY fallback to JSON
    Tool: Bash
    Steps: Run `gh-symphony status --watch | head -1` (piped, non-TTY)
    Expected: Output is valid JSON
    Evidence: .sisyphus/evidence/task-10-non-tty.txt

  Scenario: Single status query still works
    Tool: Bash
    Steps: Run `gh-symphony status` (without --watch)
    Expected: Output renders status (legacy or new format), no crash
    Evidence: .sisyphus/evidence/task-10-single-query.txt

  Scenario: Clean shutdown on SIGINT
    Tool: Bash
    Steps: Start `status --watch`, send SIGINT, check cursor is visible
    Expected: Process exits cleanly, no dangling escape sequences
    Evidence: .sisyphus/evidence/task-10-shutdown.txt
  ```

  **Commit**: YES | Message: `feat(cli): integrate Elixir-parity dashboard into status --watch` | Files: [packages/cli/src/commands/status.ts]

<!-- TASKS END -->

## Final Verification Wave (4 parallel agents, ALL must APPROVE)

- [x] F1. Plan Compliance Audit — oracle

  **What to do**: Verify all implemented changes align with the Symphony spec and this plan's constraints.

  **Recommended Agent Profile**:
  - Category: `oracle` — Reason: Spec compliance requires deep cross-referencing

  **QA Scenarios**:

  ```
  Scenario: Symphony spec unmodified
    Tool: Bash
    Steps: Run `git diff HEAD -- docs/symphony-spec.md`
    Expected: Empty output (zero changes to spec file)
    Evidence: .sisyphus/evidence/f1-spec-unmodified.txt

  Scenario: turn_count usage is spec-aligned
    Tool: Bash
    Steps: Run `grep -rn "turnCount\|turn_count" packages/core/src/contracts/status-surface.ts packages/orchestrator/src/service.ts packages/cli/src/dashboard/renderer.ts`
    Expected: All occurrences map to optional fields in status-surface types or read from worker state (Symphony spec 4.1.6, 13.3). No turn_count used as a required field.
    Evidence: .sisyphus/evidence/f1-turn-count-audit.txt

  Scenario: No new required fields on existing types
    Tool: Bash
    Steps: Run `git diff HEAD -- packages/core/src/contracts/status-surface.ts` and verify every new field line contains `?:` (optional marker)
    Expected: All new fields are optional
    Evidence: .sisyphus/evidence/f1-optional-fields.txt
  ```

- [x] F2. Code Quality Review — unspecified-high

  **What to do**: Run full CI validation suite and review code quality of all changed files.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: Comprehensive code quality checks across multiple packages

  **QA Scenarios**:

  ```
  Scenario: Full CI passes
    Tool: Bash
    Steps: Run `pnpm lint && pnpm test && pnpm typecheck && pnpm build`
    Expected: All four commands exit with code 0
    Evidence: .sisyphus/evidence/f2-ci-pass.txt

  Scenario: No external TUI dependencies added
    Tool: Bash
    Steps: Run `grep -r "blessed\|ink\|terminal-kit\|ncurses\|charm\|bubbletea" packages/cli/package.json`
    Expected: No matches found (exit code 1)
    Evidence: .sisyphus/evidence/f2-no-tui-deps.txt

  Scenario: No `any` types in new files
    Tool: Bash
    Steps: Run `grep -n ": any\|as any" packages/cli/src/ansi.ts packages/cli/src/dashboard/renderer.ts`
    Expected: No matches (exit code 1) or only justified uses
    Evidence: .sisyphus/evidence/f2-no-any.txt
  ```

- [x] F3. Real Manual QA — unspecified-high

  **What to do**: Execute end-to-end QA scenarios verifying the dashboard renders correctly with various inputs.

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: End-to-end testing with playwright skill if browser UI involved
  - Skills: [] — CLI-only, no browser needed

  **QA Scenarios**:

  ```
  Scenario: Dashboard renderer produces valid output for all fixtures
    Tool: Bash
    Steps: Run `npx vitest run packages/cli/src/dashboard/renderer.test.ts`
    Expected: All tests pass, exit code 0
    Evidence: .sisyphus/evidence/f3-renderer-tests.txt

  Scenario: Column alignment at width 80
    Tool: Bash
    Steps: Write a node script that imports renderDashboard with busy fixture at terminalWidth=80, noColor=true. For each line, assert `line.length <= 80`.
    Expected: No line exceeds 80 characters
    Evidence: .sisyphus/evidence/f3-width-80.txt

  Scenario: Column alignment at width 200
    Tool: Bash
    Steps: Same script with terminalWidth=200. Verify EVENT column expands to fill extra space.
    Expected: Lines use available width, EVENT column wider than at 115
    Evidence: .sisyphus/evidence/f3-width-200.txt

  Scenario: Non-TTY JSON fallback
    Tool: Bash
    Steps: Run `node -e "process.stdout.isTTY = false; ..."` simulating non-TTY, verify JSON output
    Expected: Output is valid JSON (parseable by JSON.parse)
    Evidence: .sisyphus/evidence/f3-non-tty-json.txt
  ```

- [x] F4. Scope Fidelity Check — deep

  **What to do**: Verify the implementation matches the plan scope exactly — nothing extra, nothing missing.

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: Requires careful cross-referencing of plan vs implementation

  **QA Scenarios**:

  ```
  Scenario: start command unchanged
    Tool: Bash
    Steps: Run `git diff HEAD -- packages/cli/src/commands/start.ts`. Verify only import changes (from ../ansi.js) and removal of inline ANSI helpers. No behavioral changes.
    Expected: Only import refactoring, zero logic changes in handler/logTickResult/startDaemon functions
    Evidence: .sisyphus/evidence/f4-start-unchanged.txt

  Scenario: Deferred items not included
    Tool: Bash
    Steps: Run `grep -rn "throughput\|Throughput\|projectUrl\|dashboardUrl\|issues.per.hour" packages/cli/src/dashboard/renderer.ts packages/cli/src/commands/status.ts`
    Expected: No matches — these are explicitly deferred to Phase 2
    Evidence: .sisyphus/evidence/f4-no-deferred.txt

  Scenario: All plan deliverables present
    Tool: Bash
    Steps: Verify files exist: packages/cli/src/ansi.ts, packages/cli/src/dashboard/renderer.ts, packages/cli/src/dashboard/renderer.test.ts, packages/core/src/observability/snapshot-builder.test.ts, packages/cli/src/dashboard/__tests__/fixtures/*.snapshot.json
    Expected: All files exist
    Evidence: .sisyphus/evidence/f4-deliverables.txt
  ```

## Commit Strategy

| Order | Commit                                                             | Files                                         | Depends On |
| ----- | ------------------------------------------------------------------ | --------------------------------------------- | ---------- |
| 1     | `refactor(cli): extract shared ANSI utilities to ansi.ts`          | packages/cli/src/ansi.ts, start.ts, status.ts | —          |
| 2     | `test(core): add baseline tests for snapshot builder`              | snapshot-builder.test.ts                      | —          |
| 3     | `fix(core): add missing barrel exports` (if needed)                | core/index.ts                                 | —          |
| 4     | `feat(core): extend status-surface types with live worker fields`  | status-surface.ts                             | 3          |
| 5     | `feat(core): pass through live worker fields in snapshot builder`  | snapshot-builder.ts, snapshot-builder.test.ts | 2, 4       |
| 6     | `test(cli): add dashboard renderer test fixtures`                  | fixtures/\*.json                              | —          |
| 7     | `feat(orchestrator): poll live worker state during reconciliation` | service.ts                                    | 4, 5       |
| 8     | `feat(cli): add Elixir-parity dashboard renderer`                  | renderer.ts, renderer.test.ts                 | 1, 4, 5, 6 |
| 9     | `feat(cli): integrate dashboard into status --watch`               | status.ts                                     | 7, 8       |

## Success Criteria

1. `pnpm lint && pnpm test && pnpm typecheck && pnpm build` all pass
2. `gh-symphony status --watch` renders a full-screen Elixir-parity dashboard with:
   - Header showing agents count, runtime, tokens in/out/total, rate limits
   - Running table with ID, STAGE, PID, AGE/TURN, TOKENS, SESSION, EVENT columns
   - Correct status dot colors per event type
   - Backoff queue with retry info
   - Multi-tenant sections
3. Non-TTY environments get JSON output
4. `start` command behavior completely unchanged
5. All new type fields are optional (zero breaking changes)
6. Zero external TUI dependencies added
