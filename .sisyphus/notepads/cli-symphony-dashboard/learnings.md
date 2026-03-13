# CLI Symphony Dashboard - Learnings

## Task 1: Extract Shared ANSI Utilities

### Key Patterns Discovered

1. **ANSI Color Function Pattern**
   - start.ts uses a two-layer pattern: `_bold()` (raw) + `bold()` (noColor-aware)
   - status.ts uses simple functions without noColor support
   - Unified pattern: export noColor-aware wrappers that check global state

2. **noColor State Management**
   - start.ts: Direct assignment `noColor = options.noColor`
   - Refactored to: `setNoColor(options.noColor)` for encapsulation
   - Allows future middleware/hooks to intercept color state changes

3. **stripAnsi Implementation**
   - Original status.ts: `/\x1b\[[0-9;]*m/g` with eslint-disable comment
   - TypeScript LSP complains about control characters in regex literals
   - Solution: Use `RegExp` constructor with template string: `new RegExp(\`${ESC}\\[[0-9;]*m\`, "g")`
   - This avoids the control character warning while maintaining identical behavior

4. **Export Strategy**
   - Export all color functions (bold, dim, green, red, yellow, cyan, magenta, blue)
   - Export utility functions (stripAnsi, setNoColor, getNoColor)
   - Export screen control functions (clearScreen, hideCursor, showCursor) for future dashboard
   - Export ESC constant for regex construction in other modules

### Code Organization

- **ansi.ts**: Pure utility module, no dependencies
- **start.ts**: Imports 7 functions (bold, dim, green, red, yellow, cyan, setNoColor)
- **status.ts**: Imports 7 functions (bold, dim, green, red, yellow, cyan, stripAnsi)
- Future dashboard can import all 15 exports as needed

### Build Verification

- LSP diagnostics: CLEAN on all modified files
- Core and orchestrator packages: BUILD SUCCESS
- No regressions or import errors
- Commit: `refactor(cli): extract shared ANSI utilities to ansi.ts`

### Next Steps

- Task 2: Create dashboard renderer using exported ANSI utilities
- Task 3: Integrate dashboard into status command with --dashboard flag

## Task 3: Audit Core Barrel Exports

### Audit Results

**Status**: ✅ PASSED - All required types properly exported

### Export Chain Verified

1. **Main Barrel** (`packages/core/src/index.ts`)
   - Line 4: `export * from "./contracts/status-surface.js"`
   - Line 13: `export * from "./observability/index.js"`

2. **Observability Sub-Barrel** (`packages/core/src/observability/index.ts`)
   - Line 2: `export * from "./snapshot-builder.js"`

### Required Types Confirmed

From `status-surface.ts`:
- ✅ `TenantStatusSnapshot` - Used for dashboard state display
- ✅ `OrchestratorRunRecord` - Individual run details
- ✅ `RuntimeSessionRow` - Session metadata
- ✅ `OrchestratorRunStatus` - Run status enum
- ✅ `RetryKind` - Retry classification

From `snapshot-builder.ts`:
- ✅ `buildTenantSnapshot()` - Snapshot construction function
- ✅ `SnapshotInput` - Input type for snapshot builder

### Build Verification

- `pnpm --filter @gh-symphony/core build` → SUCCESS
- TypeScript declarations generated correctly
- No missing exports detected

### Key Insight

The barrel export structure is already correct and follows best practices:
- Direct exports from status-surface.ts (core contracts)
- Transitive exports through observability/index.ts (observability utilities)
- Clean separation of concerns without exposing internal module structure

No changes were needed. The core package is ready for dashboard integration.

### Next Steps

- Task 4: Add new types to status-surface.ts (TenantDashboardSnapshot, etc.)
- Task 5: Implement dashboard renderer using verified exports

## Task 2: Add Snapshot Builder Baseline Tests

### Test Strategy

**Objective**: Create comprehensive baseline tests for `buildTenantSnapshot()` before Task 6 modifies it to pass through live worker fields.

**Test File**: `packages/core/src/observability/snapshot-builder.test.ts`

### Key Patterns Discovered

1. **Helper Function Pattern**
   - `mockTenant()`: Creates minimal `OrchestratorTenantConfig` with sensible defaults
   - `mockRun()`: Creates minimal `OrchestratorRunRecord` with all required fields
   - Both support `overrides?: Partial<T>` for test customization
   - Reduces boilerplate and improves test readability

