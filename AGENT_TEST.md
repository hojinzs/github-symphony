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
  retryQueue: [.retryQueue[] | {issueId, attempt, error, retryKind, nextRetryAt}],
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
    │ docker compose --project-name <unique> -f docker-compose.e2e.yml up -d
    │ docker compose --project-name <unique> exec symphony-e2e curl http://localhost:4680/api/v1/state
    │ docker compose --project-name <unique> logs symphony-e2e
    │
    ▼
┌──────────────────────────────────────────────────┐
│  Docker Compose service (symphony-e2e)             │
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
│  :4680 dashboard API (published to the host)       │
└──────────────────────────────────────────────────┘
```

- **File Tracker** (`@gh-symphony/tracker-file`): reads issues from a JSON file without the GitHub API. While polling is active, `e2e/run-e2e.sh` probes whether the container can write its bind-mounted fixture directory: it stages and renames there when writable, or uses a host-side atomic rename when it is not (as on native Linux mounts owned by another UID). Both paths publish only complete JSON documents, so polling cannot observe a partial fixture. The adapter still retries one transient JSON syntax failure and surfaces persistent malformed JSON.
- **Stub Worker** (`e2e/stub-worker.ts`): simulates worker behavior without the Codex AI
- **Isolation**: the cloned work repo and repo-local orchestrator state live in the `/e2e/work` tmpfs and are destroyed when the container stops. The local `.runtime/` is unaffected
- **Compose isolation**: runner scripts derive `COMPOSE_PROJECT_NAME`, `SYMPHONY_E2E_IMAGE`, and `SYMPHONY_E2E_PORT` from the absolute worktree path. Set `SYMPHONY_E2E_PROJECT`, `SYMPHONY_E2E_IMAGE`, or `SYMPHONY_E2E_PORT` to override a derived value. Containers, networks, volumes, images, and runner host ports are isolated across worktrees; manual Compose keeps host port `4680` by default.
- **Docker preflight**: all Docker E2E runner scripts verify that `docker compose` resolves in the current `HOME`/`DOCKER_CONFIG` environment and that the daemon is reachable before installing cleanup traps or creating a project. An unavailable prerequisite exits with status `69`, distinct from Docker's status `125` and from scenario failures.
- **Event mirroring (optional)**: with the `docker-compose.e2e.events.yml` override, `events.ndjson` is also replicated to the host's `./evidence/`
- **Golden path**: the container entrypoint boots the single-repo runtime in the order `git clone /e2e/repos/test-owner/test-repo /e2e/work/test-repo → cd /e2e/work/test-repo → gh-symphony repo init → gh-symphony repo start --http 4680 --bind-all`.
- **File tracker fixture**: `GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH` is a test-only environment variable used by `tracker.provider.path` in the Docker/local `kind: file` workflows; it remains a compatibility fallback for older fixture workflows.

### Stub Worker Scenarios

Control worker behavior with the `STUB_SCENARIO` environment variable:

| Scenario               | Behavior                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `happy` (default)      | starting(2s) → running(5s) → completed, exit 0                                                                            |
| `fail`                 | starting(2s) → running(3s) → failed, exit 1                                                                               |
| `stall`                | starting(2s) → running(forever), waits for SIGTERM                                                                        |
| `slow`                 | starting(2s) → running(30s) → completed, exit 0                                                                           |
| `prompt-phase`         | validates `phase=planning` in the rendered prompt, then completes                                                         |
| `retry-attempt`        | validates `retry_attempt=1` on the continuation worker, then confirms `Done`                                              |
| `recovery-fail`        | dirties the workspace and fails three times, then verifies durable suppression and no later redispatch                    |
| `api-progress`         | confirmed Ready → Done API transition/readback → succeeded, exit 0                                                        |
| `api-progress-unknown` | confirmed Ready → Done, removes the canonical item, then exits successfully so bounded finalization fallback is exercised |

### Worker lifecycle regression cases

| Case                                                                         | Automated coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Docker black-box confirmation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| API-side lifecycle progress at turn boundaries and the convergence threshold | `packages/worker/src/convergence-lifecycle.test.ts` replicates the per-turn exit and threshold terminal branches with production helpers: confirmed non-actionable readback completes, active state converges, and unavailable readback is an orchestrator failure. `packages/orchestrator/src/service.test.ts` exercises the real final classifier mappings: active schedules continuation, non-actionable succeeds, transient unknown recovers, and persistent unknown emits three cause-bearing deferrals before failure retry with truthful tracker diagnostics; state reads do not reload workflow policy.                                              | `STUB_SCENARIO=api-progress` confirms the successful canonical readback path. `STUB_SCENARIO=api-progress-unknown` specifically removes the canonical item after confirmed progress (the `tracker-item-missing` cause, not an API outage) and requires exactly three persisted `run-finalization-deferred` events with the final event exhausted and its failure retry scheduled.                                                                                                                                                                                                                                                                      |
| Planning phase prompt policy                                                 | `packages/worker/src/execution-phase.test.ts`, `packages/core/src/workflow/render.test.ts`, and `packages/cli/src/commands/workflow.test.ts` cover normalized classification and prompt rendering.                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `STUB_SCENARIO=prompt-phase` uses a whitespace/case-mismatched `planning_states` entry and fails unless the dispatched prompt contains `phase=planning`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Retry prompt attempt rendering                                               | `packages/orchestrator/src/service.test.ts` covers continuation, queued failure, and recovery retry attempt propagation; `packages/core/src/workflow/render.test.ts` covers integer template rendering.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `STUB_SCENARIO=retry-attempt` completes one actionable turn, then fails unless the continuation worker receives `retry_attempt=1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Failed worker exit retry classification                                      | `packages/orchestrator/src/service.test.ts` verifies non-zero exit, signal termination, failed-turn, and user-input-required classifications; failure paths retain diagnostics, use exponential backoff, increment failure counts, and append one `run-retried` event with retry diagnostics.                                                                                                                                                                                                                                                                                                                                                                | `STUB_SCENARIO=fail` confirms the Docker worker failure path exits non-zero and is retried by the orchestrator; inspect `events.ndjson` for one `run-retried` per scheduled retry and `/api/v1/state` for `issueId`, `attempt`, `error`, `retryKind: "failure"`, and a retained failure diagnostic.                                                                                                                                                                                                                                                                                                                                                    |
| Dirty-workspace recovery circuit breaker                                     | `packages/orchestrator/src/service.test.ts` verifies recovery failures consume `max_failure_retries`, exhaustion preserves recovery context and releases the claim, fresh same-state polls cannot reset the counter, explicit tracker state changes re-arm dispatch, and healthy continuation retries remain unchanged.                                                                                                                                                                                                                                                                                                                                      | [TC-20](e2e/scenarios/20-bounded-recovery-circuit-breaker.md) runs `STUB_SCENARIO=recovery-fail`, requires exactly three dirty failures, verifies the persisted manual-intervention outcome, and confirms later refreshes do not redispatch the issue.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Dirty unpublished worktree after host transport                              | `packages/worker/src/git-transport.test.ts` verifies the host push returns bounded tracked and untracked unpublished file lists without classifying the successful push as a transport failure. `packages/orchestrator/src/service.test.ts` verifies terminal and startup cleanup retain a workspace using the latest run's dedicated `unpublishedWorktree` record.                                                                                                                                                                                                                                                                                          | [TC-23](e2e/scenarios/23-dirty-unpublished-worktree.md) simulates the worker transport outcome to confirm orchestrator retention and retained files after `Done`; worker-side detection remains unit-covered.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Agent-triggered assigned-branch publication                                  | `packages/cli/src/commands/start.test.ts` verifies authenticated routing, and `packages/orchestrator/src/service.test.ts` verifies current-run authorization plus repeated idempotent publication. Worker transport suites cover fast-forward and abnormal-exit behavior.                                                                                                                                                                                                                                                                                                                                                                                    | [TC-24](e2e/scenarios/24-assigned-branch-publication.md) commits in the live workspace, requests host publication twice, and resolves the assigned remote ref before worker exit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Restart failure isolation                                                    | `packages/orchestrator/src/service.test.ts` seeds a due retrying run whose restart checkout fails and verifies the failed run/project diagnostics, retained retry backoff, and healthy later-candidate dispatch within the same tick.                                                                                                                                                                                                                                                                                                                                                                                                                        | TC-17 seeds the due retrying run with an unavailable clone source, performs one refresh, and checks the failed retry diagnostics, future retry entry, and same-tick healthy dispatch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Linear MCP runtime credentials                                               | `packages/tool-linear-graphql/src/tool.test.ts`, `packages/runtime-codex/src/runtime.test.ts`, and `packages/runtime-claude/src/mcp-compose.test.ts` verify that resolved Linear credentials reach the built-in MCP server and API keys are used as raw Authorization values.                                                                                                                                                                                                                                                                                                                                                                                | The standard Docker `happy` scenario verifies the worker/runtime container path remains healthy; Linear network calls stay unit-covered because E2E uses the isolated file tracker and no live Linear credentials.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Codex host-side dynamic tools                                                | `packages/runtime-codex/src/runtime.test.ts`, `packages/worker/src/worker-protocol.test.ts`, `packages/worker/src/codex-dynamic-tools.test.ts`, and `packages/worker/src/codex-initialize.test.ts` cover advertised schemas, the conditional `experimentalApi` initialize capability, conditional `thread/start.dynamicTools`, `item/tool/call` responses, structured failures, and issue-context forwarding.                                                                                                                                                                                                                                                | `docker compose -f docker-compose.e2e.yml exec -T symphony-e2e node /app/e2e/host-dynamic-tool-e2e.mjs` runs the built worker helper through the real provider adapter, stubbing only its HTTP boundary, and verifies one host-side call. For a real Codex smoke, replay the captured `initialize` with `capabilities: { "experimentalApi": true }` before the captured dynamic-tool `thread/start`; Codex must return a thread result rather than error `-32600`. Also replay the no-tools shape with `capabilities: {}` and no `dynamicTools` key; it must return a thread result rather than error `-32600`.                                        |
| Host-side Codex and Claude tracker tools                                     | `packages/runtime-codex/src/runtime.test.ts`, `packages/worker/src/worker-protocol.test.ts`, `packages/worker/src/codex-dynamic-tools.test.ts`, `packages/worker/src/codex-initialize.test.ts`, `packages/runtime-claude/src/mcp-http-server.test.ts`, and `test/e2e/claude/claude-docker.spec.ts` cover adapter-advertised schemas, conditional `experimentalApi`, `thread/start.dynamicTools`, `item/tool/call` responses, structured failures, normalized issue context, Claude HTTP MCP contract convergence, and child credential stripping.                                                                                                            | [TC-19](e2e/scenarios/19-host-side-tracker-tools.md) runs the built Codex helper and Claude Docker black-box suite through adapter-owned provider tools with only the HTTP boundary stubbed. Both perform query, comment, and Project-state mutation calls; the established Claude fixture also asserts that the child environment and generated MCP configuration contain no raw provider credential.                                                                                                                                                                                                                                                 |
| Codex turn silence and approval posture                                      | `packages/worker/src/worker-protocol.test.ts` proves every app-server output resets `turn_timeout_ms`, a silent turn is terminated, and an unhandled approval request receives JSON-RPC `-32601`; `codex-policy.test.ts`, `codex-startup.test.ts`, and `workflow-loader.test.ts` prove only `approval_policy: never` can reach startup.                                                                                                                                                                                                                                                                                                                      | `./e2e/run-e2e.sh happy 60` confirms the Docker worker lifecycle remains healthy after the worker protocol/configuration changes. The actual Codex app-server timing and approval paths are unit-covered because the Docker fixture uses a stub worker.                                                                                                                                                                                                                                                                                                                                                                                                |
| Controlled Codex startup failures                                            | `test/e2e/claude/claude-docker.spec.ts` starts the built worker through the Codex route without `PROJECT_ID` or `CODEX_PROJECT_ID`, then asserts its final failed heartbeat and exit code `1`. CI runs the complete built-worker startup regression config with `pnpm test:worker-startup` after building and type-checking the workspace.                                                                                                                                                                                                                                                                                                                   | `pnpm e2e:claude` executes the same built-worker scenarios in the Docker-isolated Claude E2E service.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Agent child isolation and host Git transport                                 | `packages/runtime-codex/src/runtime.test.ts`, `packages/runtime-claude/src/{adapter,mcp-compose}.test.ts`, `packages/core/src/runtime/custom-child-env.test.ts`, `packages/worker/src/non-codex-runtime.test.ts`, `packages/tracker-{github,linear}` suites, and `packages/worker/src/git-transport.test.ts` cover unconditional raw/broker-secret stripping, isolated HOME/GH config, disabled subprocess MCP, custom-auth forwarding, compatibility mode, and real bare-remote fetch/push.                                                                                                                                                                 | [TC-20](e2e/scenarios/20-agent-child-isolation.md) runs `pnpm e2e:claude`; a real custom child covers both default isolation and the documented compatibility mode, proving its private HOME/GH config and Git-helper boundary while differentiating raw-secret exposure. The Claude child reports no GitHub, Linear, or broker credential, no inherited Git helper, and only the host HTTP MCP endpoint, while host tool mutations and the post-run assigned-branch push still succeed. Real Claude and Codex worker lifecycles also exercise a non-fast-forward transport failure and assert a failed terminal heartbeat plus non-zero process exit. |
| Tenant-scoped worker tracker credentials                                     | `packages/orchestrator/src/service.test.ts` verifies daemon credential injection, project `.env` precedence, and continued rejection of unrelated daemon keys; tracker adapter suites verify provider-specific credential-set resolution; runtime and worker isolation tests prove the selected secret remains host-only; `packages/worker/src/git-transport.test.ts` verifies the selected token activates the dedicated Git credential helper.                                                                                                                                                                                                             | [TC-20](e2e/scenarios/20-agent-child-isolation.md) remains the black-box boundary check: host tracker tools and post-run Git push succeed while the child reports no tracker credential or inherited Git helper.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Run-scoped worker cwd and `.env` isolation                                   | `packages/orchestrator/src/service.test.ts` verifies worker cwd equals `WORKSPACE_RUNTIME_DIR`; `packages/runtime-codex/src/launcher.test.ts` verifies cwd `.env` keys are ignored; `packages/cli/src/commands/doctor.test.ts` verifies repo mode warns that a repository-root `.env` is not loaded. Existing orchestrator coverage verifies managed project `.env` values still reach hooks and workers.                                                                                                                                                                                                                                                    | `./e2e/run-e2e.sh happy 60` exercises packaged repo-mode dispatch with the worker hosted from a per-run directory. The adversarial repository-secret fixture remains unit-isolated so no secret-shaped value enters the Docker worker environment.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Workflow reload revision signal                                              | `packages/core/src/workflow-loader.test.ts` proves the revision is short, content-derived, and non-secret; `packages/core/src/observability/snapshot-builder.test.ts` proves snapshots expose the applied revision; `packages/orchestrator/src/service.test.ts` proves dispatch events carry it and that polling/concurrency reload on the next tick.                                                                                                                                                                                                                                                                                                        | Start the Docker E2E environment, inject the happy-path issue, then verify `/api/v1/state` has a `workflow.revision` matching `sha256:<12 hex chars>` and the run's `events.ndjson` has the same `workflowRevision` on `run-dispatched`.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Tracker issue URL snapshot rows                                              | `packages/core/src/observability/snapshot-builder.test.ts` covers `activeRuns[].issueUrl` and `retryQueue[].issueUrl`; GitHub and Linear adapter suites cover tracker URL normalization; `packages/tracker-file/src/file-tracker-adapter.test.ts` covers fixture URL preservation; `packages/dashboard/src/server.test.ts` and the control-plane render test cover API and row links.                                                                                                                                                                                                                                                                        | `./e2e/run-e2e.sh happy 60` uses a file-tracker issue URL. While the run is active, `GET /api/v1/state` must expose that URL at `activeRuns[0].issueUrl`; after worker completion, the usual lifecycle assertions still pass.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Opaque tracker native reference boundary                                     | `packages/tracker-github/src/tracker-github.test.ts` exercises GitHub linked-PR canonicalization through `resolveCanonicalIssues`; `packages/orchestrator/src/dispatch.test.ts` verifies dispatch uses adapter hooks rather than service-level provider payload inspection.                                                                                                                                                                                                                                                                                                                                                                                  | TC-18 runs the Docker `happy` scenario with the file tracker fixture, which derives its opaque item reference and completes dispatch without provider-specific orchestration branches.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Configured repository workflow path and startup preflight                    | `packages/cli/src/commands/start.test.ts` verifies unsupported tracker kinds and legacy repo-embedded metadata fail before daemon construction, project `.env` values resolve during preflight, and missing configured files give a remediation. `packages/cli/src/config.test.ts` verifies legacy metadata remains loadable for migration and diagnostics. `packages/orchestrator/src/service.test.ts` verifies repo-typed configured paths are loaded, unsafe issue-workspace roots are rejected, and configured paths warn when shadowing the repository root workflow; `doctor.test.ts` and `repo-explain.test.ts` verify diagnostics use the same path. | `./e2e/run-e2e.sh happy 60` confirms the Docker repository-init → repository-start lifecycle dispatches from a migrated config and uses its configured workspace root. Legacy metadata rejection and configured-path edge cases are unit-isolated because the standard Docker fixture is freshly initialized.                                                                                                                                                                                                                                                                                                                                          |
| Tracker-aware doctor smoke reads                                             | `packages/cli/src/commands/doctor.test.ts` verifies a standalone Linear project reads an active issue without GitHub Project metadata, accepts `DEV-54`, and preserves GitHub `owner/repo#number` behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `./e2e/run-e2e.sh happy 60` confirms the packaged CLI and tracker-neutral Docker lifecycle remain healthy. Linear GraphQL selection stays unit-isolated because the Docker fixture intentionally uses the file tracker and carries no live Linear credential.                                                                                                                                                                                                                                                                                                                                                                                          |
| Adapter-owned dispatch eligibility                                           | `packages/orchestrator/src/dispatch.test.ts` verifies the scheduler suppresses `dispatchable: false` issues, while each tracker adapter's suite verifies its own provider-specific derivation.                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `./e2e/run-e2e.sh non-dispatchable 30` injects a file-tracker issue with `dispatchable: false`, waits for two post-injection reconciliation ticks, confirms no worker or `run-dispatched` event exists, and verifies `repo explain` retains the adapter reason.                                                                                                                                                                                                                                                                                                                                                                                        |
| Required-label routability                                                   | `packages/worker/src/turn-lease.test.ts` verifies a confirmed active state with `routable: false` stops before the next turn; `packages/orchestrator/src/dispatch.test.ts` verifies normalized missing-label explanations and active-run cancellation without workspace cleanup; `packages/orchestrator/src/service.test.ts` verifies a due retry losing its required label releases its claim and persists the routability reason.                                                                                                                                                                                                                          | [TC-19](e2e/scenarios/19-required-label-routability.md) verifies that a missing required label prevents dispatch, then removes the label after a deterministic stub's first turn and asserts that its actual worker `state-read` prevents turn two.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Tracker refresh capability degradation                                       | `packages/worker/src/turn-lease.test.ts` verifies structured missing-env, HTTP/provider, and exception diagnostics plus warning-once behavior; `packages/worker/src/convergence-lifecycle.test.ts` verifies `403 tracker_state_requests_unsupported` skips the turn-boundary gate but accepts local convergence at the threshold, while transient 5xx failures retain thresholded fail-closed behavior.                                                                                                                                                                                                                                                      | `./e2e/run-e2e.sh happy 60` confirms the Docker worker lifecycle remains healthy. The unsupported adapter capability is unit-isolated because the Docker file tracker implements state reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Shared worktree-cache agent branch collection                                | `packages/orchestrator/src/git.test.ts` verifies that every detached ref under `refs/heads/` in the shared bare cache is deleted only when its tip is reachable from `refs/remotes/origin/*`; unpushed branches and branches linked to live worktrees are retained, including branches from other projects sharing the cache.                                                                                                                                                                                                                                                                                                                                | The Docker file tracker does not create real agent commits or remote branches; repository-fixture coverage is the authoritative TC for this Git reachability guarantee.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Normalized per-state concurrency limits                                      | `packages/core/src/workflow-loader.test.ts` verifies trimmed/lowercased map keys and ignored invalid entries; `packages/orchestrator/src/dispatch.test.ts` verifies a padded mixed-case key caps matching tracker states; `packages/orchestrator/src/explain.test.ts` verifies `repo explain` reports the same mixed-case per-state cap as dispatch.                                                                                                                                                                                                                                                                                                         | `./e2e/run-e2e.sh happy 60` confirms the Docker dispatch lifecycle remains healthy with the orchestrator's canonical workflow-state lookup path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

