# Symphony Spec Gap Analysis

Date: 2026-03-17
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
| `priority` | **Always null** | GitHub has no priority field — dispatch sort by priority is ineffective |
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

### 1.3 Live Session / Retry Entry Fields (Section 4.1.6-4.1.7)

- Mostly implemented.
- `last_reported_*_tokens` (for delta double-count prevention) — worker uses replacement strategy instead, structurally different.

---

## 2. Workflow Spec (Section 5)

### 2.1 File Discovery and Parsing (Section 5.1-5.2)

| Requirement | Status | Notes |
|---|---|---|
| YAML front matter + prompt body split | OK | |
| Non-map front matter → error | OK | |
| Prompt body trimming | OK | |
| Missing file → `missing_workflow_file` error | OK | |

### 2.2 Front Matter Schema (Section 5.3)

| Field | Status | Notes |
|---|---|---|
| `tracker.kind` | OK | `github-project` (spec: `linear`) |
| `tracker.endpoint` | OK | GitHub GraphQL default |
| `tracker.api_key` / `$VAR` | OK | `GITHUB_GRAPHQL_TOKEN` env var |
| `tracker.project_slug` | **Changed** | Uses `projectId` (GitHub Project V2 ID) |
| `tracker.active_states` | OK | |
| `tracker.terminal_states` | OK | |
| `polling.interval_ms` | OK | |
| `workspace.root` | OK | `~` expansion supported |
| `hooks.*` | OK | 4 hooks + timeout_ms |
| `agent.max_concurrent_agents` | OK | |
| `agent.max_retry_backoff_ms` | OK | |
| `agent.max_concurrent_agents_by_state` | OK | State key normalized |
| `codex.command` | OK | |
| `codex.approval_policy` | OK | Default `"never"` (auto-approve) |
| `codex.turn_timeout_ms` | OK | |
| `codex.read_timeout_ms` | OK | |
| `codex.stall_timeout_ms` | OK | |

### 2.3 Prompt Template (Section 5.4)

| Requirement | Status | Notes |
|---|---|---|
| `issue` + `attempt` variables | OK | |
| Strict mode (unknown variable → fail) | OK | |
| Strict mode (unknown filter → fail) | **Unverified** | Implementation supports `{{variable}}` substitution only; no filter concept |
| Empty prompt body → fallback prompt | OK | `"You are working on an issue from Linear."` |

---

## 3. Configuration (Section 6)

| Requirement | Status | Notes |
|---|---|---|
| `$VAR` indirection | OK | `${VAR}`, `env:VAR` formats |
| `~` path expansion | OK | |
| **Dynamic reload (watch)** | **NOT IMPLEMENTED** | Spec 6.2 requires file change detection and auto-reapply. Current implementation **requires restart** |
| Invalid reload → keep last-known-good | OK | `usedLastKnownGood` flag |
| Dispatch preflight validation | OK | Re-validates each tick |

> **Dynamic Reload is a core conformance requirement (Section 6.2, 18.1) and is not implemented.** The spec requires that changes to `WORKFLOW.md` automatically adjust polling cadence, concurrency limits, active/terminal states, codex settings, workspace paths/hooks, and prompt content for future runs without restart.

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
| `BuildingPrompt` | Partial | Worker tracks it but orchestrator does not reflect |
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
| Priority asc → createdAt asc → identifier tiebreaker | OK | But priority is always null, so effectively only createdAt-based |
| Blocker rule (Todo state with non-terminal blocker → skip) | OK | `blockerCheckStates` config-based |
| Global + per-state concurrency | OK | |

### 4.4 Retry & Backoff (Section 8.4)

| Requirement | Status |
|---|---|
| Continuation retry 1s | OK |
| `min(10000 * 2^(attempt-1), max_retry_backoff_ms)` | OK |
| Retry timer fired → re-fetch + re-dispatch or release | OK |

### 4.5 Reconciliation (Section 8.5)

| Requirement | Status | Notes |
|---|---|---|
| Stall detection | OK | 30min fallback + workflow config |
| Tracker state refresh | OK | |
| Terminal → stop worker + clean workspace | OK | |
| Active → update running entry state | OK | |
| Non-active/non-terminal → stop worker (no cleanup) | OK | |

