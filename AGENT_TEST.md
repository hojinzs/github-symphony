# AGENT_TEST.md

A guide for AI agents to run E2E black-box tests after code changes.
Two modes are supported: local execution (without Docker) and a Docker-isolated environment.

## Test Layers

| Layer                 | Tool                   | When to run                                   |
| --------------------- | ---------------------- | --------------------------------------------- |
| Unit Test             | `pnpm test` (Vitest)   | Immediately after code changes                |
| Type Check            | `pnpm typecheck`       | Immediately after code changes                |
| Lint                  | `pnpm lint`            | Immediately after code changes                |
| **E2E Test (Local)**  | pnpm cli + Stub Worker | For quickly verifying integration behavior    |
| **E2E Test (Docker)** | Docker + CLI           | For verifying in a fully isolated environment |

## Required Verification (after every code change)

```bash
pnpm lint && pnpm test && pnpm typecheck && pnpm build
```

All four must pass before the work is considered complete.

## Local E2E Tests (without Docker)

How to run E2E tests directly on the local machine without Docker. All state is stored under `.runtime/`.

### Architecture

```
pnpm e2e:start
    │
    ▼
┌─────────────────────────────────────────────────┐
│  Local Process                                   │
│                                                  │
│  CLI (repo start) ──→ Orchestrator ──spawn──→ Stub Worker │
│       │                                          │
│  Dashboard :4680     File Tracker                │
│  /api/v1/state       (e2e/fixtures/issues.json)  │
│                                                  │
│  .runtime/           (project root, gitignored)  │
│    └─ e2e/                                      │
│       ├─ repos/      (seed git repo)             │
│       ├─ fixtures/   (local-path fixture copies) │
│       └─ work/test-repo/.runtime/orchestrator    │
└─────────────────────────────────────────────────┘
```

### Initial Setup (once)

```bash
pnpm build          # Build everything
pnpm e2e:init       # Create .runtime/ structure, compile stub worker, create seed repo
```

What `e2e:init` does:

1. Compiles `e2e/stub-worker.ts` → `e2e/dist/stub-worker.js`
2. Creates the `.runtime/e2e/repos/test-owner/test-repo` seed git repo (including WORKFLOW.md)
3. Clones into `.runtime/e2e/work/test-repo` and configures a single `repository` project via `repo init`
4. Initializes `e2e/fixtures/issues.json` to an empty array

### Run

```bash
# 1. Inject an issue (use the local fixture — cloneUrl is rewritten to a local path)
cp .runtime/e2e/fixtures/happy-path.json e2e/fixtures/issues.json

# 2. Start the orchestrator (foreground, stop with Ctrl+C)
export GH_SYMPHONY_HTTP_TOKEN=e2e-http-token
pnpm e2e:start
```

> **Note**: Use `.runtime/e2e/fixtures/happy-path.json` (the local copy), not `e2e/fixtures/happy-path.json` (the original). The original fixture's `cloneUrl` points to a path inside the Docker container.

Run with other scenarios:

```bash
STUB_SCENARIO=fail pnpm e2e:start
STUB_SCENARIO=stall pnpm e2e:start
STUB_SCENARIO=slow pnpm e2e:start
```

### Observing State (separate terminal)

```bash
# Full project state
curl -s -H "Authorization: Bearer ${GH_SYMPHONY_HTTP_TOKEN}" \
  http://localhost:4680/api/v1/state | jq .

# Key fields only
curl -s -H "Authorization: Bearer ${GH_SYMPHONY_HTTP_TOKEN}" \
  http://localhost:4680/api/v1/state | jq '{
  health,
  activeRuns: .summary.activeRuns,
  runs: [.activeRuns[] | {status, executionPhase, lastEvent, retryKind}],
  retryQueue: [.retryQueue[] | {retryKind, nextRetryAt}],
  lastError
}'

# Manually trigger reconciliation
curl -H "Authorization: Bearer ${GH_SYMPHONY_HTTP_TOKEN}" \
  -X POST http://localhost:4680/api/v1/refresh
```

### Checking Events and Logs

```bash
# Event log (structured NDJSON)
cat .runtime/e2e/work/test-repo/.runtime/orchestrator/runs/*/events.ndjson | jq .

# Worker log (stderr capture)
cat .runtime/e2e/work/test-repo/.runtime/orchestrator/runs/*/worker.log
```

