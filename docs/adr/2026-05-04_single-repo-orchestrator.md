# ADR: Transition to a Single-Repository Orchestrator Model

- **Date**: 2026-05-04
- **Status**: Superseded by
  [`2026-08-13_standalone-project-instance-boundary.md`](./2026-08-13_standalone-project-instance-boundary.md)
- **Related Spec**: `docs/symphony-spec.md` §3.1, §5.1
- **Reference Implementation**: <https://github.com/openai/symphony> (elixir)
- **Related ADRs**:
  - `docs/adr/2026-03-16_issue-centric-state-model.md` (synergy — workspace key simplification)
  - `docs/adr/2026-04-29_linear-tracker-integration.md` (PR #255, proceeding orthogonally)
- **Investigation Basis**: `docs/reports/2026-05-04-single-repo-orchestrator-feasibility.md` — includes independent codex review results for 4 assumptions

## Context

The upstream `docs/symphony-spec.md` §3.1, §5.1 specifies a **single repository + repo-local `WORKFLOW.md`** model. The OpenAI Elixir reference also starts with a single command, `./bin/symphony ./WORKFLOW.md`, and one instance watches one repo.

The current github-symphony implementation embraced, as a first-class concern, the fact that a GitHub Project V2 can have multiple linked repositories, and evolved into a multi-tenant shape (`docs/reports/2026-06-25-spec-gap-analysis.md` D4):

- `OrchestratorProjectConfig.repositories: RepositoryRef[]` (array)
- Disk layout `<runtimeRoot>/projects/<projectId>/issues/<workspaceKey>/repository/`
- Key scheme `projectId × repositoryId × workspaceKey`
- The control plane (`packages/control-plane/`) also routes by `projectId`

This multi-tenant course accumulated the following friction:

1. **Shape conflict with PR #255 (Linear)** — Linear issues have no repo concept, so a single mapping `tracker.settings.repository = "owner/repo"` is required. The adapter shapes diverge into GitHub array vs Linear single.
2. **Weakened upstream spec conformance** — spec §5.1 says "the workflow file is expected to be repository-owned", but currently `loadProjectWorkflow` picks `tenant.repositories[0]` or `issue.repository`, a policy-dependent behavior (`packages/orchestrator/src/service.ts:1100-1140`).
3. **Bootstrap complexity** — users must go through a GitHub Project ID, projectSlug, and a projectConfig directory to get started. This loses the `cd repo && symphony start` simplicity of the spec/reference.

Investigation results (`docs/reports/2026-05-04-single-repo-orchestrator-feasibility.md`, 4 codex reviews):

- The issue/run/workflow processing paths effectively already operate on a single-repo assumption. Array dependence is confined to ~3 policy aggregation spots (`service.ts:825,2527,2546`) — moving to a single repo goes in the direction of **simplification** (`min(x) → x`).
- There is no place where `OrchestratorProjectConfig.repositories` is essentially used for cross-repo routing. issue.repository / run.repository are already a single `RepositoryRef`.
- Strong synergy with ADR `2026-03-16`'s adoption of `deriveWorkspaceKey(identifier)` — the single-repo transition makes the issue-centric key simplification more natural.

## Decision

Transition the orchestrator to a **single-repo watch** model.

> **2026-08-13 refinement:** the instance boundary is **one project**, not
> one repository. A project owns policy and its tracker mapping; several
> projects may safely reference one repository when their mappings are
> disjoint. The shared bare cache remains repository-scoped, while project
> slugs namespace worktree branches. This repository-local extension keeps the
> upstream single-workflow orchestrator model intact per instance.

### Core model

```
$ git clone git@github.com:acme/platform.git
$ cd platform
$ gh-symphony repo init     # detect/create WORKFLOW.md, validate tracker auth
$ gh-symphony repo start    # start polling with the cwd's WORKFLOW.md policy
```

- `OrchestratorProjectConfig.repositories: RepositoryRef[]` → single `repository: RepositoryRef` field.
- The primary source of WORKFLOW.md is the **cwd (or an explicitly given repo directory)**. The `--workflow-file <path>` override is kept as-is per spec §5.1.
- Disk layout `.runtime/orchestrator/<workspaceKey>/...` — the `<projectId>` level is removed.
- CLI commands (`init`/`start`/`status`/`stop`) are cwd-based. The `--project-id` option is **removed** (breaking change — §Resolved Decisions S-Q1).
- Tracker config takes the shape `tracker.settings.repository = "owner/repo"`, common to GitHub/Linear.
- To operate multiple repos on one machine, run **one instance per repo** (separate port, separate `.runtime/`) — unix-style multiplex.

### 1 repo = 1 instance = 1 control-plane

```bash
$ cd ~/work/repo-a && gh-symphony repo start --web 4680
$ cd ~/work/repo-b && gh-symphony repo start --web 4681
```

As many control-plane instances come up as there are repositories. A unified dashboard is out of scope for this transition — if it becomes necessary, a reverse proxy or external aggregator will be addressed in a separate ADR.

## Consequences

### Positive

- **Restored upstream spec conformance** — resolves `docs/reports/2026-06-25-spec-gap-analysis.md` D4 (multi-tenant workspace path).
- **Unified adapter contract with PR #255** — both GitHub/Linear use the single `tracker.settings.repository` shape.
- **Compressed key scheme** — `(projectId × repositoryId × workspaceKey) → workspaceKey`. Synergy with ADR `2026-03-16`'s adoption of `deriveWorkspaceKey(identifier)`.
- **Simplified control plane** — removes `ControlPlaneServerOptions.projectId` and the server-side store's `projectId` dependence.
- **Simplified bootstrap** — 4 steps: `git clone → cd → init → start`.
- **Instance isolation** — a worker runaway or secret leak in one repo does not affect other repos. `.env` lives inside the repo directory.

### Negative

- **Loss of a natural unified dashboard** — viewing N repos' activity on one page requires a reverse proxy or an external aggregator. Accepted for this transition.
- **Operational multiplexing burden** — operating 5 repos means managing 5 processes (an external supervisor such as systemd/Docker/foreman is recommended).
- **Premature collapse risk: medium** (codex). If a true multi-repo fan-in feature such as cross-repo dependency analysis is needed in the future, there will be a reintroduction cost. However, most single-tenant tools accept the same trade-off.

### Effort

- **Estimated 60–80h (1.5–2 weeks) / 1 person** — reflects codex's upward-revised estimate.
- Core changes 700–1,100 LoC. Updating ~64 of the 94 suites' fixtures in `service.test.ts` is the largest cost.

## Implementation Plan

| Phase                    | Scope                                                                                                                                                                                                                                                                              | Notes                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **P1 — Contract**        | `packages/core/src/contracts/status-surface.ts:15-21` `repositories[]→repository`. Make `projectId` optional in `state-store.ts:11-40`. Remove `projectId` from `workspace/identity.ts:12-14,43-60` + consolidate on `deriveWorkspaceKey(identifier)` (adopting ADR `2026-03-16`). | The type system drives the following phases.      |
| **P2 — Service core**    | Simplify policy aggregation logic in `packages/orchestrator/src/service.ts:825,868-946,2527-2638` (`min(repos.x) → repository.x`). Change disk layout in `fs-store.ts:43-188,297-346`.                                                                                             | Accompanied by `service.test.ts` fixture updates. |
| **P3 — CLI / migration** | Make `packages/cli/src/commands/{init,start,project,repo}.ts` cwd-based. Auto-promote script for the existing `.runtime/projects/<projectId>/...` (when a single projectId is found).                                                                                              | Minimize breaking changes.                        |
| **P4 — Control plane**   | Remove `projectId` routing from `packages/control-plane/src/server.ts` and `packages/dashboard/src/store.ts:33-47`. Simplify some SPA routes.                                                                                                                                      | UI regression tests.                              |
| **P5 — Tests / e2e**     | Bulk-update the 64 suite fixtures in `service.test.ts`. Validate `e2e/seed/config.json`.                                                                                                                                                                                           | Confirm spec conformance.                         |

Each phase is an independent PR. Full-scale changes begin with P2 after P1 lands.

## Migration

Handling existing users' `.runtime/orchestrator/projects/<projectId>/...`:

1. **Only a single `<projectId>` directory found** — during `gh-symphony repo init`, automatically promote its contents to the `.runtime/orchestrator/` root. The `projectId` field in run records is removed during migration (since the orchestrator-side namespace itself disappears).
2. **Multiple `<projectId>` directories found** — `gh-symphony repo init` aborts with an explicit error and prints manual cleanup guidance to the user (§Resolved Decisions S-Q2). The user decides which directory to keep and which to archive, then re-runs. No automatic branching logic is introduced.

## Alternatives Considered

### A. Keep the current multi-tenant model + strengthen spec divergence documentation

Pros: zero change cost. Cons: adapter shape divergence with PR #255, accumulating spec divergence, permanent `projectId` dependence in the control plane. **Rejected** — the friction accumulates over time.

### B. Keep multi-tenant + enforce "1 project = 1 repo" only in the Linear adapter

Pros: the GitHub side stays as-is. Cons: the per-adapter shapes solidify while diverged — the same divergence recurs when adding future trackers. **Rejected** — a choice that postpones essential alignment.

### C. This ADR — single-repo transition

Pros: restored spec conformance, unified adapter contract, synergy with ADR `2026-03-16`, simplified bootstrap. Cons: 60–80h cost, loss of a natural unified dashboard. **Adopted**.

## Resolved Decisions (at proposal)

Items settled together with the adoption of this ADR. All three accept breaking changes — since the single-repo transition is itself a schema-breaking change, it is more consistent to clean these up at the same time.

1. **S-Q1 — Handling of the `--project-id` CLI option** → **fully removed**. No internal-only grace period. Existing user scripts must be updated to be cwd-based.
2. **S-Q2 — Migration script handling of multiple `<projectId>` directories** → **error + manual cleanup guidance**. `gh-symphony repo init` aborts with an explicit error when multiple `<projectId>` directories are found. No automatic branching logic is introduced. The user decides which directory to keep and re-runs.
3. **S-Q3 — Handling of the orchestrator-side `projectId`/`slug` in the `/api/v1/state` response** → **fully removed + replacement identifier added**. Add `repository: { owner, name }` as a first-class identifier in the response. If a tracker-side identifier such as the GitHub Project V2 node ID is needed, expose it as `tracker.subjectId` or `tracker.settings.projectId` (the exact field shape is decided in the P4 phase). The dashboard/client are updated together in P4.

> **Clarification**: every "projectId" in these decisions refers only to the **orchestrator-side namespace** (e.g. `"team-eng-symphony"`). The **tracker-side `projectId`** (the GitHub Project V2 node ID — located at `tracker.settings.projectId` in WORKFLOW.md) is kept as-is, and is in fact exposed in the response so operators can better know "which GitHub Project this instance watches".

## References

- Investigation document: `docs/reports/2026-05-04-single-repo-orchestrator-feasibility.md` (including citations of the 4 codex reviews)
- Spec gap analysis: `docs/reports/2026-06-25-spec-gap-analysis.md` D4
- Upstream spec: `docs/symphony-spec.md` §3.1, §5.1
- OpenAI Elixir reference: <https://github.com/openai/symphony/blob/main/elixir/README.md>
- Related PR: #255 (Linear adapter ADR draft)
