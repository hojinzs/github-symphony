## Why

The current platform model assumes a worker can pick up an actionable issue and carry it straight through to completion. That is too coarse for code changes that need a human checkpoint between analysis and implementation, and it does not define how PR-based delivery should drive final issue completion.

## What Changes

- Add an approval-gated execution workflow where the worker first analyzes an issue, posts a plan or root-cause analysis as a GitHub issue comment, and moves the tracked item into a human-review state instead of implementing immediately.
- Add a second execution phase that resumes only after a human changes the issue or project item into an approved active state, performs the code change, opens or updates a pull request, and posts a completion report back to the issue.
- Add merge-driven completion so that a merged PR automatically transitions the tracked issue or project item to its completed state without requiring the worker to keep polling for merge results indefinitely.
- Expand the GitHub integration and runtime contract to support the permissions, credentials, and lifecycle signals required for comment posting, branch push or PR creation, and post-merge completion.

## Capabilities

### New Capabilities
- `approval-gated-agent-workflow`: Multi-phase worker workflow for plan comment handoff, human approval, implementation, PR reporting, and merge-driven completion.

### Modified Capabilities
- `issue-driven-agent-execution`: Execution no longer assumes a single pass from actionable issue to `Done`; the worker must support planning-only runs, human handoff states, and PR-linked completion semantics.
- `isolated-symphony-runtime`: The runtime contract must support resumable multi-run issue execution, phase-aware tracker handling, and credentials suitable for both tracker mutation and repository write operations.

## Impact

- Affected specs: `issue-driven-agent-execution`, `isolated-symphony-runtime`, and new `approval-gated-agent-workflow`
- Affected code: `packages/worker`, GitHub tracker integration, runtime credential brokering, GitHub App permissions, and any control-plane automation used for merge completion
- Affected external systems: GitHub Issues, GitHub Projects, pull requests, GitHub App configuration, and any webhook or event handling needed after merge