### Removing Issues (to stop retries)

```bash
echo "[]" > e2e/fixtures/issues.json
```

### Cleanup

```bash
rm -rf .runtime
```

`.runtime/` is gitignored, so it can be deleted at any time and recreated with `pnpm e2e:init`.

---

## Docker E2E Test Environment

### Architecture

```
AI Agent
    │
    │ docker compose -f docker-compose.e2e.yml up -d
    │ curl http://localhost:4680/api/v1/state
    │ docker logs symphony-e2e
    │
    ▼
┌──────────────────────────────────────────────────┐
│  Docker Container (symphony-e2e)                  │
│                                                   │
│  Orchestrator ──spawn──→ Stub Worker              │
│       │                   (replaces Codex)        │
│  Dashboard :4680        /api/v1/state           │
│  File Tracker                                     │
│  (/e2e/fixtures/issues.json)                      │
│                                                   │
│  /e2e/repos/ (pre-seeded local git repo)          │
│  /e2e/work (tmpfs, destroyed when the container stops) │
│    └─ test-repo/.runtime/orchestrator             │
│                                                   │
│  :4680 dashboard API (exposed externally)         │
└──────────────────────────────────────────────────┘
```

- **File Tracker** (`@gh-symphony/tracker-file`): reads issues from a JSON file without the GitHub API
- **Stub Worker** (`e2e/stub-worker.ts`): simulates worker behavior without the Codex AI
- **Isolation**: the cloned work repo and repo-local orchestrator state live in the `/e2e/work` tmpfs and are destroyed when the container stops. The local `.runtime/` is unaffected
- **Event mirroring (optional)**: with the `docker-compose.e2e.events.yml` override, `events.ndjson` is also replicated to the host's `./evidence/`
- **Golden path**: the container entrypoint boots the single-repo runtime in the order `git clone /e2e/repos/test-owner/test-repo /e2e/work/test-repo → cd /e2e/work/test-repo → gh-symphony repo init → gh-symphony repo start --http 4680 --bind-all`.
- **File tracker fixture**: `GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH` is a test-only environment variable used solely by the `kind: file` workflows of this Docker/local E2E setup to connect the mounted fixture to the `repo init` result.

### Stub Worker Scenarios

Control worker behavior with the `STUB_SCENARIO` environment variable:

| Scenario          | Behavior                                                           |
| ----------------- | ------------------------------------------------------------------ |
| `happy` (default) | starting(2s) → running(5s) → completed, exit 0                     |
| `fail`            | starting(2s) → running(3s) → failed, exit 1                        |
| `stall`           | starting(2s) → running(forever), waits for SIGTERM                 |
| `slow`            | starting(2s) → running(30s) → completed, exit 0                    |
| `api-progress`    | confirmed Ready → Done API transition/readback → succeeded, exit 0 |

### Worker lifecycle regression cases

| Case                                                                         | Automated coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Docker black-box confirmation                                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API-side lifecycle progress at turn boundaries and the convergence threshold | `packages/worker/src/convergence-lifecycle.test.ts` replicates the per-turn exit and threshold terminal branches with production helpers: confirmed non-actionable readback completes, active state converges, and unavailable readback is an orchestrator failure. `packages/orchestrator/src/service.test.ts` enters the successful-exit finalization branch and verifies that current active state schedules continuation while an unknown final read leaves classification pending; state reads do not reload workflow policy. | `STUB_SCENARIO=api-progress` captures the first dispatched run, requires it to persist successfully without workspace mutations, and rejects replacement run records; it does not execute the Codex multi-turn loop. |

`docker-compose.e2e.yml` uses `environment.STUB_SCENARIO: ${STUB_SCENARIO:-happy}`, so the scenario can be selected via a shell environment variable.

```bash
STUB_SCENARIO=fail docker compose -f docker-compose.e2e.yml up -d --build
```

## How to Run E2E Tests

### 1. Start the environment

```bash
echo "[]" > e2e/fixtures/issues.json
mkdir -p evidence
export GH_SYMPHONY_HTTP_TOKEN=e2e-http-token
docker compose -f docker-compose.e2e.yml -f docker-compose.e2e.events.yml up -d --build
curl --fail --retry-all-errors --retry 10 --retry-delay 2 http://localhost:4680/healthz
```

### 2. Inject issues