| Removed flat tracker keys | `packages/core/src/workflow-loader.test.ts` verifies every removed flat key fails with `workflow_deprecated_key`; `packages/cli/src/commands/doctor.test.ts` verifies doctor retains a copyable provider migration block. | [TC-22](e2e/scenarios/22-flat-tracker-keys-rejected.md) runs the packaged CLI inside the Docker image against a flat-key workflow and confirms the typed migration failure, while the provider-form `happy` seed remains healthy. |

| §17 conformance coverage | Tracker empty-input and malformed-refresh cases are deterministic adapter tests; workspace-file and no-running reconciliation cases are deterministic orchestrator tests. The authoritative row-to-test map is in `docs/architecture.md` under “§17 conformance test matrix”; Linear malformed polling-item omission and stderr isolation are documented gaps, while `start.test.ts` host/port/bind coverage belongs to §13.7. | `./e2e/run-e2e.sh happy 60` remains the Docker lifecycle confirmation for the file-tracker and workspace path. Run `docker compose -f docker-compose.e2e.yml exec -T symphony-e2e node /app/e2e/host-dynamic-tool-e2e.mjs` for the dynamic-tool boundary. The malformed-provider and regular-file cases remain unit-isolated because the Docker fixture intentionally uses valid file-tracker data and a fresh workspace. |

