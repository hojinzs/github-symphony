# Symphony Spec Gap Analysis

Date: 2026-03-19 (updated)
Previous: 2026-03-17
Spec version: Draft v1 (`docs/symphony-spec.md`)
Implementation: GitHub Symphony (pnpm monorepo, TypeScript)

---

## 1. Domain Model (Section 4)

### 1.1 Issue Entity (Section 4.1.1)

| Spec Field | Status | Notes |
|---|---|---|
| `id` | OK | GitHub node ID |
| `identifier` | OK | `owner/repo#number` format (vs Linear's `ABC-123`) |
| `title` | OK | |
| `description` | OK | |
| `priority` | **Always null** | GitHub has no native priority field — dispatch sort by priority is ineffective |
| `state` | OK | Extracted from GitHub Project V2 custom field |
| `branch_name` | **Always null** | GitHub does not provide tracker branch metadata |
| `url` | OK | |
| `labels` | OK | Lowercase-normalized, sorted |
| `blocked_by` | OK | Uses GitHub's direct `blockedBy` relationship (spec says derive from inverse `blocks`) |
| `created_at` | OK | |
| `updated_at` | OK | |

### 1.2 Workspace Key Normalization (Section 4.2)

| Spec Rule | Status | Notes |
|---|---|---|
| Only `[A-Za-z0-9._-]`, replace others with `_` | **Differs** | Implementation also lowercases and strips leading/trailing `_` — more aggressive than spec |
| Normalized Issue State: `trim` + `lowercase` | OK | `normalizeWorkflowState()` in `lifecycle.ts` |
| Session ID: `<thread_id>-<turn_id>` | OK | |

### 1.3 Live Session / Retry Entry Fields (Section 4.1.6-4.1.7)

- Mostly implemented.
- `last_reported_*_tokens` (for delta double-count prevention) — worker uses replacement strategy instead, structurally different but functionally equivalent.

### 1.4 Orchestrator Runtime State (Section 4.1.8)

| Spec Field | Status | Notes |
|---|---|---|
| `poll_interval_ms` | OK | Dynamic effective interval from per-project configs |
| `max_concurrent_agents` | OK | |
| `running` map | OK | Tracked via `OrchestratorRunRecord` with status `running` |
| `claimed` set | OK | `IssueOrchestrationState.claimed` |
| `retry_attempts` map | OK | `IssueOrchestrationRecord.retryEntry` |
| `completed` set | **Partial** | No explicit `completed` bookkeeping set; completed runs transition to `released` |
| `codex_totals` | OK | Aggregated in snapshot builder |
| `codex_rate_limits` | **NOT IMPLEMENTED** | See G7 |

---

## 2. Workflow Spec (Section 5)

### 2.1 File Discovery and Parsing (Section 5.1-5.2)

| Requirement | Status | Notes |
|---|---|---|
| YAML front matter + prompt body split | OK | |
| Non-map front matter → error | OK | |
| Prompt body trimming | OK | |
| Missing file → `missing_workflow_file` error | OK | |
| Empty config map if no front matter | **Differs** | Strict mode (default) requires front matter; legacy mode fallback exists |

### 2.2 Front Matter Schema (Section 5.3)

| Field | Status | Notes |
|---|---|---|
| `tracker.kind` | OK | `github-project` (spec: `linear`) |
| `tracker.endpoint` | OK | GitHub GraphQL default |
| `tracker.api_key` / `$VAR` | **Differs** | Supports `env:VAR` and `${VAR}` but NOT the spec's bare `$VAR_NAME` syntax |
| `tracker.project_slug` | **Changed** | Uses `projectId` (GitHub Project V2 ID) |
| `tracker.active_states` | OK | |
| `tracker.terminal_states` | OK | |
| `polling.interval_ms` | OK | |
| `workspace.root` | OK | `~` expansion supported |
| `hooks.*` | OK | 4 hooks + timeout_ms |
| `agent.max_concurrent_agents` | OK | |
| `agent.max_retry_backoff_ms` | OK | |
| `agent.max_concurrent_agents_by_state` | OK | State key normalized |
| `agent.max_turns` | OK | Default 20 |
| `codex.command` | OK | |
| `codex.approval_policy` | OK | Default `"never"` (auto-approve) |
| `codex.thread_sandbox` | OK | |
| `codex.turn_sandbox_policy` | OK | |
| `codex.turn_timeout_ms` | OK | |
| `codex.read_timeout_ms` | OK | |
| `codex.stall_timeout_ms` | OK | |

### 2.3 Prompt Template (Section 5.4)

| Requirement | Status | Notes |
|---|---|---|
| `issue` + `attempt` variables | **Partial** | See G14 — `issue` object is missing several spec-required fields |
| Strict mode (unknown variable → fail) | OK | |
| Liquid-compatible template engine | **NOT IMPLEMENTED** | See G15 — no filters, no iteration, no conditionals |
| Unknown filters must fail rendering | **NOT IMPLEMENTED** | No filter concept exists |
| Empty prompt body → fallback prompt | OK | Uses fallback prompt (text says "Linear" though tracker is GitHub) |

### 2.4 Workflow Validation Error Classes (Section 5.5)

| Error Class | Status | Notes |
|---|---|---|
| `missing_workflow_file` | OK | |
| `workflow_parse_error` | OK | |
| `workflow_front_matter_not_a_map` | OK | |
| `template_parse_error` | **Partial** | No separate parse-time template validation |
| `template_render_error` | OK | |

---

## 3. Configuration (Section 6)

| Requirement | Status | Notes |
|---|---|---|
| `$VAR_NAME` bare syntax indirection | **NOT IMPLEMENTED** | See G16 — uses `env:VAR` and `${VAR}` instead |
| `${VAR}` expansion | OK | |
| `~` path expansion | OK | |
| Dynamic reload (filesystem watch) | **NOT IMPLEMENTED** | See G1 — no `fs.watch`/`chokidar`; re-reads from git each tick |
| Invalid reload → keep last-known-good | OK | `usedLastKnownGood` flag |
| Dispatch preflight validation | OK | Re-validates each tick |
| Re-validate defensively during operations | OK | Workflow re-read each tick serves this purpose |

> **Dynamic Reload**: The spec (Section 6.2) requires watching `WORKFLOW.md` for changes and re-applying without restart. The implementation re-reads the workflow from the git repository on each poll tick, which provides functional equivalence for changes pushed to git, but does NOT implement filesystem watch for local edits. This is a partial conformance: changes are picked up at poll frequency (not immediately), and only changes in the git remote are detected (not local file edits).

---

## 4. Orchestration State Machine (Section 7-8)

### 4.1 Issue Orchestration States (Section 7.1)

| State | Status |
|---|---|
| `Unclaimed` | OK |
| `Claimed` | OK |
| `Running` | OK |
| `RetryQueued` | OK |
| `Released` | OK |

### 4.2 Run Attempt Lifecycle (Section 7.2)

| Phase | Status | Notes |
|---|---|---|
| `PreparingWorkspace` | OK | |
| `BuildingPrompt` | OK | Worker tracks `building_prompt` |
| `LaunchingAgentProcess` | OK | Worker sets `launching_agent` |
| `InitializingSession` | OK | Worker sets `initializing_session` |
| `StreamingTurn` | OK | |
| `Finishing` | OK | Worker sets `finishing` |
| `Succeeded` | OK | |
| `Failed` | OK | |
| `TimedOut` | OK | |
| `Stalled` | OK | |
| `CanceledByReconciliation` | OK | |

### 4.3 Polling & Dispatch (Section 8.1-8.2)

| Requirement | Status | Notes |
|---|---|---|
| Fixed cadence polling | OK | |
| Reconciliation → Validation → Fetch → Sort → Dispatch | OK | |
| Priority asc → createdAt asc → identifier tiebreaker | OK | Priority is always null in GitHub adapter, so effectively only createdAt-based |
| Blocker rule (Todo state with non-terminal blocker → skip) | OK | `blockerCheckStates` config-based |
| Global + per-state concurrency | OK | |

### 4.4 Retry & Backoff (Section 8.4)

| Requirement | Status | Notes |
|---|---|---|
| Continuation retry ~1s | OK | `CONTINUATION_RETRY_DELAY_MS` |
| `min(10000 * 2^(attempt-1), max_retry_backoff_ms)` | OK | |
| Retry timer fired → re-fetch + re-dispatch or release | OK | |
| Cancel existing retry timer for same issue before new | OK | |

### 4.5 Reconciliation (Section 8.5)

| Requirement | Status | Notes |
|---|---|---|
| Stall detection (Part A) | OK | 30min fallback (`STUCK_WORKER_TIMEOUT_MS`) + workflow-configured `stallTimeoutMs` |
| Tracker state refresh (Part B) | OK | `syncActiveRunIssueStates()` calls `fetchIssueStatesByIds()` |
| Terminal → stop worker + clean workspace | OK | |
| Active → update running entry state | OK | |
| Non-active/non-terminal → stop worker (no cleanup) | OK | |
| Stall timeout `<= 0` disables detection | **Unverified** | 30min fallback may still trigger even when stall detection is disabled |

### 4.6 Startup Terminal Workspace Cleanup (Section 8.6)

OK: `performStartupCleanup()` calls `listIssuesByStates()` with terminal states, then removes workspaces.

---

## 5. Workspace Management (Section 9)

| Requirement | Status | Notes |
|---|---|---|
| `<root>/<sanitized_identifier>` path | **Changed** | `<root>/<projectId>/issues/<key>/repository` (multi-tenant) |
| Workspace reuse across runs | OK | |
| `after_create` hook (new creation only) | OK | |
| `before_run` hook (failure aborts attempt) | OK | |
| `after_run` hook (failure ignored) | OK | |
| `before_remove` hook (failure ignored, cleanup proceeds) | OK | ~~Previously `cleanup_blocked`~~ Now fixed: logs warning and continues cleanup |
| Safety: workspace path inside root | OK | `resolveWorkspaceDirectory()` validates prefix |
| Safety: sanitized identifier | OK | `deriveIssueWorkspaceKey()` |
| Safety: cwd == workspace_path before agent launch | OK | |
| Hook timeout (`hooks.timeout_ms`) | OK | SIGTERM → 5s grace → SIGKILL |
| Non-positive timeout_ms → fallback to default | **Unverified** | |

---

## 6. Agent Runner Protocol (Section 10)

### 6.1 Launch & Handshake (Section 10.1-10.2)

| Requirement | Status | Notes |
|---|---|---|
| `bash -lc <codex.command>` | OK | |
| `initialize` → `initialized` → `thread/start` → `turn/start` | OK | |
| `clientInfo`, `capabilities` in initialize | OK | |
| Session ID = `<thread_id>-<turn_id>` | OK | |
| Max line size 10 MB recommended | **Unverified** | |

### 6.2 Streaming & Continuation (Section 10.3)

| Requirement | Status | Notes |
|---|---|---|
| Line-delimited JSON on stdout | OK | |
| Partial line buffering | OK | |
| Stderr ignored/logged (no JSON parsing) | OK | |
| Continuation turn (same threadId reused) | OK | |
| First turn = full prompt, continuation = guidance | OK | |
| max_turns limit | OK | |
| App-server alive across continuation turns | OK | |

### 6.3 Approval & Tool Policy (Section 10.5)

| Requirement | Status | Notes |
|---|---|---|
| Documented approval policy | OK | `approvalPolicy: "never"`, `sandbox: "danger-full-access"` |
| User input → hard failure | OK | |
| Unsupported tool call → error response + continue | OK | |
| `linear_graphql` tool extension | **Adapted** | `github_graphql` tool instead (targets GitHub GraphQL) |

### 6.4 Timeouts (Section 10.6)

| Requirement | Status |
|---|---|
| `read_timeout_ms` | OK (default 5000ms) |
| `turn_timeout_ms` | OK (default 3600000ms) |
| `stall_timeout_ms` | OK (orchestrator-side detection) |

### 6.5 Error Mapping (Section 10.6)

| Spec Error Category | Status | Notes |
|---|---|---|
| `codex_not_found` | **Unverified** | |
| `invalid_workspace_cwd` | OK | |
| `response_timeout` | OK | |
| `turn_timeout` | OK | |
| `port_exit` | OK | Process exit detection |
| `response_error` | OK | |
| `turn_failed` | OK | |
| `turn_cancelled` | OK | |
| `turn_input_required` | OK | |

---

## 7. Issue Tracker Integration (Section 11)

> The spec targets Linear; the implementation targets GitHub Projects V2. This is an intentional adaptation.

### 7.1 Required Operations (Section 11.1)

| Operation | Status | Notes |
|---|---|---|
| `fetch_candidate_issues()` | OK | `listIssues()` |
| `fetch_issues_by_states(state_names)` | OK | `listIssuesByStates()` — ~~Previously missing~~ Now implemented (full fetch + post-filter) |
| `fetch_issue_states_by_ids(issue_ids)` | OK | `fetchIssueStatesByIds()` — ~~Previously missing~~ Now implemented with GraphQL node lookup |

### 7.2 Query Semantics (Section 11.2)

| Requirement | Status | Notes |
|---|---|---|
| Project filter on query | OK | GitHub Project V2 ID used (vs Linear `slugId`) |
| Query-time state filtering | **NOT IMPLEMENTED** | Full fetch then post-filter — inefficient for large projects |
| Pagination | OK | |
| Default page size 50 | **Differs** | Default 25 |
| Network timeout 30000ms | **NOT IMPLEMENTED** | See G5 — relies on fetch() default timeout |

### 7.3 Normalization (Section 11.3)

| Requirement | Status |
|---|---|
| Labels lowercase | OK |
| blocked_by derivation | OK (uses GitHub's direct `blockedBy`) |
| Priority integer (non-integers → null) | N/A (always null — GitHub has no priority) |
| ISO-8601 timestamp parsing | OK |

### 7.4 Error Handling (Section 11.4)

| Spec Category | Implementation | Notes |
|---|---|---|
| `unsupported_tracker_kind` | **Not mapped** | Custom error flow |
| `missing_tracker_api_key` | **Not mapped** | |
| `missing_tracker_project_slug` | **Not mapped** | |
| `linear_api_request` | `GitHubTrackerHttpError` | |
| `linear_api_status` | `GitHubTrackerHttpError` | |
| `linear_graphql_errors` | `GitHubTrackerQueryError` | |
| `linear_unknown_payload` | **Not mapped** | |
| `linear_missing_end_cursor` | **Not mapped** | |

Partial: custom error classes exist but don't use spec-recommended category names.

---

## 8. Prompt Construction (Section 12)

| Requirement | Status | Notes |
|---|---|---|
| Render with strict variable checking | OK | |
| Render with strict filter checking | **NOT IMPLEMENTED** | No filter concept |
| Convert issue object keys to strings | OK | |
| Preserve nested arrays/maps for iteration | **NOT IMPLEMENTED** | `labels` and `blockedBy` not passed to template at all |
| `attempt` available in template | OK | |

---

## 9. Observability (Section 13)

| Requirement | Status | Notes |
|---|---|---|
| Structured logging (issue_id, identifier, session_id) | OK | |
| Token accounting (prefer absolute totals) | OK | |
| Rate-limit tracking | **NOT IMPLEMENTED** | See G7 |
| Runtime seconds aggregation | OK | `secondsRunning` in snapshot |
| `turn_count` in running rows | OK | |
| HTML Dashboard (`/`) | **NOT IMPLEMENTED** | See G9 — JSON API only |
| `GET /api/v1/state` | OK | Endpoint path is `/api/v1/status` (minor name difference) |
| `GET /api/v1/<issue_identifier>` | OK | |
| `POST /api/v1/refresh` | OK | With coalescing (202 Accepted) |
| 405 Method Not Allowed | **Unverified** | |
| JSON error envelope `{error:{code, message}}` | OK | |
| Snapshot timeout/unavailable error modes | **Unverified** | |

---

## 10. Security & Safety (Section 15)

| Requirement | Status | Notes |
|---|---|---|
| Workspace path inside root | OK | |
| Agent cwd = workspace path | OK | |
| Sanitized workspace keys | OK | |
| `$VAR` indirection (no logged secrets) | OK | Env vars resolved without logging |
| Hook timeout required | OK | |
| Trust boundary documentation | **Partial** | Approval/sandbox settings documented, but no explicit trust posture statement |

---

## 11. Gap Summary (by priority)

### Critical (Section 18.1 Core Conformance gaps)

| # | Gap | Spec Section | Impact | Status |
|---|---|---|---|---|
| **G1** | **No filesystem watch on WORKFLOW.md** | 6.2, 18.1 | Medium — changes picked up at poll interval via git pull, but no instant local-file watch | **Open** |
| **G14** | **Prompt `issue` object missing required fields** | 5.4, 12.1 | High — `labels`, `blocked_by`, `priority`, `branch_name`, `created_at`, `updated_at` not available to templates | **New** |
| **G15** | **No Liquid-compatible template engine** | 5.4 | Medium — templates cannot iterate `labels`/`blockers` or use filters/conditionals | **New** |

### Major (functional differences)

| # | Gap | Spec Section | Notes | Status |
|---|---|---|---|---|
| **G4** | No query-time state filtering | 11.2 | Full project fetch then post-filter — inefficient at scale | **Open** |
| **G5** | No network timeout on tracker API | 11.2 | 30000ms timeout not applied; relies on fetch() default | **Open** |
| **G7** | No rate-limit tracking/exposure | 13.5 | `rate_limits` field not in API/snapshot; `codex_rate_limits` in runtime state not populated | **Open** |
| **G8** | Priority field always null | 4.1.1, 8.2 | GitHub has no priority — dispatch sort by priority is ineffective | **Open (platform limitation)** |
| **G16** | `$VAR_NAME` bare syntax not supported | 5.3.1, 6.1 | Spec says `$VAR_NAME`; implementation uses `env:VAR` and `${VAR}` | **New** |

### Minor (spec recommendations / cosmetic)

| # | Gap | Spec Section | Notes | Status |
|---|---|---|---|---|
| **G9** | No HTML Dashboard (`/`) | 13.7.1 | Spec says "optional but recommended" | **Open** |
| **G10** | Default page size 25 (spec 50) | 11.2 | Minor performance difference | **Open** |
| **G12** | Error category naming mismatch | 11.4 | Custom error classes exist but don't use spec category names | **Open** |
| **G13** | Workspace key normalization more aggressive | 4.2 | Lowercase + strip leading/trailing `_` (spec: only replace) | **Open** |
| **G17** | API endpoint path `/api/v1/status` vs spec `/api/v1/state` | 13.7.2 | Minor naming difference | **New** |
| **G18** | Fallback prompt mentions "Linear" | 5.4 | `"You are working on an issue from Linear."` — should say GitHub or be generic | **New** |
| **G19** | `completed` bookkeeping set not maintained | 4.1.8 | Completed issues transition to `released`; no separate tracking | **New** |
| **G20** | No `template_parse_error` class distinct from render error | 5.5 | Template parse validation not separated from render-time validation | **New** |

### Resolved (since 2026-03-17 analysis)

| # | Gap | Resolution |
|---|---|---|
| ~~G2~~ | `listIssuesByStates()` not implemented | **Resolved** — now implemented in `tracker-github`; used by `performStartupCleanup()` |
| ~~G3~~ | `fetchIssueStatesByIds()` not implemented | **Resolved** — now implemented in `tracker-github`; used by `syncActiveRunIssueStates()` |
| ~~G6~~ | `before_remove` hook failure → `cleanup_blocked` | **Resolved** — now logs warning and continues cleanup per spec |
| ~~G11~~ | No CLI `--help` flag | **Resolved** — CLI help is available |

### Intentional Differences (GitHub adaptation)

| # | Difference | Notes |
|---|---|---|
| **D1** | `tracker.kind: github-project` (spec: `linear`) | Intentional — GitHub target |
| **D2** | `tracker.project_slug` → `projectId` | GitHub Project V2 ID scheme |
| **D3** | `linear_graphql` → `github_graphql` tool | Target platform change |
| **D4** | Workspace path `<root>/<projectId>/issues/<key>/repository` | Multi-tenant support extension |
| **D5** | `WorkflowExecutionPhase` added (planning → human-review → implementation → awaiting-merge → completed) | GitHub workflow extension not in spec |
| **D6** | `assignedOnly` filtering option | GitHub-specific extension |
| **D7** | Additional front matter fields: `tracker.project_id`, `tracker.state_field`, `tracker.priority_field`, `tracker.blocker_check_states` | GitHub-specific schema extensions |
| **D8** | `agent.retry_base_delay_ms` extra config field | Extension: configurable base delay (spec hardcodes 10000ms) |

---

## 12. Test Gaps (Section 17)

| Test Area | Spec Requirement | Status |
|---|---|---|
| 17.1 Workflow/Config Parsing | Core | OK |
| 17.2 Workspace Safety | Core | OK |
| 17.3 Tracker Client | Core | OK — all three operations now implemented and tested |
| 17.4 Dispatch/Reconciliation/Retry | Core | OK |
| 17.5 App-Server Protocol | Core | OK |
| 17.6 Observability | Core | OK |
| 17.7 CLI Lifecycle | Core | OK |
| 17.8 Real Integration | Recommended | Partial — E2E harness exists but not automated in CI |

### Missing Test Coverage for Spec Conformance

- Prompt rendering with `labels`/`blocked_by` iteration (blocked by G14/G15)
- `$VAR_NAME` bare syntax resolution (blocked by G16)
- Rate-limit tracking in snapshot output (blocked by G7)
- `stall_timeout_ms <= 0` disabling stall detection
- Non-positive `hooks.timeout_ms` fallback to default
- 405 Method Not Allowed on HTTP API endpoints
- Snapshot timeout/unavailable error modes

---

## 13. Recommended Actions (prioritized)

### P0: Core Conformance

1. **G14 (Prompt Issue Variables)**: Add `labels`, `blocked_by`/`blockedBy`, `priority`, `branch_name`/`branchName`, `created_at`/`createdAt`, `updated_at`/`updatedAt` to `PromptIssueVariables`. These fields already exist on `TrackedIssue` but are not passed to the template renderer.

2. **G15 (Template Engine)**: Replace or extend the simple `{{variable}}` substitution with a Liquid-compatible template engine (e.g., `liquidjs`). This unblocks template iteration over `labels` and `blocked_by`, conditional logic for `attempt`, and filter support.

3. **G1 (Dynamic Reload)**: The current git-pull-per-tick approach provides delayed reload. For full spec conformance, add `fs.watch` or `chokidar` on the resolved `WORKFLOW.md` path with debounced reload. Alternatively, document this as an intentional divergence since git-based reload is arguably more robust for version-controlled workflows.

### P1: Major Functional

4. **G5 (Network Timeout)**: Add `AbortSignal.timeout(30000)` to GitHub GraphQL fetch calls in `tracker-github`.

5. **G16 ($VAR Syntax)**: Add support for bare `$VAR_NAME` syntax in `resolveEnvironmentValue()` alongside existing `env:VAR` and `${VAR}` formats.

6. **G7 (Rate Limits)**: Extract rate-limit data from agent events and GitHub API response headers; expose in snapshot API.

### P2: Minor / Cosmetic

7. **G17 (API Path)**: Rename `/api/v1/status` to `/api/v1/state` or add alias.
8. **G18 (Fallback Prompt)**: Change fallback prompt from "Linear" to "GitHub" or make it generic.
9. **G10 (Page Size)**: Increase default page size from 25 to 50.
10. **G13 (Workspace Key)**: Consider removing the extra lowercase normalization to match spec exactly (may require migration).