```bash
# Use a predefined fixture
cp e2e/fixtures/happy-path.json e2e/fixtures/issues.json

# Or write one directly
cat > e2e/fixtures/issues.json << 'EOF'
[{
  "id": "issue-1",
  "identifier": "test-owner/test-repo#1",
  "number": 1,
  "title": "Test issue",
  "description": null,
  "priority": null,
  "state": "Ready",
  "branchName": null,
  "url": null,
  "labels": [],
  "blockedBy": [],
  "createdAt": null,
  "updatedAt": null,
  "repository": {
    "owner": "test-owner",
    "name": "test-repo",
    "cloneUrl": "/e2e/repos/test-owner/test-repo"
  },
  "tracker": {
    "adapter": "file",
    "bindingId": "e2e-test",
    "itemId": "issue-1"
  },
  "metadata": {}
}]
EOF
```

### 3. Trigger reconciliation

```bash
curl -H "Authorization: Bearer ${GH_SYMPHONY_HTTP_TOKEN}" \
  -X POST http://localhost:4680/api/v1/refresh
```

> The container's entrypoint is already running `cli start` (continuous polling), so do not use `docker exec run-once`. Two instances would contend over the same state files, causing unpredictable behavior.

### 4. Observe state

```bash
# Full project state
curl -s -H "Authorization: Bearer ${GH_SYMPHONY_HTTP_TOKEN}" \
  http://localhost:4680/api/v1/state | jq .

# Key fields only
curl -s -H "Authorization: Bearer ${GH_SYMPHONY_HTTP_TOKEN}" \
  http://localhost:4680/api/v1/state | jq '{
  health,
  activeRuns: .summary.activeRuns,
  runs: [.activeRuns[] | {status, executionPhase, lastEvent, retryKind}],
  retryQueue: [.retryQueue[] | {retryKind, nextRetryAt}],
  lastError
}'
```

### 5. Remove issues (to stop retries)

```bash
echo "[]" > e2e/fixtures/issues.json
```

The stub worker does not change issue state, so issues must be removed after completion to stop the retry loop.

## Claude Stub Docker E2E

The Claude print runtime's process spawn, stream-json NDJSON parsing, MCP composition,
`claude-session.json` persistence, and `--resume` / `--fork-session` argv injection are
verified inside Docker with a stub `claude` binary.

```bash
pnpm e2e:claude
```

This command runs two Docker paths in parallel.

| Path                                 | Verifies                              |
| ------------------------------------ | ------------------------------------- |
| `docker-compose.e2e.yml`             | Existing Codex stub worker regression |
| `test/e2e/claude/docker-compose.yml` | Claude stub binary blackbox spec      |

The Claude stub contract is pinned in the comment at the top of
`test/e2e/stubs/claude.sh`. The spec directly reads the stub's
`invocations.ndjson`, `claude-session.json`, and the run's `events.ndjson`
to verify the following.

- Single-issue `Ready → In progress → In review` transition
- Intra-run continuation includes `--resume <sessionId>` and excludes `--fork-session`
- Inter-run recover includes `--resume <prevId> --fork-session`, stores a new session id, and preserves the `parentRunId` link
- Resume session rejection records a `session_invalidated` event

### 6. Check logs

```bash
# Orchestrator logs
docker logs symphony-e2e

# Event log (structured NDJSON, tmpfs by default)
docker exec symphony-e2e sh -c 'cat /e2e/work/test-repo/.runtime/orchestrator/runs/*/events.ndjson'

# Host mirror log (when the events override is enabled)
tail -f evidence/runs/*/events.ndjson

# Worker log (only stderr is captured)
docker exec symphony-e2e sh -c 'cat /e2e/work/test-repo/.runtime/orchestrator/runs/*/worker.log'
```

### 7. Cleanup

```bash
docker compose -f docker-compose.e2e.yml down
echo "[]" > e2e/fixtures/issues.json
rm -rf evidence
```

## Understanding Key Behavior

### Worker Lifecycle in E2E

```
idle → [inject issue + refresh]
     → dispatching (git clone ~3-5s)
     → running (stub worker ~7s for happy scenario)
     → retrying/continuation (issue still in active state)
     → [remove issue]
     → retrying/failure
     → [due retry + tracker recheck confirms issue missing/non-actionable]
     → released
     → idle
```