2. **Test Organization**
   - 18 test cases organized by feature (health derivation, queue partitioning, aggregation, etc.)
   - Each test focuses on a single behavior
   - Clear test names describe expected outcome

3. **Health Derivation Logic**
   - Priority: `lastError` → "degraded" (highest)
   - Then: `activeRuns.length > 0` → "running"
   - Else: → "idle"
   - Tests verify all three states and priority ordering

4. **Retry Queue Partitioning**
   - Only runs with `status === "retrying" && retryKind != null` appear in retryQueue
   - Runs with `status === "retrying"` but `retryKind === null` are excluded
   - Multiple retry kinds (failure, recovery, continuation) handled correctly

5. **Token Aggregation Behavior**
   - Uses `allRuns ?? activeRuns` for aggregation (prefers complete history)
   - Sums `inputTokens`, `outputTokens`, `totalTokens` across all runs
   - Calculates `secondsRunning` from earliest `startedAt` to latest `completedAt` or `lastTickAt`
   - Gracefully handles missing `tokenUsage` (treats as 0)

6. **Optional Field Handling**
   - `runtimeSession`: Defaults to `null` when undefined
   - `tokenUsage`: Skipped in aggregation when undefined
   - `rateLimits`: Defaults to `null` when not provided
   - No crashes on missing optional fields

### Test Coverage

- ✅ Idle state (no runs, no error)
- ✅ Running state (active runs present)
- ✅ Degraded state (error present)
- ✅ Degraded priority over running
- ✅ Retry queue partitioning (status + retryKind filtering)
- ✅ Token aggregation (multiple runs, correct sums)
- ✅ Missing tokenUsage handling
- ✅ Missing runtimeSession handling
- ✅ Tenant metadata preservation
- ✅ Summary counts preservation
- ✅ allRuns vs activeRuns fallback
- ✅ rateLimits handling (present and absent)
- ✅ activeRun field mapping
- ✅ secondsRunning calculation (startedAt to completedAt)
- ✅ lastTickAt as end time fallback
- ✅ Retrying without retryKind exclusion

### Build Verification

- `npx vitest run packages/core/src/observability/snapshot-builder.test.ts` → **18 PASSED**
- All tests pass on first run
- No regressions or failures
- Ready for Task 6 modifications

### Key Insight

The snapshot builder is well-designed with clear separation of concerns:
- Health derivation is simple and predictable
- Retry queue filtering is explicit (requires both status AND retryKind)
- Token aggregation is flexible (allRuns preference with activeRuns fallback)
- Optional fields are handled gracefully throughout

This test suite provides a solid safety net for Task 6 when adding live worker field pass-through.

### Next Steps

- Task 4: Extend core types with live worker fields (turnCount, lastEvent, etc.)
- Task 6: Modify snapshot builder to pass through new fields (tests will be extended)

## Task 5: Worker State Server Response Shape Audit (2026-03-13)

### Key Findings

**WorkerRuntimeState Type** (from state-server.ts):
- `status`: "idle" | "starting" | "running" | "failed" | "completed"
- `tokenUsage`: { inputTokens, outputTokens, totalTokens } — updated from codex events
- `sessionInfo`: { threadId, turnCount } — optional, can be null
- `run`: null or object with processId, lastError, repository details
- `workflow`: parsed WORKFLOW.md config or null

**Critical Fields for Dashboard**:
1. **tokenUsage** ✓ Present
   - Updated from codex "thread/tokenUsage/updated" or "total_token_usage" events
   - Default: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

2. **sessionInfo.turnCount** ✓ Present
   - Updated at line 593 in index.ts during multi-turn loop
   - Default: 0
   - sessionInfo itself can be null (optional field)

3. **lastEvent** ✗ NOT Present
   - **Fallback**: Use `status` field instead
   - **Alternative**: Use `run.lastError` for error details
   - Status transitions: idle → starting → running → completed/failed

4. **processId** ✓ Present
   - Located at `run.processId`
   - Set at line 125 in index.ts when childProcess launches
   - Can be null if process not yet started

### Runtime State Updates (index.ts)

- **Status**: Lines 122, 134, 145, 152, 429
- **Token Usage**: Lines 475-478 (from codex events)
- **Turn Count**: Line 593 (in multi-turn loop)
- **Process ID**: Line 125 (when childProcess launches)
- **Last Error**: Lines 137-140, 148, 156, 432