### 4.6 Startup Terminal Workspace Cleanup (Section 8.6)

- OK: `performStartupCleanup()` implemented.

---

## 5. Workspace Management (Section 9)

| Requirement | Status | Notes |
|---|---|---|
| `<root>/<sanitized_identifier>` path | **Changed** | `<root>/<projectId>/issues/<key>/repository` (multi-tenant) |
| Workspace reuse | OK | |
| `after_create` hook (new creation only) | OK | |
| `before_run` hook (failure aborts attempt) | OK | |
| `after_run` hook (failure ignored) | OK | |
| `before_remove` hook (failure ignored) | OK | Logs hook failure and proceeds with cleanup to `removed` per spec |
| Safety: workspace path inside root | OK | |
| Safety: sanitized identifier | OK | |
| Hook timeout (`hooks.timeout_ms`) | OK | SIGTERM → 5s grace → SIGKILL |

---

## 6. Agent Runner Protocol (Section 10)

### 6.1 Launch & Handshake (Section 10.1-10.2)

| Requirement | Status | Notes |
|---|---|---|
| `bash -lc <codex.command>` | OK | |
| `initialize` → `initialized` → `thread/start` → `turn/start` | OK | |
| `clientInfo`, `capabilities` in initialize | OK | |
| Session ID = `<thread_id>-<turn_id>` | OK | |

### 6.2 Streaming & Continuation (Section 10.3)

| Requirement | Status | Notes |
|---|---|---|
| Line-delimited JSON on stdout | OK | |
| Partial line buffering | OK | |
| Stderr ignored/logged | OK | |
| Continuation turn (same threadId reused) | OK | |
| First turn = full prompt, continuation = guidance | OK | |
| max_turns limit | OK | |

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

---

## 7. Issue Tracker Integration (Section 11)

> **This area has the largest spec divergence.** The spec targets Linear; the implementation targets GitHub Projects V2.

### 7.1 Required Operations (Section 11.1)

| Operation | Status | Notes |
|---|---|---|
| `fetch_candidate_issues()` | OK | `listIssues()` |
| `fetch_issues_by_states(state_names)` | **NOT IMPLEMENTED** | For startup terminal cleanup — orchestrator works around it |
| `fetch_issue_states_by_ids(issue_ids)` | **NOT IMPLEMENTED** | For active-run reconciliation — orchestrator works around it |

### 7.2 Query Semantics (Section 11.2)

| Requirement | Status | Notes |
|---|---|---|
| `project_slug` → `slugId` filter | **Changed** | GitHub Project V2 ID used |
| Query-time state filtering | **NOT IMPLEMENTED** | Full fetch then post-filter (inefficient for large projects) |
| Default page size 50 | **Differs** | Default 25 |
| Network timeout 30000ms | **NOT IMPLEMENTED** | Relies on fetch() default timeout |
| `[ID!]` type state refresh query | N/A | `fetch_issue_states_by_ids` not implemented |

### 7.3 Normalization (Section 11.3)

