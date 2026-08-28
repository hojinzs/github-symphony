# Spec: Scope GitHub Project V2 Dispatch to the Daemon's Own Repo

- **Date**: 2026-07-06
- **Status**: Shipped — `fix(tracker-github): scope Project V2 dispatch to daemon repo` (PR #435, `4499b07`)
- **Refs**: #433
- **Symphony Layers**: Integration (`tracker-github`), Coordination (dispatch selection), Observability (filter event)
- **Related ADRs**:
  - `docs/adr/2026-05-04_single-repo-orchestrator.md` — the fundamental background of this spec. The `repositories[]` → `repository` collapse and the adoption of "1 repo = 1 instance".
  - `docs/adr/2026-03-19_github-project-v2-state-filtering-cache.md` — Project V2 in-memory filtering context.

## Context / Problem

`tracker.settings.repository` (or an equivalent repo identifier) exists per daemon but **has never been wired up as a dispatch filter.** A single GitHub Project V2 can contain multiple linked repositories, yet the only in-memory filter in the selection loop is the assignee filter (`assignedOnly`) (the selection loop in `packages/tracker-github/src/adapter.ts`, `isIssueAssignedToLogin`).

Result: attaching two or more per-repo daemons to one Project (e.g. Project #14, `PVT_kwHOAPiKdM4BYPVD`) makes each daemon pick up all `--assigned-only` items across every repo in the project → two workers attach to the same issue, causing squash-merge/branch-push races and duplicate workpads.

### History investigation (why was there "no" filter)

Findings from the git archive investigation (this session's investigation):

- The selection loop has **never had a `content.repository` comparison filter, from the initial implementation (bc1e7ca) to now.** Pickaxe on `content.repository` → 2 additions, 0 deletions. The only selection filter, assigned-only, was added in `a4aa8ac` (2026-03-14) and remains unchanged.
- Two repo-scoping mechanisms existed in the past and were removed, but **neither was a dispatch filter**:
  1. `OrchestratorProjectConfig.repositories: RepositoryRef[]` — used for workspace layout/cleanup/workflow resolution/policy aggregation. Collapsed to the single `repository` field by the single-repo ADR (2026-05-04) (PR #303 / #292).
  2. `allowed_repositories` WORKFLOW.md front matter → `allowedRepositories` — a worker-side **clone safety allowlist** (the "Repository is not in the workspace allowlist" guard). Removed by the spec alignment in `1f8c8d6` (2026-03-13).
- Therefore this work is a **new addition**, not a "restoration". The single-repo collapse encouraged the "one Project, multiple per-repo daemons" operating shape, but selection was never scoped by repo, so this is adding the filter that became necessary for the first time. It fills the "Premature collapse risk: medium" gap the single-repo ADR left behind.

## Decision

**Automatically scope GitHub Project V2 selection to the daemon's own repo, and provide an explicit override.**

Key observation: the daemon **already knows its own repo.** The CLI resolves a `RepositoryRef` (owner/name) from the cwd's git `origin` (`packages/cli/src/repo-runtime.ts:248` `resolveRepository`, `git config --get remote.origin.url`) and puts it into `OrchestratorProjectConfig.repository` (`packages/core/src/contracts/status-surface.ts:31`). This value is the default source for auto-scoping.

### Filter resolution rules

Based on the value of `tracker.settings.repository` (`readOptionalStringTrackerSetting(project.tracker, "repository")`):

| Value                | Resolution result (`repositoryFilter`)                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| unset / empty string | **`{ owner: project.repository.owner, name: project.repository.name }`** — auto-scoped to the cwd origin (default behavior) |
| `"owner/name"`       | `{ owner, name }` — override (when targeting a repo other than the cwd origin)                                              |
| `"*"`                | `null` — dispatch everything (opt-out escape hatch)                                                                         |

- `"*"` is the only sentinel. No aliases like `"all"` are introduced (YAGNI).
- `"owner/name"` parsing follows the same rule as the identifier construction (`${owner.login}/${name}`) around `adapter.ts` ~L1304. Exactly one slash with both sides non-empty; otherwise an explicit parse error.

## Design

### Component 1 — resolved config type (`packages/tracker-github/src/adapter.ts:15`)

Add a field to `GitHubTrackerConfig`:

```ts
export type GitHubTrackerConfig = {
  // ...existing fields...
  repositoryFilter?: { owner: string; name: string } | null;
};
```

### Component 2 — resolution (`resolveGitHubTrackerConfig`, `packages/tracker-github/src/orchestrator-adapter.ts:139`)

It already receives `project: OrchestratorProjectConfig`, so `project.repository` is accessible. Compute `repositoryFilter` per the table above and add it to the returned object:

```ts
const repositoryOverride = readOptionalStringTrackerSetting(
  project.tracker,
  "repository"
);
const repositoryFilter = resolveRepositoryFilter(
  repositoryOverride,
  project.repository
);
```

- `resolveRepositoryFilter(override, ownRepo)`: `"*"`→`null`; `"owner/name"`→parse; unset→`{ owner: ownRepo.owner, name: ownRepo.name }`.
- When it resolves to `null` via `"*"`, log a one-per-process informational warning: repository scoping disabled → if multiple daemons watch the same Project, double dispatch is possible. (Deduped like the existing `warnedLegacyAssignedOnlyProjectIds` pattern.)

### Component 3 — selection loop (`packages/tracker-github/src/adapter.ts`, right after the assignee skip, ~L513)

```ts
if (config.repositoryFilter) {
  const wanted = `${config.repositoryFilter.owner}/${config.repositoryFilter.name}`;
  const itemRepo = item.content?.repository
    ? `${item.content.repository.owner.login}/${item.content.repository.name}`
    : null;
  if (itemRepo !== wanted) {
    excludedByRepository += 1;
    return [];
  }
}
```

- Draft items / items without `content.repository`: **excluded** when the filter is active, since they cannot match.
- The GraphQL item query **already selects `repository { name url owner { login } }`** → no query change needed.

### Component 4 — Observability (`packages/tracker-github/src/adapter.ts`)

Emit `tracker-dispatchability-derived` when assignment or repository eligibility
rules are active. Its payload retains `projectId`, the active
`currentUserLogin` and/or repository scope, `includedCount`, and a
`nonDispatchableByReason` breakdown so operators can triage retained records
without relying on the removed filter-only events.

## Backward Compatibility / Change Grade ⚠️

**The default behavior changes**: previously a Project-bound daemon dispatched assigned items across all repos in the project; now it dispatches only its own repo. This is the intended fix (#433), but it is a behavior change.

- Escape hatch: `tracker.settings.repository: "*"` → restores all-repo dispatch.
- Thanks to auto-scoping, the "unconfigured daemons double-dispatching" scenario the original issue worried about **disappears at the default** (two per-repo daemons are automatically disjoint). The remaining risk is only daemons that turned scoping off with `"*"` → covered by Component 2's warning log.
- Changeset: **minor** (feat, behavior change). Not the patch of the original issue draft. State the behavior change and the `"*"` escape hatch in the release notes.

## Testing

Unit tests in `packages/tracker-github/src/*.test.ts` (reusing the same mocked Project V2 payload):

1. **Auto-scope disjointness**: two configs with the same `projectId` but different `project.repository` → each gets only its own repo's items, no intersection.
2. **Regression guard (changed)**: a config with `repository` unset → assert scoping to `project.repository`, not to everything.
3. **Opt-out**: `tracker.settings.repository: "*"` → all items across all repos are dispatched.
4. **Override**: when `"owner/name"` differs from the cwd origin, filtering uses the override repo (not the cwd origin).
5. **Assignee cross-exclusion**: an item whose `content.repository` differs from the filter is excluded even when assigned to the current user.
6. **Draft exclusion**: items without `content.repository` are excluded when the filter is active.
7. **Parse errors**: an override value without a slash or with an empty side is an explicit error.

## Verification (repo review rules)

- `pnpm lint && pnpm test && pnpm typecheck && pnpm build` green.
- `gh-symphony doctor --smoke` passes.
- `gh-symphony repo start --once` dry-run on a project → confirm only the daemon's own repo's items are selected; attach the dispatch summary to the workpad.

## Out of Scope

- Non-GitHub trackers (`tracker-file`, `tracker-linear`) unchanged.
- Daemon process model unchanged — only the in-memory dispatch filter + config wiring.
- The assignee (`assignedOnly`) filter is kept, unchanged.
- The GraphQL item query is unchanged (repository owner/name already selected).
- Cross-process double-dispatch detection not implemented (covered by docs + the warning log instead).

## Alternatives Considered

- **A. Explicit opt-in only (the issue's original proposal)**: new `tracker.settings.repository`, unset = dispatch everything (unchanged). Fully backward compatible, but users must configure it manually, unconfigured users keep hitting #433, and it duplicates `project.repository`. **Rejected** — auto-scoping is possible since the data already exists, so this pushes the burden onto users.
- **B. Forced auto-scope (no override)**: always filter by `project.repository`. Simplest and most faithful to the ADR, but setups dispatching multiple repos of one project from a single daemon would break with no escape hatch. **Rejected** — no escape hatch.
- **C. Auto-scope + explicit override (adopted)**: default auto-scoping resolves #433 with zero configuration, with the `"owner/name"` override and the `"*"` opt-out provided. Aligned with the single-repo ADR philosophy while preserving an escape hatch.