### Safe Access Patterns

```typescript
// Token usage (always present)
const tokens = state.tokenUsage.totalTokens;

// Turn count (sessionInfo can be null)
const turnCount = state.sessionInfo?.turnCount ?? 0;

// Process ID (run can be null)
const pid = state.run?.processId ?? null;

// Status (always present, use instead of lastEvent)
const status = state.status;

// Error details (run can be null)
const error = state.run?.lastError ?? null;
```

### Impact on Task 8 (Live Worker Polling)

Task 8 will call `/api/v1/state` endpoint and needs to:
1. ✓ Extract tokenUsage fields directly
2. ✓ Extract turnCount with null-safe access
3. ✓ Use status field instead of lastEvent
4. ✓ Extract processId with null-safe access
5. ✓ Handle null run and sessionInfo gracefully

All required fields are present and accessible. No code modifications needed to worker.


## Task 4: Extend Core Types for Live Worker Data (2026-03-13)

### Changes Made

**File**: `packages/core/src/contracts/status-surface.ts`

#### 1. OrchestratorRunRecord (lines 70-84)
Added 4 optional fields after existing `tokenUsage?` field:
- `turnCount?: number` — Turn count from live worker polling (Symphony spec 4.1.6)
- `startedAtMs?: number` — Worker start time for AGE calculation (milliseconds since epoch)
- `lastEvent?: string | null` — Last event description from worker
- `lastEventAt?: string | null` — Last event timestamp

#### 2. LiveWorkerState (new type, lines 95-103)
New exported type for live worker state representation:
```typescript
export type LiveWorkerState = {
  tokenUsage: { inputTokens, outputTokens, totalTokens } | null;
  sessionId: string | null;
  turnCount: number;
  lastError: string | null;
  lastEvent: string | null;
  lastEventAt: string | null;
  status: "idle" | "starting" | "running" | "failed" | "completed";
};
```

#### 3. TenantStatusSnapshot.activeRuns (lines 120-135)
Added 6 optional fields to activeRuns array element after existing `port` field:
- `processId?: number | null` — Process ID from live worker
- `turnCount?: number` — Turn count from live worker
- `startedAt?: string | null` — Worker start timestamp
- `lastEvent?: string | null` — Last event description
- `lastEventAt?: string | null` — Last event timestamp
- `tokenUsage?: { inputTokens, outputTokens, totalTokens }` — Token usage from live worker

### Backward Compatibility

✅ **All new fields are optional** (use `?:` syntax)
✅ **No existing fields modified** — only additions
✅ **No existing fields removed**
✅ **Core package typecheck passes** — no breaking changes
✅ **Core package build succeeds**

### Verification

- `pnpm --filter @gh-symphony/core typecheck` → **PASSED**
- `pnpm --filter @gh-symphony/core build` → **PASSED**
- Evidence file: `.sisyphus/evidence/task-4-typecheck.txt`
- Commit: `feat(core): extend status-surface types with live worker fields`

### Design Rationale

1. **LiveWorkerState Type**
   - Represents the complete state of a live worker
   - Mirrors the shape of `/api/v1/state` response from worker
   - Can be used by Task 8 (live worker polling) to type-check responses

2. **OrchestratorRunRecord Extensions**
   - `turnCount` and `startedAtMs` enable dashboard to calculate AGE and turn progress
   - `lastEvent` and `lastEventAt` provide user-facing event descriptions
   - All optional to maintain backward compatibility with existing code

3. **TenantStatusSnapshot.activeRuns Extensions**
   - Mirrors OrchestratorRunRecord fields for consistency
   - Allows dashboard to display live worker data in status snapshot
   - Optional fields mean existing code continues to work unchanged

### Next Steps

- Task 5: Modify snapshot builder to pass through new fields
- Task 6: Implement live worker polling in orchestrator
- Task 7: Create dashboard renderer using extended types

## Task 7: Dashboard Renderer Test Fixtures (2026-03-13)

### Fixtures created
- `idle.snapshot.json` — minimal single-tenant, health: idle, 0 runs
- `busy.snapshot.json` — single-tenant, health: running, 2 active runs with full live data (processId, turnCount, startedAt, lastEvent, lastEventAt, tokenUsage, runtimeSession)
- `backoff.snapshot.json` — single-tenant, health: degraded, 1 running + 3 retrying (failure/continuation/recovery), retryQueue populated
- `multi-tenant.snapshot.json` — array of 2 snapshots (2 active + 1 active/1 retrying)