| Requirement | Status |
|---|---|
| Labels lowercase | OK |
| blocked_by from inverse relationship | OK (uses GitHub's direct `blockedBy`) |
| Priority integer | Not available (always null) |
| ISO-8601 timestamp parsing | OK |

### 7.4 Error Handling (Section 11.4)

- Partial: `GitHubTrackerHttpError`, `GitHubTrackerQueryError` custom classes used.
- Spec-recommended category names (`unsupported_tracker_kind`, `missing_tracker_api_key`, etc.) not used.

---

## 8. Observability (Section 13)

| Requirement | Status | Notes |
|---|---|---|
| Structured logging (issue_id, identifier, session_id) | OK | |
| Token accounting (prefer absolute totals) | OK | |
| Rate-limit tracking | **NOT IMPLEMENTED** | Spec 13.5 — rate_limits not exposed in API/snapshot |
| Runtime seconds aggregation | OK | |
| **HTML Dashboard (`/`)** | **NOT IMPLEMENTED** | Spec 13.7.1 — JSON API only |
| `GET /api/v1/state` | OK | (endpoint path is `/api/v1/status`) |
| `GET /api/v1/<issue_identifier>` | OK | |
| `POST /api/v1/refresh` | OK | |
| 405 Method Not Allowed | Unverified | |
| JSON error envelope `{error:{code, message}}` | OK | |

---

## 9. Gap Summary (by priority)

### Critical (Section 18.1 Core Conformance requirement not met)

| # | Gap | Spec Section | Impact |
|---|---|---|---|
| **G1** | **Dynamic WORKFLOW.md watch/reload not implemented** | 6.2, 18.1 | High — service restart required for config changes |
| **G2** | **`fetch_issues_by_states()` not implemented** | 11.1 | Medium — reduced accuracy of startup terminal cleanup |
| **G3** | **`fetch_issue_states_by_ids()` not implemented** | 11.1 | Medium — reconciliation depends on full re-fetch |

### Major (functional differences)

| # | Gap | Spec Section | Notes |
|---|---|---|---|
| **G4** | No query-time state filtering | 11.2 | Full project fetch then post-filter — inefficient at scale |
| **G5** | No network timeout on tracker API | 11.2 | 30000ms timeout not applied |
| **G7** | No rate-limit tracking/exposure | 13.5 | rate_limits field not exposed in API/snapshot |
| **G8** | Priority field always null | 4.1.1, 8.2 | Priority-based dispatch sorting is ineffective |

### Minor (extensions/recommendations)

| # | Gap | Spec Section | Notes |
|---|---|---|---|
| **G9** | No HTML Dashboard (`/`) | 13.7.1 | Spec says "optional but recommended" |
| **G10** | Default page size 25 (spec 50) | 11.2 | Minor performance difference |
| **G11** | No CLI `--help` flag | 17.7 | Usability issue |
| **G12** | Error category naming mismatch | 11.4 | Custom error classes exist but don't use spec category names |
| **G13** | Workspace key normalization more aggressive than spec | 4.2 | Lowercase + strip leading/trailing `_` (spec only specifies replacement) |

### Intentional Differences (GitHub adaptation)

| # | Difference | Notes |
|---|---|---|
| **D1** | `tracker.kind: github-project` (spec: `linear`) | Intentional — GitHub target |
| **D2** | `tracker.project_slug` → `projectId` | GitHub Project V2 ID scheme |
| **D3** | `linear_graphql` → `github_graphql` tool | Target platform change |
| **D4** | Workspace path `<root>/<projectId>/issues/<key>` | Multi-tenant support extension |
| **D5** | `WorkflowExecutionPhase` added (planning → human-review → implementation → awaiting-merge → completed) | GitHub workflow extension not in spec |
| **D6** | `assignedOnly` filtering option | GitHub-specific extension |

---

## 10. Test Gaps (Section 17)

| Test Area | Spec Requirement | Status |
|---|---|---|
| 17.1 Workflow/Config Parsing | Core | OK |
| 17.2 Workspace Safety | Core | OK |
| 17.3 Tracker Client | Core | Partial — `fetch_issues_by_states`, `fetch_issue_states_by_ids` not implemented so untestable |
| 17.4 Dispatch/Reconciliation/Retry | Core | OK (2,753-line service.test.ts) |
| 17.5 App-Server Protocol | Core | OK (1,021-line worker-protocol.test.ts) |
| 17.6 Observability | Core | OK |
| 17.7 CLI Lifecycle | Core | OK |
| 17.8 Real Integration | Recommended | Partial — E2E harness exists but not automated in CI |

---

## 11. Recommended Actions

1. **G1 (Dynamic Reload)**: Implement filesystem watch on `WORKFLOW.md` with debounced reload. This is the only Core Conformance (18.1) gap that blocks spec compliance.
2. **G2/G3 (Tracker Operations)**: Add `fetchIssuesByStates()` and `fetchIssueStatesByIds()` to `GitHubTrackerAdapter` for more efficient reconciliation and terminal cleanup.
3. **G5 (Network Timeout)**: Add configurable `AbortSignal.timeout(30000)` to GitHub GraphQL fetch calls.
4. **G7 (Rate Limits)**: Extract and expose rate-limit headers from GitHub API responses in status snapshots.
