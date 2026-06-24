# Symphony Spec Gap Analysis

Date: 2026-06-25
Last verified against commit: `a5c494c37d32`
Spec version: Draft v1 (`docs/symphony-spec.md`)
Implementation: GitHub Symphony (pnpm monorepo, TypeScript)

> Historical note: the previous 2026-03-17 revision predated several shipped packages
> and marked now-implemented work as missing or critical. This file is a
> living implementation map; use stable section references instead of exact line
> numbers when citing it from ADRs or follow-up issues.

---

## 1. Current Implementation Surface

The implementation now spans these packages:

- Runtime/orchestration: `packages/orchestrator`, `packages/worker`,
  `packages/runtime-codex`, `packages/runtime-claude`
- Tracker integrations: `packages/tracker-github`, `packages/tracker-linear`,
  `packages/tracker-file`
- Tools/extensions: `packages/tool-github-graphql`,
  `packages/tool-linear-graphql`, `packages/extension-github-workflow`
- User surfaces: `packages/cli`, `packages/control-plane`,
  `packages/dashboard`
- Shared contracts and spec-facing types: `packages/core`

This matters because the old gap list predated the Linear/file trackers,
Claude runtime, control plane, and dashboard packages.

---

## 2. Previously Critical Gaps Now Closed

| Former ID | Previous claim | Current status | Evidence |
|---|---|---|---|
| G1 | Dynamic `WORKFLOW.md` reload not implemented | Closed | `packages/orchestrator/src/service.ts` rebuilds the workflow resolution cache for each serialized tick (`runOnceInternal`), so future runs re-read workflow files instead of requiring a service restart. |
| G2 | `fetch_issues_by_states()` not implemented | Closed | `OrchestratorTrackerAdapter.listIssuesByStates` exists in `packages/core/src/contracts/tracker-adapter.ts`; GitHub implements it in `packages/tracker-github/src/orchestrator-adapter.ts` and the orchestrator uses it for startup cleanup. |
| G3 | `fetch_issue_states_by_ids()` not implemented | Closed | `OrchestratorTrackerAdapter.fetchIssueStatesByIds` exists in `packages/core/src/contracts/tracker-adapter.ts`; GitHub implements it in `packages/tracker-github/src/orchestrator-adapter.ts` and `packages/tracker-github/src/adapter.ts`. |
| G5 | No network timeout on tracker API | Closed | GitHub GraphQL requests use `AbortSignal.timeout(resolveNetworkTimeoutMs(...))` with a default `30_000ms` timeout in `packages/tracker-github/src/adapter.ts`. |
| G7 | No rate-limit tracking/exposure | Closed | GitHub rate-limit headers are extracted in `packages/tracker-github/src/adapter.ts`, propagated through run records and project snapshots in `packages/orchestrator/src/service.ts`, and used for adaptive polling. |
| G9 | No HTML dashboard | Closed | `packages/dashboard` provides filesystem-backed dashboard handlers and `packages/control-plane` exposes the dashboard/control-plane API surface. |
| G11 | No CLI `--help` flag | Closed | `packages/cli/src/index.ts` registers `-h, --help` and `help [command]`; help output is covered by CLI tests and snapshots. |

There are no currently verified Critical gaps from the 2026-03-17 list.

---

## 3. Current Conformance Map

### 3.1 Domain Model

| Area | Status | Notes |
|---|---|---|
| Issue identity fields | OK | `id`, `identifier`, `title`, `description`, `state`, `url`, labels, blockers, and timestamps are normalized into `TrackedIssue`. |
| Priority | Implemented with GitHub extension | `tracker.priority` supports explicit `project-field`, `labels`, and `disabled` sources. Legacy `tracker.priority_field` remains supported with deprecation diagnostics. See Section 4.2. |
| Branch metadata | Limited by tracker | GitHub issues do not provide a native tracker branch field; branch context is represented through runtime/workflow behavior rather than a tracker-provided `branch_name`. |
| Workspace key normalization | Intentional difference | Repository-local workspaces are sanitized more aggressively than the upstream replacement-only rule. This is tracked as D3 below. |