`docker-compose.e2e.yml` uses `environment.STUB_SCENARIO: ${STUB_SCENARIO:-happy}`, so the scenario can be selected via a shell environment variable.

```bash
STUB_SCENARIO=fail docker compose -f docker-compose.e2e.yml up -d --build
```

### Concurrent worktree regression

From two separate worktrees, start the happy-path runner at the same time:

```bash
(cd /path/to/worktree-a && ./e2e/run-e2e.sh happy 60) &
(cd /path/to/worktree-b && ./e2e/run-e2e.sh happy 60) &
wait
```

Both commands must report `PASSED`. Each log prints a different `Compose project:` value and derived host port, and each EXIT trap runs `docker compose --project-name <name> down --volumes --remove-orphans` before reclaiming only its derived image tag, so neither runner removes the other runner's resources or leaves its project-tagged image behind.

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
  retryQueue: [.retryQueue[] | {issueId, attempt, error, retryKind, nextRetryAt}],
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
- Worker-level `max_turns` starts a second Claude invocation with continuation guidance and the same resumed session
- Claude read timeout and output-silence turn timeout are unit-covered in `packages/runtime-claude/src/spawn.test.ts`
- Inter-run recover includes `--resume <prevId> --fork-session`, stores a new session id, and preserves the `parentRunId` link
- Resume session rejection records a `session_invalidated` event
- The worker-owned loopback MCP server accepts one Claude-stub `tools/call`,
  uses the host credential, and emits start/stop lifecycle logs while the
  generated child configuration contains only its endpoint capability