### Key observations
- `runtimeSession` is an optional extension field not in the base TenantStatusSnapshot type — included in busy fixture for compaction testing (sessionId is 20 chars)
- `multi-tenant.snapshot.json` is a JSON array (not object) — renderer tests must handle both shapes
- `retryKind` values used: `"failure"`, `"continuation"`, `"recovery"` — matches RetryKind enum
- `health` values: `"idle"` | `"running"` | `"degraded"` — all three covered across fixtures
- All 4 files validated with `node -e JSON.parse(...)` — no parse errors

## Task 6: Update Snapshot Builder to Pass Through Live Worker Data (2026-03-13)

### Changes Made

**File**: `packages/core/src/observability/snapshot-builder.ts`

#### activeRuns Mapping (lines 55-70)
Updated the `buildTenantSnapshot()` function to pass through new live worker fields:

**Added fields**:
- `processId: run.processId ?? null` — Process ID from live worker
- `turnCount: run.turnCount` — Turn count from live worker
- `startedAt: run.startedAt ?? null` — Worker start timestamp
- `lastEvent: run.lastEvent ?? null` — Last event description
- `lastEventAt: run.lastEventAt ?? null` — Last event timestamp
- `tokenUsage: run.tokenUsage` — Token usage from live worker

**Existing fields preserved**:
- `runId`, `issueIdentifier`, `issueState`, `status`, `retryKind`, `port`, `runtimeSession`

### Test Coverage

**File**: `packages/core/src/observability/snapshot-builder.test.ts`

Added 2 new tests (total: 20 tests):

1. **"passes through processId, turnCount, startedAt, lastEvent, lastEventAt, tokenUsage to activeRuns"**
   - Creates a run with all live worker fields set to known values
   - Verifies each field is correctly passed through to activeRuns[0]
   - Tests: processId=54321, turnCount=5, startedAt="2024-01-01T00:01:00Z", lastEvent="Analyzing code structure", lastEventAt="2024-01-01T00:04:30Z", tokenUsage with specific token counts

2. **"sets live fields to null/undefined when missing from run record"**
   - Creates a run with all live worker fields undefined/null
   - Verifies correct null/undefined handling in snapshot
   - Tests: processId=null, turnCount=undefined, startedAt=null, lastEvent=null, lastEventAt=null, tokenUsage=undefined

### Verification Results

✅ **All 20 tests pass**
- 18 existing tests continue to pass (no regressions)
- 2 new tests verify live worker field pass-through
- Test output: `.sisyphus/evidence/task-6-snapshot-passthrough.txt`

✅ **TypeScript strict mode passes**
- `pnpm --filter @gh-symphony/core typecheck` → PASSED
- No type errors or warnings
- Evidence file: `.sisyphus/evidence/task-6-compat.txt`

### Key Insights

1. **Field Handling Pattern**
   - Nullable fields (processId, startedAt, lastEvent, lastEventAt) use `?? null` to convert undefined to null
   - Optional numeric fields (turnCount) pass through as-is (undefined if not set)
   - Optional object fields (tokenUsage) pass through as-is (undefined if not set)

2. **Backward Compatibility**
   - All new fields are optional in TenantStatusSnapshot.activeRuns (from Task 4)
   - Existing code that doesn't use these fields continues to work unchanged
   - Snapshot builder is transparent — it passes through whatever the run record contains

3. **Test Strategy**
   - Helper functions (mockRun, mockTenant) make it easy to test with specific field combinations
   - Testing both "all fields present" and "all fields missing" cases ensures robustness
   - No changes to health derivation, retry queue, or token aggregation logic

### Next Steps

- Task 7: Implement live worker polling in orchestrator (fetch /api/v1/state from worker)
- Task 8: Create dashboard renderer using extended snapshot data
- Task 9: Integrate dashboard into status command with --dashboard flag

## Task 8: Live Worker Polling in Orchestrator (2026-03-13)

### Changes Made

**File**: `packages/orchestrator/src/service.ts`

#### A. fetchLiveWorkerState() — Extended return type + parsing + timeout