### 3.2 Workflow and Configuration

| Requirement | Status | Notes |
|---|---|---|
| YAML front matter + prompt body split | OK | Parser rejects invalid front matter shapes and preserves prompt body semantics. |
| `$VAR` / `${VAR}` / `env:VAR` indirection | OK | Workflow loader supports environment indirection. |
| `~` path expansion | OK | Workspace paths support home expansion. |
| Dynamic reload for future runs | OK | The orchestrator rebuilds workflow resolution per tick and clears the per-tick cache after reconciliation. |
| Invalid reload keeps last-known-good | OK | Invalid workflow resolution can fall back to the last known good configuration. |
| Strict prompt rendering | OK | Unknown variables fail rendering; prompt context includes issue and attempt data. |

### 3.3 Orchestration and Workspace Lifecycle

| Requirement | Status | Notes |
|---|---|---|
| Polling, reconciliation, validation, dispatch | OK | Candidate sorting, blocker checks, recovery, retries, and leases are covered in `packages/orchestrator`. |
| Startup cleanup for terminal issues | OK | Startup cleanup uses `listIssuesByStates` and repository workflow terminal-state resolution. |
| Active-run state refresh | OK | Reconciliation uses `fetchIssueStatesByIds` for running issue state refresh outside the candidate snapshot. |
| Workspace safety and hooks | OK | Workspace reuse, lifecycle hooks, timeout handling, and cleanup safety remain implemented. |

### 3.4 Agent Runner Protocol

| Requirement | Status | Notes |
|---|---|---|
| App-server protocol | OK | Worker/orchestrator protocol covers launch, handshake, streaming turns, continuation, timeouts, and structured worker info. |
| Runtime support | Extended | Codex remains supported and `packages/runtime-claude` adds a Claude runtime integration. |
| Tool extensions | GitHub/Linear adaptation | The upstream `linear_graphql` extension maps to repository-local GitHub and Linear tool packages. |

### 3.5 Tracker Integration

| Requirement | Status | Notes |
|---|---|---|
| Candidate listing | OK | GitHub, Linear, and file tracker adapters implement repository-local tracker contracts. |
| State-specific listing | Partial by platform | The contract exists. GitHub Project V2 cannot filter project items by state at query time, so the GitHub adapter fetches project items and filters locally. |
| State refresh by ID | OK | GitHub implements batched state refresh by issue node ID. |
| Network timeout | OK | GitHub GraphQL uses a default 30s request timeout. |
| Rate-limit capture | OK | GitHub rate limits are attached to issues/snapshots; the orchestrator adapts poll intervals when limits are low. |
| Error category names | Partial | Custom error classes and diagnostics exist, but names do not consistently match the upstream spec's suggested category names. |

### 3.6 Observability and User Surfaces

| Requirement | Status | Notes |
|---|---|---|
| Structured events and snapshots | OK | Run events, project snapshots, token/runtime totals, and rate limits are represented in core contracts. |
| `GET /api/v1/state` | OK | Implemented by `packages/dashboard`; `packages/control-plane` delegates to it. |
| Per-issue status endpoint | OK | Control-plane/dashboard surfaces expose issue detail state. |
| `POST /api/v1/refresh` | OK | Control-plane supports manual refresh. |
| 405 for unsupported methods | OK | Dashboard and control-plane tests cover 405 method handling. |
| HTML dashboard | OK | Dashboard/control-plane packages provide the shipped UI/API surface. |
| CLI lifecycle/help | OK | CLI help and workflow/repo lifecycle command help are implemented and tested. |

---

## 4. Genuinely Open Gaps / Differences

### 4.1 Open Gaps