- The child receives a runtime-owned `HOME`/`GH_CONFIG_DIR`, no raw GitHub or
  Linear credential, no broker secret, and no inherited Git credential helper
- The successful worker lifecycle fetches and pushes the assigned branch from
  the host after the agent turns complete; unit fixtures additionally prove a
  child-mutated `origin` and executable pre-push hook cannot affect or observe
  the credential-bearing transport

### 6. Check logs

```bash
# Orchestrator logs
docker compose -f docker-compose.e2e.yml logs symphony-e2e

# Event log (structured NDJSON, tmpfs by default)
docker compose -f docker-compose.e2e.yml exec symphony-e2e sh -c 'cat /e2e/work/test-repo/.runtime/orchestrator/runs/*/events.ndjson'

# Host mirror log (when the events override is enabled)
tail -f evidence/runs/*/events.ndjson

# Worker log (only stderr is captured)
docker compose -f docker-compose.e2e.yml exec symphony-e2e sh -c 'cat /e2e/work/test-repo/.runtime/orchestrator/runs/*/worker.log'
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

| File                                       | Purpose                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `e2e/fixtures/happy-path.json`             | Single issue (state: Ready)                                                  |
| `e2e/fixtures/multi-issue.json`            | 3 issues (concurrency test, concurrency_limit=2)                             |
| `e2e/fixtures/blocked-issue.json`          | Adapter-derived non-dispatchable issue with best-effort `blockedBy` metadata |
| `e2e/fixtures/dispatch-start-failure.json` | Poison first candidate followed by a healthy dispatch candidate              |
| `e2e/fixtures/non-dispatchable.json`       | File-tracker issue with `dispatchable: false`; must not dispatch             |
| `e2e/fixtures/terminal-candidate.json`     | Closed source issue left in active Project status                            |

### Predefined Scenario Documents

| File                                                      | Scenario                                                                                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/scenarios/01-happy-path.md`                          | Issue dispatch → worker completion → lifecycle observation                                                                               |
| `e2e/scenarios/02-multi-issue.md`                         | Verify concurrency limit                                                                                                                 |
| `e2e/scenarios/03-stall-detection.md`                     | stall → SIGTERM → retry                                                                                                                  |
| `e2e/scenarios/04-fail-retry.md`                          | Failure → retry scheduling                                                                                                               |
| `e2e/scenarios/05-before-remove-hook-failure.md`          | Verify a `before_remove` hook failure does not block workspace cleanup                                                                   |
| `e2e/scenarios/06-retry-title-preservation.md`            | Issue title preservation during retry/recovery                                                                                           |
| `e2e/scenarios/06-worker-failure-lifecycle-regression.md` | Worker failure lifecycle regression verification                                                                                         |
| `e2e/scenarios/07-release-missing-retry.md`               | Release a missing retry queue instead of restarting                                                                                      |
| `e2e/scenarios/08-evidence-permissions.md`                | Verify event-mirror evidence file permissions and cleanup                                                                                |
| `e2e/scenarios/09-linear-sandbox.md`                      | Verify Linear sandbox lifecycle, confirmed per-turn state reads, branch-based dirty-workspace attribution, and reconciliation edge cases |
| `e2e/scenarios/10-http-auth-hardening.md`                 | Verify HTTP localhost default binding, bearer auth gating, and state redaction                                                           |
| `e2e/scenarios/10-orchestrator-tracker-state.md`          | Verify run-scoped tracker API authorization, durable rejection, and exact-item concurrency                                               |
| `e2e/scenarios/11-stale-run-recovery.md`                  | Verify stale-run ownership and lifecycle recovery                                                                                        |
| `e2e/scenarios/12-transition-comment-race.md`             | Verify orchestrator-owned transition comments survive reconciliation races                                                               |
| `e2e/scenarios/13-api-progress-convergence.md`            | Verify confirmed API lifecycle progress persists as a successful run without workspace mutations                                         |
| `e2e/scenarios/13-standalone-project-model.md`            | Verify the standalone project model (project `.env`, MCP, worktree, and branch isolation) — `pnpm e2e:standalone-project`                |
| `e2e/scenarios/14-dispatch-start-failure-isolation.md`    | Verify one candidate's pre-spawn failure records retry state without starving later candidates                                           |
| `e2e/scenarios/15-terminal-candidate-reconciliation.md`   | Verify a closed issue in active Project status converges to `Done` without worker dispatch                                               |
| `e2e/scenarios/15-cache-maintenance.md`                   | Verify cache inventory, dry-run eviction, and active-worktree preservation                                                               |
| `e2e/scenarios/16-bounded-finalization-deferral.md`       | Verify persistent unknown final tracker reads emit three durable deferrals and enter failure retry handling                              |
| `e2e/scenarios/16-packaged-runtime-entrypoints.md`        | Verify the built CLI's MCP dispatcher and Git credential helper subprocesses inside Docker                                               |
| `e2e/scenarios/16-planning-phase-prompt.md`               | Verify normalized `planning_states` classification reaches the dispatched prompt                                                         |
| `e2e/scenarios/16-repo-embedded-workspace-root.md`        | Verify repo-embedded issue workspaces use `workspace.root` while workspace records remain in orchestrator state                          |
| `e2e/scenarios/17-retry-prompt-attempt.md`                | Verify continuation retry attempt reset and prompt rendering are covered by the Docker lifecycle path and unit assertions                |
| `e2e/scenarios/18-dispatchable-eligibility.md`            | Verify non-dispatchable tracker records do not start workers while retaining an explainable reason                                       |
| `e2e/scenarios/19-required-label-routability.md`          | Verify required-label filtering cancels active runs without workspace cleanup and exposes the reason                                     |
| `e2e/scenarios/20-agent-child-isolation.md`               | Verify unconditional child credential/config isolation, host-only MCP tools, and worker-exit Git publication                             |
| `e2e/scenarios/21-linear-dirty-workspace-recovery.md`     | Verify a dirty `DEV-54` branch/workpad survives incomplete-turn recovery without quarantine                                              |
| `e2e/scenarios/23-dirty-unpublished-worktree.md`          | Verify terminal lifecycle retains tracked and untracked work left unpublished after committed transport                                  |
| `e2e/scenarios/24-assigned-branch-publication.md`         | Verify authenticated, idempotent publication makes the assigned branch visible before worker exit                                        |
| `e2e/scenarios/20-bounded-recovery-circuit-breaker.md`    | Verify dirty-workspace recovery failures exhaust a durable budget and require an explicit tracker state change to re-arm                 |
| `e2e/scenarios/17-instance-registry.md`                   | Verify host-global instance listing, stale-registry diagnostics, and daemon PID recording only after lock acquisition                    |
| `e2e/scenarios/17-retry-fire-refresh.md`                  | Verify single-ID retry refresh, terminal cleanup, bounded capacity-postponement events, and retry backoff safety                         |

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
