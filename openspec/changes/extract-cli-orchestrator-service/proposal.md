## Why

The current project centers orchestration behavior inside the control plane and runtime launcher layers, which does not match the Symphony architecture in [SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md). To fully implement Symphony, the system needs a dedicated orchestrator that can run headlessly from the CLI, while the control plane becomes an optional operator extension for workspace setup, tracker binding, issue creation assistance, and status monitoring.

## What Changes

- Add a new CLI-first orchestrator service that polls configured tracker adapters, selects actionable work, assigns worker runs, and performs recovery without depending on a web frontend.
- Re-scope the control plane to an optional management extension that handles workspace creation, tracker binding, repository allowlists, operator-assisted issue creation, and aggregated orchestration/runtime visibility instead of owning dispatch logic.
- Re-scope the worker runtime to execute a single assigned issue run, launch `codex app-server`, and report execution state without polling trackers on its own.
- Move issue polling, dispatch, retry, and reconciliation responsibilities out of control-plane-adjacent flows and into the orchestrator service.
- Make repository-owned `WORKFLOW.md` files the source of workflow semantics instead of control-plane-generated workflow artifacts.
- Define orchestrator persistence around tracker state, local filesystem state, and process reconciliation instead of a required persistent database for orchestration correctness.
- Recast GitHub Projects support as a tracker adapter extension layered on top of Symphony core orchestration rather than as a core orchestration requirement.

## Capabilities

### New Capabilities
- `cli-orchestrator-service`: Headless Symphony orchestrator that runs from the CLI, polls trackers, dispatches work to workers, and recovers state from tracker plus filesystem data.
- `github-project-tracker-adapter`: Optional GitHub-backed tracker adapter and operator workflows for workspace binding and issue creation.

### Modified Capabilities
- `workspace-control-plane`: Control-plane responsibilities change from provisioning and directly managing runtime execution to operator-driven workspace/tracker setup and observability.
- `issue-driven-agent-execution`: Actionable issue detection and run assignment move from worker-led tracker reads to orchestrator-led polling and dispatch through a tracker adapter contract.
- `isolated-symphony-runtime`: Worker runtimes change from long-lived workspace-bound workers to assigned issue executors launched by the orchestrator.

## Impact

- Affected code: [apps/control-plane](/Users/stevelee/.codex/worktrees/cfff/github-symphony/apps/control-plane), [packages/worker](/Users/stevelee/.codex/worktrees/cfff/github-symphony/packages/worker), new orchestrator service under `apps/` or equivalent runtime entrypoints, repository workflow loading paths, and shared tracker/runtime libraries.
- Affected interfaces: workspace provisioning APIs, dashboard/status APIs, worker launch contracts, and CLI entrypoints for orchestration.
- Operational impact: orchestration must run without a frontend, recover from local state and tracker state, use repository workflow files as the execution contract, and expose enough status for optional extensions such as the control plane to observe active runs.