| ID | Gap | Spec section | Severity | Notes |
|---|---|---|---|---|
| G4 | GitHub Project V2 state filtering remains local, not query-time | 11.2 | Major at scale | The contract exists and startup/reconciliation use it, but GitHub Project V2 still requires full project-item fetch plus local filtering for `listIssuesByStates`. |
| G10 | GitHub project-item page size default is 25, not 50 | 11.2 | Minor | `packages/tracker-github/src/adapter.ts` sets `DEFAULT_PAGE_SIZE = 25`. |
| G12 | Error category naming does not consistently match spec examples | 11.4 | Minor | Repository-specific custom errors exist; category strings are not a strict mirror of the upstream suggested names. |

### 4.2 Priority Status

Priority is no longer "always null" for GitHub. The current implementation supports:

- Explicit `tracker.priority.source: project-field`
- Explicit `tracker.priority.source: labels`
- Explicit `tracker.priority.source: disabled`
- Legacy `tracker.priority_field` compatibility with deprecation warnings
- Doctor/workflow diagnostics for drift and legacy/explicit conflicts

This closes the old "priority field always null" gap for configured GitHub projects.
Unconfigured projects still resolve `priority = null` by policy, which is expected.

### 4.3 Intentional Repository-Local Differences

| ID | Difference | Status | Notes |
|---|---|---|---|
| D1 | `tracker.kind: github-project` / `linear` / `file` rather than only the upstream Linear shape | Intentional extension | GitHub Symphony supports multiple tracker adapters while keeping tracker-specific behavior outside core. |
| D2 | GitHub Project V2 IDs instead of upstream `project_slug` | Intentional extension | GitHub Project V2 uses global node IDs and custom fields. |
| D3 | Workspace path and key normalization differ from upstream examples | Intentional implementation choice | Single-repo runtime uses repo-local `.runtime/orchestrator/...` layout and stronger sanitization. |
| D4 | `github_graphql` / `linear_graphql` tool packages | Intentional extension | Tool packages reflect tracker-specific integration boundaries. |
| D5 | `WorkflowExecutionPhase` lifecycle states | Intentional extension | Planning, review, implementation, awaiting-merge, and completion phases model GitHub workflow policy. |
| D6 | `assignedOnly` filtering option | Intentional GitHub extension | Repository-local policy knob layered on tracker integration. |

---

## 5. Test Status

| Test area | Current status | Evidence |
|---|---|---|
| Workflow/config parsing | OK | `packages/core/src/workflow-loader.test.ts`, parser/render tests. |
| Workspace safety and lifecycle | OK | Orchestrator service tests cover workspace cleanup, hooks, and terminal reconciliation. |
| Tracker client | OK / platform partial | GitHub tests cover `listIssuesByStates`, `fetchIssueStatesByIds`, priority mapping, network timeout, and rate-limit metadata. Query-time state filtering remains platform-limited. |
| Dispatch/reconciliation/retry | OK | `packages/orchestrator/src/service.test.ts` covers dispatch, recovery, rate-limit snapshots, and adaptive polling. |
| App-server protocol | OK | Worker protocol tests cover runtime state transitions and worker info. |
| Observability/dashboard | OK | Core snapshot tests, dashboard store/server tests, control-plane server/client tests. |
| CLI lifecycle/help | OK | CLI tests cover root and command help, workflow diagnostics, setup/init, and dashboard renderer behavior. |
| Docker E2E | Available | `AGENT_TEST.md` documents local and Docker black-box E2E flows; run only when integration behavior changes. |

---

## 6. Recommended Actions

1. Keep G4 open as a GitHub platform/scale limitation unless GitHub Project V2 gains server-side state filtering for project items.
2. Decide whether G10 should be changed to the upstream default page size of 50 or documented as an intentional GitHub adapter tuning choice.
3. Decide whether G12 should normalize error category names to the upstream examples or keep repository-specific error classes and document the divergence.
4. Continue citing this document by section or gap ID, not line number.
