## 1. Dispatch Priority and Eligibility

- [x] 1.1 Add `sortCandidatesForDispatch()` function to `packages/orchestrator/src/service.ts` that sorts by priority (asc, null last) → createdAt (oldest first) → identifier (lexicographic)
- [x] 1.2 Integrate sort function into `reconcileWorkspace()` before candidate slicing
- [x] 1.3 Add `maxConcurrentByPhase` field to `WorkflowDefinition` in `packages/core/src/workflow/config.ts` with parser support in `packages/core/src/workflow/parser.ts`
- [x] 1.4 Implement per-phase concurrency check in dispatch loop: count active runs by phase and skip dispatch when phase limit reached
- [x] 1.5 Add blocker eligibility check: skip planning-phase issues when `blockedBy` contains non-terminal entries
- [x] 1.6 Write tests for dispatch sorting (priority ordering, null handling, tie-breaking)
- [x] 1.7 Write tests for per-phase concurrency limits (phase cap reached, no cap fallback, runtime reload)
- [x] 1.8 Write tests for blocker rule (active blocker blocks, terminal blocker allows, empty list allows)

## 2. Multi-Turn Worker

- [x] 2.1 Add `max_turns` configuration to `WorkflowRuntimeConfig` with default value 20, propagate via environment variable to worker
- [x] 2.2 Refactor worker `turn/completed` handler in `packages/worker/src/index.ts`: replace exit-on-complete with turn loop
- [x] 2.3 Implement tracker state refresh between turns using orchestrator or tracker API from worker context
- [x] 2.4 Implement continuation turn: send continuation guidance message (not full prompt) to existing thread via `turn/start`
- [x] 2.5 Add turn counter and max_turns exit condition
- [x] 2.6 Ensure codex process stays alive across continuation turns and is stopped only on worker run exit
- [x] 2.7 Write tests for multi-turn loop (continue when active, stop at max_turns, stop when non-actionable, tracker refresh failure)

## 3. Agent Session Timeouts

- [x] 3.1 Add `read_timeout_ms` (default 5000) and `turn_timeout_ms` (default 3600000) to runtime config, propagate to worker via env vars
- [x] 3.2 Wrap `sendRequest()` in `packages/worker/src/index.ts` with a timeout that rejects after `read_timeout_ms`
- [x] 3.3 Add per-turn absolute timeout: start timer on `turn/start`, cancel on turn completion, kill codex process on expiry
- [x] 3.4 Map timeout failures to `response_timeout` and `turn_timeout` error categories
- [x] 3.5 Write tests for read timeout (initialize timeout, thread/start timeout)
- [x] 3.6 Write tests for turn timeout (exceeds limit kills process, within limit proceeds normally)

## 4. User Input Required Hard Failure

- [x] 4.1 Add handler in worker message dispatch for `item/tool/requestUserInput` method and turn flags indicating input required
- [x] 4.2 On detection: terminate codex process, exit with `turn_input_required` error
- [x] 4.3 Write test for user_input_required detection and hard failure

## 5. Strict Prompt Template Rendering

- [x] 5.1 Add `strict` option (default `true`) to `renderPrompt()` in `packages/core/src/workflow/render.ts`
- [x] 5.2 After template substitution, check for remaining `{{...}}` patterns and throw `template_render_error` if found in strict mode
- [x] 5.3 Update all `renderPrompt()` call sites to handle the error appropriately
- [x] 5.4 Write tests for strict rendering (unknown variable fails, known variable succeeds, strict=false preserves old behavior)

## 6. Token Accounting and Rate-Limit Tracking

- [x] 6.1 Add token usage event parsing to worker codex message handler: detect `thread/tokenUsage/updated` and `total_token_usage` events, extract input/output/total counts
- [x] 6.2 Track cumulative token counts in worker runtime state and expose via worker state server (`/api/v1/state`)
- [x] 6.3 Persist final token counts in run state record on worker exit
- [x] 6.4 Add `codexTotals` (input_tokens, output_tokens, total_tokens, seconds_running) and `rateLimits` fields to `WorkspaceStatusSnapshot` in `packages/core/src/contracts/status-surface.ts`
- [x] 6.5 Implement orchestrator-side aggregation: sum token counts from completed run records into cumulative totals
- [x] 6.6 Track latest rate-limit payload from any codex event in orchestrator state
- [x] 6.7 Expose `codex_totals` and `rate_limits` in orchestrator status API response
- [x] 6.8 Write tests for token extraction (absolute totals preferred, delta ignored), aggregation, and API exposure

## 7. Structured Event Field Enrichment

- [x] 7.1 Add `issueId` field to all issue-related event types in `packages/core/src/observability/structured-events.ts`
- [x] 7.2 Add `sessionId` field (format: `<threadId>-<turnId>`) to session-related event types
- [x] 7.3 Update all event emission call sites in orchestrator and worker to populate new fields
- [x] 7.4 Write tests verifying event payloads include both identifiers

## 8. Refresh Endpoint

- [x] 8.1 Add `POST /api/v1/refresh` handler to `packages/orchestrator/src/status-server.ts`
- [x] 8.2 Implement coalescing logic: track pending refresh flag, respond with `coalesced: true` if already pending
- [x] 8.3 Wire refresh trigger into orchestrator poll loop to schedule an immediate tick
- [x] 8.4 Return 405 for non-POST methods on `/api/v1/refresh`
- [x] 8.5 Write tests for refresh endpoint (triggers reconciliation, coalesces concurrent requests, rejects wrong methods)