1. **Return type extended** with `turnCount: number | null`, `lastEvent: string | null`, `lastEventAt: string | null`
2. **AbortSignal.timeout(2000)** added to fetch call — prevents slow workers from blocking the reconciliation tick
3. **Parsing updated** to extract `state.sessionInfo?.turnCount`, use `state.status` as `lastEvent` fallback
4. **All null-return paths updated** (early return, error response, catch block) to include new null fields
5. **Type cast for state** extended with `status?: string` field

#### B. fetchWorkerRunInfo() — Pass-through new fields

1. **Return type extended** to match fetchLiveWorkerState() shape
2. **Persisted fallback path** now includes `turnCount`, `lastEvent`, `lastEventAt` from liveState

#### C. reconcileRun() "running" branch — Enriched with live data

1. **Added `fetchLiveWorkerState()` call** in the running-worker branch (was previously just saving status + updatedAt)
2. **OrchestratorRunRecord enrichment**: turnCount, tokenUsage, lastEvent, lastEventAt populated from live state
3. **Fallback safety**: Uses `?? undefined` for optional fields, `?? run.tokenUsage` for tokenUsage to preserve existing data

### Design Decisions

1. **2s timeout via AbortSignal.timeout(2000)** — Standard Node.js API, no dependencies needed. Prevents slow/unresponsive workers from blocking orchestration ticks.
2. **status as lastEvent fallback** — Worker has no discrete "lastEvent" field; status ("idle"/"starting"/"running"/"completed"/"failed") serves as a proxy.
3. **lastEventAt hardcoded to null** — Worker doesn't emit event timestamps. Could be derived from server response headers in future.
4. **tokenUsage fallback to run.tokenUsage** — If live fetch fails, preserve whatever token data was previously captured rather than overwriting with null.

### Verification

- `pnpm --filter @gh-symphony/orchestrator typecheck` → **PASSED**
- `pnpm --filter @gh-symphony/orchestrator test` → **29/29 PASSED** (all 5 test files)
- `pnpm --filter @gh-symphony/orchestrator build` → **PASSED**
- Evidence: `.sisyphus/evidence/task-8-typecheck.txt`, `.sisyphus/evidence/task-8-orchestrator-tests.txt`

### Key Insight

The existing tests pass without modification because test fixtures don't exercise the live worker polling path directly (they mock process IDs but don't run actual HTTP servers). The fetchLiveWorkerState method gracefully returns nulls when no worker is reachable, preserving all existing behavior.

## Task 9: Dashboard Renderer (2026-03-13)

### Changes Made

**Files created**:
- `packages/cli/src/dashboard/renderer.ts` — Pure function renderer
- `packages/cli/src/dashboard/renderer.test.ts` — 6 tests using fixtures from Task 7

### Architecture

1. **Pure function**: `renderDashboard(TenantStatusSnapshot[], DashboardOptions) => string`
2. **No global mutation**: Uses local `Colors` object instead of `setNoColor()` for noColor support
3. **Deterministic testing**: `now?: number` option overrides `Date.now()` for stable age/retry calculations
4. **Column separators**: Added explicit 1-space separators between all columns (not in original spec, but needed to prevent columns from running together when values are truncated)

### Column Layout (with separators)

Total fixed width = 2(prefix) + 10(ID_HEADER) + 14(STAGE) + 8(PID) + 12(AGE_TURN) + 10(TOKENS) + 14(SESSION) + 6(separators) = 76
EVENT column = terminalWidth - 76 (min 5)

### Key Patterns

1. **ActiveRunView extension type**: `runtimeSession` exists per-run in fixtures but NOT in the core `TenantStatusSnapshot.activeRuns[]` type. Used `type ActiveRunView = ... & { runtimeSession?: ... }` to extend at cast site.
2. **ID truncation**: Long identifiers like `acme-corp/repo-alpha#42` truncate to 8 chars → `acme-cor`. Not ideal, but matches spec "ID=8 chars, truncate if needed".
3. **Session compaction**: IDs > 10 chars → `first4...last6` (e.g., `abcd...ef0123`)
4. **Backoff queue error display**: No `attempt` or `lastError` in retryQueue type. Used `retryKind` for kind label, looked up matching activeRun's `lastEvent` for error context.

### Verification

- `npx vitest run packages/cli/src/dashboard/renderer.test.ts` → **6/6 PASSED**
- `pnpm --filter @gh-symphony/cli typecheck` → **PASSED**
- LSP diagnostics: **CLEAN** on both files
- Evidence: task-9-idle-render.txt, task-9-busy-render.txt, task-9-nocolor.txt, task-9-width.txt

