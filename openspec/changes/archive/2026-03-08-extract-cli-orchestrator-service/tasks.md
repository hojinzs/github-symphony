## 1. Orchestrator Service Foundation

- [x] 1.1 Create a dedicated orchestrator app or package with CLI entrypoints for `run`, `run-once`, `dispatch`, `run-issue`, `recover`, and `status`
- [x] 1.2 Extract or share tracker workflow-evaluation logic so the orchestrator, not the worker, determines actionable issues
- [x] 1.3 Define the orchestrator runtime directory layout for leases, run snapshots, and event logs
- [x] 1.4 Implement repository-owned `WORKFLOW.md` loading for new runs and remove dependence on control-plane-generated workflow artifacts

## 2. Dispatch And Recovery

- [x] 2.1 Implement workspace-scoped polling and actionable issue selection in the orchestrator
- [x] 2.2 Implement issue-phase leasing so only one active run exists per issue phase within a workspace
- [x] 2.3 Implement worker launch, health observation, and restart recovery from tracker plus filesystem state
- [x] 2.4 Implement fixed polling cadence, bounded concurrency, stop-on-ineligible behavior, retry backoff, and structured orchestration logs

## 3. Worker Contract Refactor

- [x] 3.1 Refactor worker startup so it accepts assigned issue-run context from the orchestrator instead of polling trackers directly
- [x] 3.2 Update runtime launch and credential resolution paths to report assigned-run state and failure outcomes
- [x] 3.3 Update workflow artifact consumption so both orchestrator and worker use the same phase definitions

## 4. Control-Plane Responsibility Split

- [x] 4.1 Update workspace provisioning to persist workspace, tracker-binding, repository, and runtime metadata without owning dispatch logic
- [x] 4.2 Update control-plane flows so they are optional operator extensions and not required for orchestrator operation
- [x] 4.3 Update dashboard and status endpoints to aggregate orchestrator and worker state surfaces
- [x] 4.4 Replace control-plane filesystem status reads with orchestrator status API consumption

## 5. GitHub Adapter Extension

- [x] 5.1 Extract GitHub Projects binding and issue-creation behavior into a GitHub tracker adapter that satisfies the core tracker contract
- [x] 5.2 Update workspace setup and issue creation APIs to route GitHub-specific behavior through the adapter extension
- [x] 5.3 Verify the orchestrator can run the same core dispatch flow with the GitHub adapter without embedding GitHub-specific assumptions in the core service

## 6. Documentation And Verification

- [x] 6.1 Update architecture docs and local runbooks to describe the core Symphony layers versus optional extensions
- [x] 6.2 Add tests for CLI dispatch modes, lease deduplication, workflow reloads, restart recovery, and worker assignment
- [x] 6.3 Verify the system can run headlessly from the CLI without the control plane while still surfacing status through optional extensions when available