- When a worker exits, the orchestrator checks the issue state to decide the retry kind
  - Issue still in an active state → `continuation` retry
  - Issue missing or in a terminal state → `failure` retry
- The stub worker does not change issue state, so this behavior is expected

### Predefined Fixtures

| File                                       | Purpose                                                         |
| ------------------------------------------ | --------------------------------------------------------------- |
| `e2e/fixtures/happy-path.json`             | Single issue (state: Ready)                                     |
| `e2e/fixtures/multi-issue.json`            | 3 issues (concurrency test, concurrency_limit=2)                |
| `e2e/fixtures/blocked-issue.json`          | Issue with blockedBy                                            |
| `e2e/fixtures/dispatch-start-failure.json` | Poison first candidate followed by a healthy dispatch candidate |
| `e2e/fixtures/terminal-candidate.json`     | Closed source issue left in active Project status               |

### Predefined Scenario Documents

| File                                                      | Scenario                                                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `e2e/scenarios/01-happy-path.md`                          | Issue dispatch → worker completion → lifecycle observation                                                                |
| `e2e/scenarios/02-multi-issue.md`                         | Verify concurrency limit                                                                                                  |
| `e2e/scenarios/03-stall-detection.md`                     | stall → SIGTERM → retry                                                                                                   |
| `e2e/scenarios/04-fail-retry.md`                          | Failure → retry scheduling                                                                                                |
| `e2e/scenarios/05-before-remove-hook-failure.md`          | Verify a `before_remove` hook failure does not block workspace cleanup                                                    |
| `e2e/scenarios/06-retry-title-preservation.md`            | Issue title preservation during retry/recovery                                                                            |
| `e2e/scenarios/06-unbounded-failure-retry.md`             | Retries continue after 3+ worker failures                                                                                 |
| `e2e/scenarios/06-worker-failure-lifecycle-regression.md` | Worker failure lifecycle regression verification                                                                          |
| `e2e/scenarios/07-release-missing-retry.md`               | Release a missing retry queue instead of restarting                                                                       |
| `e2e/scenarios/08-evidence-permissions.md`                | Verify event-mirror evidence file permissions and cleanup                                                                 |
| `e2e/scenarios/09-linear-sandbox.md`                      | Verify Linear sandbox `Todo → In Progress → Human Review/Done` and reconciliation edge cases                              |
| `e2e/scenarios/10-http-auth-hardening.md`                 | Verify HTTP localhost default binding, bearer auth gating, and state redaction                                            |
| `e2e/scenarios/10-orchestrator-tracker-state.md`          | Verify run-scoped tracker API authorization, durable rejection, and exact-item concurrency                                |
| `e2e/scenarios/11-stale-run-recovery.md`                  | Verify stale-run ownership and lifecycle recovery                                                                         |
| `e2e/scenarios/12-transition-comment-race.md`             | Verify orchestrator-owned transition comments survive reconciliation races                                                |
| `e2e/scenarios/13-api-progress-convergence.md`            | Verify confirmed API lifecycle progress persists as a successful run without workspace mutations                          |
| `e2e/scenarios/13-standalone-project-model.md`            | Verify the standalone project model (project `.env`, MCP, worktree, and branch isolation) — `pnpm e2e:standalone-project` |
| `e2e/scenarios/14-dispatch-start-failure-isolation.md`    | Verify one candidate's pre-spawn failure records retry state without starving later candidates                            |
| `e2e/scenarios/15-terminal-candidate-reconciliation.md`   | Verify a closed issue in active Project status converges to `Done` without worker dispatch                                |

## TC Writing Guide

E2E test cases follow this structure:

```markdown
# TC-XX: Title

## Setup

Start the container, prepare fixtures

## Steps

1. Inject issues
2. Trigger refresh
3. Poll state (with expected values)
4. Additional actions (removing issues, etc.)

## Expected

Expected behavior and state transitions

## Cleanup

Stop the container, reset fixtures
```

### Notes on Writing TCs

- **Timing**: workspace preparation (git clone) takes 3-5 seconds; worker execution takes scenario-dependent time
- **Polling interval**: poll state at 1-second intervals, but set a maximum wait time
- **Issue removal**: after observing worker completion, always remove issues to avoid retry loops
- **STUB_SCENARIO**: pick the worker behavior matching the scenario (e.g. `STUB_SCENARIO=fail docker compose ...`)
