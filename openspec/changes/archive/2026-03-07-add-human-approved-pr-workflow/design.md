## Context

The current repository has the pieces for a GitHub-backed Symphony platform, but not the full runtime loop for multi-phase work. The control plane can create workspaces and issues, the worker package can read GitHub Project items and build a `codex app-server` launch plan, and the runtime can inject a `github_graphql` tool. What is missing is the execution lifecycle that turns one issue into multiple bounded runs with explicit human handoff points.

The requested workflow adds three new constraints:

- the first worker run must stop after producing a plan or root-cause analysis
- a human must explicitly approve work before implementation starts
- delivery is not complete when code is pushed, but when a linked pull request is merged and the tracker reflects completion

This change crosses the tracker model, runtime contract, GitHub credentials, and workspace workflow artifacts, so it needs an explicit design before implementation.

## Goals / Non-Goals

**Goals:**
- Support a two-phase execution model where the worker plans first and implements only after human approval
- Keep the worker and agent aligned with Symphony's tracker-driven execution model
- Preserve agent-owned tracker writes for plan comments, status transitions, and PR reporting
- Support repository write operations needed for branch push and pull request creation with renewable credentials
- Reach completion through merge-driven tracker updates instead of long-lived worker polling

**Non-Goals:**
- Replacing GitHub Projects with a custom control-plane workflow engine
- Adding a persistent database to the worker runtime
- Supporting arbitrary approval graphs or multiple parallel approvers in the first version
- Solving every repository policy variant in the initial change if they diverge from GitHub's default linked-issue behavior

## Decisions

### 1. Model the workflow as a tracker state machine with active and handoff states

Each workspace workflow will define named states for:

- planning-active
- human-review
- implementation-active
- awaiting-merge
- completed

The initial recommended mapping for GitHub Project `Status` values is:

- `Todo` or `Needs Plan` -> planning-active
- `Human Review` -> human-review
- `Approved` or `Ready to Implement` -> implementation-active
- `Await Merge` -> awaiting-merge
- `Done` -> completed

The worker will only pick issues in active states. A planning run always ends by posting a plan comment and moving the issue into the human-review state. An implementation run always ends by posting a delivery comment and moving the issue into awaiting-merge unless the agent determines no code change is needed.

Rationale: this mirrors Symphony's handoff-state pattern instead of forcing one long run to span analysis, approval, and delivery. The alternative was keeping an internal worker-side phase table in the control plane or database, but that would duplicate tracker truth and break the current architecture.

### 2. Keep human handoff artifacts in GitHub issue comments, not the control-plane database

The first run will publish a structured issue comment containing:

- summary of the problem or root cause
- proposed implementation steps
- notable risks or assumptions
- explicit request for human approval

The second run will publish a completion comment containing:

- summary of the implemented changes
- validation or test notes
- pull request URL
- any remaining follow-up items

Rationale: issue comments are visible to both humans and the agent, and they preserve the execution trail next to the tracked issue. The alternative was storing plan payloads in PostgreSQL and only mirroring a summary to GitHub, but that would create split-brain history.

### 3. Use GitHub-native merge completion as the primary completion path

Implementation runs will create pull requests that link back to the issue using GitHub's supported linked-issue keywords such as `Fixes #123` in the PR description. The design assumes the repository keeps GitHub's linked-issue auto-close behavior enabled. The corresponding workspace project must also have its built-in workflow enabled so that closed issues transition to `Done`.

If those GitHub-native settings are unavailable for a repository, the system may need a later fallback reconciler, but that is not the primary path for this change.

Rationale: this keeps post-run completion driven by GitHub's own merge semantics instead of teaching the worker to poll pull request state indefinitely or moving issue completion into hidden backend writes. The main alternative was a control-plane webhook that mutates project status after merge; that remains a fallback option, not the default architecture.

### 4. Extend the runtime contract to include renewable repository write credentials

The current runtime broker only supports short-lived GitHub API access for `github_graphql`. The new workflow also needs authenticated `git push` and pull request creation. The runtime will therefore expose the installation token through a safe, renewable path that can be consumed by:

- the `github_graphql` tool for issue, project, and PR mutations
- a git credential helper or equivalent HTTPS auth flow for branch push

The worker must avoid embedding long-lived credentials in workflow files or repository remotes.

Rationale: the worker already has an installation-token broker pattern, so extending that model keeps credentials renewable and workspace-scoped. The alternative was storing a static token in `worker.env` or repository config, which would weaken isolation and rotation.

### 5. Expand workflow artifacts to describe lifecycle states in addition to repository allowlists

`WORKFLOW.md` currently describes only project ID, prompt guidelines, repository allowlist, agent command, and hook path. This change will add phase-aware lifecycle configuration so the runtime can determine:

- which project states are actionable for planning
- which states are actionable for implementation
- which states are handoff-only and must never be picked
- which state transitions the agent is expected to perform at the end of each phase

Rationale: making lifecycle metadata explicit keeps orchestration behavior workspace-local and reviewable. The alternative was hard-coding state names in the worker, which would make approval workflows brittle and hard to vary later.

### 6. Build the worker loop as resumable runs over the same tracked issue

The worker will treat planning and implementation as separate runs against the same issue. The tracker adapter will infer the current phase from project status, and the runtime setup hook will prepare the repository fresh for each active phase. If a human moves an issue out of an active state while a run is ongoing, the worker should stop or decline further work in line with Symphony's tracker-driven execution model.

Rationale: separate runs match the Symphony contract better than pausing a single run for hours or days while waiting for approval. The alternative was long-lived suspended executions, which would complicate resource cleanup and recovery.

## Risks / Trade-offs

- [Repository settings diverge from GitHub defaults] -> Document the required linked-issue and project automation settings up front, and treat webhook reconciliation as a fallback follow-up if field adoption shows this is common.
- [GitHub App permissions expand] -> Limit new permissions to repository write scopes needed for push and PR creation, and continue using short-lived installation tokens instead of static credentials.
- [State naming differs across workspaces] -> Put lifecycle state names in generated workflow artifacts rather than hard-coding one status vocabulary in the worker.
- [Repeated planning runs create duplicate comments] -> Include machine-readable markers in worker-authored comments so the runtime can detect whether a phase has already posted its handoff artifact.
- [Worker scope expands beyond current sample runtime] -> Stage the implementation so orchestration loop, credential handling, and GitHub automation support can be tested independently.

## Migration Plan

1. Extend the specs and generated workspace workflow contract to describe lifecycle states and phase transitions.
2. Expand GitHub App permissions and runtime credential brokering to support repository writes and pull request creation.
3. Implement the worker-side phase detection and orchestration loop for planning and implementation runs.
4. Add agent prompts or conventions for plan comments, approval handoff, PR creation, and completion comments.
5. Add integration coverage for the full lifecycle: plan comment, human approval, implementation run, PR creation, and merge-driven completion.
6. Roll out behind a feature flag or workspace-level opt-in until GitHub permission and repository-policy assumptions are validated.

Rollback strategy: disable the approval-gated lifecycle for new workspaces, fall back to the current single-pass execution flow, and preserve issue comments and PRs already created because they are authoritative GitHub-side artifacts.

## Open Questions

- Should the platform require a fixed status vocabulary such as `Human Review` and `Await Merge`, or should those names remain configurable per workspace?
- Do we want a dedicated helper tool for GitHub REST operations, or is `github_graphql` plus native `git` sufficient for the first version?
- How should the worker detect that an implementation PR already exists for an issue when retrying after a failed run?
- If a repository has disabled GitHub's linked-issue auto-close behavior, should the first fallback be a control-plane webhook reconciler or a worker-side post-merge poller?
