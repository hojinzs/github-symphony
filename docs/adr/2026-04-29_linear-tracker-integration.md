# ADR: Linear Tracker Integration

- **Date**: 2026-04-29
- **Decision Update**: 2026-05-13
- **Status**: Accepted with review items
- **Related Spec**: `docs/symphony-spec.md` §5, §10.5, §11; upstream OpenAI Symphony `SPEC.md`
- **Reference Implementation**: <https://github.com/openai/symphony/tree/main/elixir>
- **Related ADRs**: `docs/adr/2026-05-04_single-repo-orchestrator.md` (single-repo transition — single repo mapping and unified shape for the Linear adapter)
- **Layers Affected**: Integration (Linear tracker adapter), Configuration (`WORKFLOW.md` schema), Coordination (worker/tool injection), Policy (`WORKFLOW.md` prompt)

## Context

GitHub Symphony currently supports two trackers: GitHub Project V2 (`packages/tracker-github`) and a file-based fixture (`packages/tracker-file`). The `OrchestratorTrackerAdapter` contract (`packages/core/src/contracts/tracker-adapter.ts`) is already abstracted, but teams that use Linear in real production environments are asking for adoption support.

Following the 2026-05-13 re-review, this ADR prioritizes the **upstream OpenAI Symphony spec and the Elixir reference implementation** over GitHub Symphony's own multi-tenant/approval-extension inertia. In other words, the goal of this ADR is not to "shoehorn Linear into GitHub Symphony" but to fit a Linear tracker into the `WORKFLOW.md`-centric Symphony model.

Key criteria:

1. `WORKFLOW.md` is the key source of truth.
2. One orchestrator instance corresponds to one repo.
3. Symphony is a scheduler/runner + tracker reader; ticket write business logic is performed by the tools injected into the worker and the workflow prompt.
4. A webhook push model does not fit this project's goals. Symphony pursues a polling architecture with no external exposure.
5. Keep the implementation as simple as possible.

## Goals

1. Support Linear as a first-class tracker while staying as close as possible to upstream Symphony's `tracker.kind: linear` / `tracker.project_slug` model.
2. Keep GitHub as the VCS. Linear owns only issue tracking; PRs/branches/merges are handled by the existing GitHub stack and the worker workflow.
3. Follow the single `OrchestratorProjectConfig.repository: RepositoryRef` field established by the single-repo ADR as-is. Linear issues have no repo concept, so the orchestrator instance's cwd repo is the target repo for all Linear issues.
4. Provide `linear_graphql`, issue env, runtime-managed Linear auth, and an optional `LINEAR_API_KEY` compatibility fallback so the worker can directly perform Linear state changes, workpad comment creation, PR link comments, and so on.
5. Do not put Linear write business logic into the orchestrator core.

## Non-Goals

- A Linear webhook-based push model. Webhooks are not merely out of first-phase scope — they are **out of spec given the current direction**.
- Linear OAuth multi-tenant authentication. The first-phase scope is personal API keys.
- An architecture where an orchestrator-side approval workflow extension performs Linear ticket writes on the worker's behalf.
- Advanced features such as Linear Cycles/Estimates/Triage inbox.
- Other trackers such as GitLab/Jira.
- A Linear ↔ GitHub bidirectional auto-sync daemon.
- Multi-repo fan-out. To operate multiple repos, run one orchestrator instance per repo.

## User Stories

| #    | Scenario                                                                                                                | Outcome                                                                                                                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| US-1 | An operator sets `tracker.kind: linear` and `tracker.project_slug` in `WORKFLOW.md` in the repo cwd and starts Symphony | The orchestrator polls Linear project issues and dispatches eligible issues to workers                                                  |
| US-2 | A worker starts a `Todo` Linear issue                                                                                   | The worker directly performs the `In Progress` transition and workpad comment creation via the injected `linear_graphql`/Linear tooling |
| US-3 | When the worker finishes its task, it creates a GitHub PR and leaves the PR URL in the Linear workpad/comment           | The PR link is left on the Linear issue and it moves to the handoff state defined in the workflow prompt                                |
| US-4 | A Linear issue changes to a terminal state such as `Done`, `Cancelled`, or `Duplicate`                                  | On the next polling/reconciliation tick, the active worker is stopped and the terminal cleanup policy is applied                        |
| US-5 | Multiple repos are operated on one machine                                                                              | Operated unix-style multiplexed with a per-repo `.runtime/` and separate process/port                                                   |

## Domain Mapping (Linear ↔ Symphony)

| Symphony concept  | GitHub Project V2             | Linear                                                      |
| ----------------- | ----------------------------- | ----------------------------------------------------------- |
| Tracker container | ProjectV2 (`projectId`)       | Linear Project (`project_slug` → Linear `Project.slugId`)   |
| Tracked item id   | issue node id                 | issue id (UUID)                                             |
| `identifier`      | `owner/repo#N`                | `ENG-123` (Linear issue identifier)                         |
| Workspace key     | sanitized identifier          | sanitized `ENG-123` (workspace key is the issue identifier) |
| `number`          | `N` (integer)                 | Linear's own number (`issue.number`)                        |
| State             | Project field "Status" option | Linear `WorkflowState.name`                                 |
| Priority          | Custom field mapping          | `issue.priority` (0–4 enum)                                 |
| Labels            | issue labels                  | `IssueLabel[]`                                              |
| BlockedBy         | dependency relations          | Linear inverse relation where `type=blocks`                 |
| URL               | GitHub issue URL              | Linear issue URL                                            |
| Repository        | The repo the issue belongs to | No repo concept in Linear → orchestrator instance cwd repo  |

### The key difference: Linear has no repo

A GitHub issue is inherently bound to a repo as `owner/repo#N`, but a Linear issue is not. Since the single-repo ADR, an orchestrator instance watches the one repo in its cwd, so the Linear adapter **automatically uses that instance's repo as the target repo**.

- **Default**: the instance's cwd repo is the routing target for all Linear issues.
- **Explicit override**: avoid if possible. Only when absolutely necessary, consider an escape hatch like `tracker.settings.repository = "owner/repo"`.
- **Narrowing the work scope on the Linear side**: the upstream baseline is `tracker.project_slug`. An additional label filter is merely a subset filter within a single-repo instance, not multi-repo routing.

> Decision: one orchestrator instance = one repo. The single-repo transition was performed for this decision. If multi-repo is needed, operate one instance per repo.

## Configuration Schema

As with upstream Symphony, use the repo-local `WORKFLOW.md` YAML front matter as the primary source of truth. Treat `.gh-symphony/config.json` as transition/legacy input only, and phase it out gradually. The Linear design does not take `.gh-symphony/config.json` compatibility as a design input. A read fallback during the migration period can be handled as a separate implementation issue.

```yaml
---
tracker:
  kind: linear
  # Optional; defaults to https://api.linear.app/graphql.
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: "symphony-0c79b11b75ea"
  active_states:
    - Todo
    - In Progress
    - Rework
    - Merging
  terminal_states:
    - Closed
    - Cancelled
    - Canceled
    - Duplicate
    - Done
polling:
  interval_ms: 5000
workspace:
  root: .runtime/symphony-workspaces
agent:
  max_concurrent_agents: 10
  max_turns: 20
codex:
  command: codex app-server
---
```

Prompt body controls Linear state transitions, workpad comment policy, PR handoff, and validation gates.

`tracker.endpoint` is optional and defaults to `https://api.linear.app/graphql`. `tracker.api_key` follows the upstream `$ENV_VAR` reference shape; the runtime resolves it before configuring Linear tooling.

**Environment variables**:

- `LINEAR_API_KEY` (required) — Linear personal API key. Upstream canonical env var.
- `LINEAR_GRAPHQL_URL` (optional runtime override; default comes from `tracker.endpoint` or `https://api.linear.app/graphql`).

### Linear config naming and `teamId` decision

Linear user-facing workflow config is upstream-shaped and `project_slug`-only:

```yaml
tracker:
  kind: linear
  project_slug: "symphony-0c79b11b75ea"
```

`tracker.project_id`, `projectId`, and `teamId` must not be accepted as Linear config aliases. Existing `projectId` vocabulary in GitHub-Symphony is either GitHub Project V2-specific (`tracker.project_id`) or legacy/internal orchestration namespace. Linear implementation must not write/read `tracker.settings.projectId`; use adapter-specific normalization instead:

- `tracker.kind: linear` → require `tracker.project_slug`, set internal binding to the Linear project slug, and expose `settings.projectSlug` if an internal settings field is needed.
- `tracker.kind: github-project` → continue using GitHub Project V2 `tracker.project_id` / `settings.projectId`.

`teamId` was present in the earlier draft. Remove it from required configuration.

Rationale:

- Upstream Elixir config schema has `tracker.project_slug` and no `project_id`, `projectId`, or `teamId` field for Linear.
- Candidate polling is simpler and upstream-aligned when scoped by `tracker.project_slug` (`project.slugId`) plus state names.
- State transitions can resolve the target state id from the issue itself (`issue.team.states`) instead of trusting a configured team id.
- Comment create/update does not need team id.
- Optional assignee filtering can remain project-scoped by combining `project_slug` with viewer/assignee identity, matching the Elixir reference behavior.
- Team-wide orchestration without a Linear Project is not an MVP use case; operators should create/use a Linear Project for the repo.
- Config is simpler with only `tracker.project_slug` as the Linear project boundary.

If a future feature genuinely needs team-level scope, add `teamId` as optional derived/convenience metadata rather than making it a dispatch preflight requirement.

`tracker.kind` is the user-facing upstream enum. The TypeScript adapter registry should use the same string (`"linear"`) as the internal adapter key unless a future adapter layer requires an explicit mapping.

### Linear state names, not universal lifecycle phases

Do not introduce a universal lifecycle phase mapping for Linear. Linear `WorkflowState.name` values are workflow-local policy labels. Symphony only needs to know which state names are active candidates and which are terminal for reconciliation. Any richer lifecycle semantics belong in the `WORKFLOW.md` prompt/policy, not in the tracker adapter contract.

The `active_states` and `terminal_states` examples above are examples, not prescribed lifecycle phases. Different teams may use different Linear workflow names; the adapter must treat them as configured strings.

### Workspace key normalization

Use the Linear issue identifier (for example `ENG-123`) as the workspace key after deterministic sanitization:

1. Preserve uppercase ASCII letters, digits, and hyphens.
2. Trim surrounding whitespace and normalize to uppercase for matching Linear identifiers.
3. Reject identifiers that do not match `^[A-Z][A-Z0-9]*-\d+$` instead of inventing a fallback path.
4. Use the sanitized identifier directly as the workspace directory name under the configured workspace root.

Collision handling is scoped by the orchestrator instance. Since one instance maps to one repo and one runtime workspace root, `ENG-123` in repo A and `ENG-123` in repo B do not collide when each repo runs its own instance/root. If an operator deliberately points multiple instances at the same workspace root, that is an unsupported deployment shape unless the operator also namespaces the root per repo.

## OrchestratorTrackerAdapter Implementation

Implement the tracker adapter read contract and keep write operations out of orchestrator business logic.

### `listIssues(project, deps)` / candidate polling

- Linear GraphQL query filters by an `IssueFilter` containing `project: { slugId: { eq: <projectSlug> } }` and `state: { name: { in: <stateNames> } }`.
- Page size defaults to 50 and cursor pagination is required.
- Optional `assignedOnly` adds Linear GraphQL `assignee: { isMe: { eq: true } }` filtering at query time, matching the runtime input shape used by the GitHub tracker.
- Linear `isMe` resolves to the identity represented by the configured API key. Personal API keys therefore scope polling to issues assigned to that person; service-account keys scope polling to issues assigned to the service account. The adapter should not fail fast for service-account usage unless Linear exposes reliable token identity metadata in the read path.
- `repository` is injected from the orchestrator instance repo, not from Linear response.
- Normalize Linear response to `TrackedIssue`.

### `listIssuesByStates(project, states)`

- Linear supports server-side state filtering; use `state: { name: { in: $states } }`.
- Do not depend on GitHub Project V2 `projectItemsCache`. Linear can query the necessary states directly.

### `fetchIssueStatesByIds(project, ids)`

- Use `issues(filter: { id: { in: $ids } })` with GraphQL variable type `[ID!]`.
- This supports active-run reconciliation without full project fetch.

### `buildWorkerEnvironment(project, issue)`

Worker env should include enough non-secret context for direct Linear tooling:

```bash
LINEAR_GRAPHQL_URL=https://api.linear.app/graphql
LINEAR_ISSUE_ID=...
LINEAR_ISSUE_IDENTIFIER=ENG-123
SYMPHONY_TRACKER_KIND=linear
```

Do **not** require `LINEAR_TEAM_ID` for MVP. If included later, treat it as optional convenience metadata.

`LINEAR_API_KEY` may be injected into the worker process environment as an MVP compatibility fallback when the selected agent/tooling stack cannot call authenticated runtime tools directly. This is not the design center; prefer `linear_graphql` with runtime-managed auth.

### `reviveIssue(project, run)`

- Reconstruct minimal `TrackedIssue` from `run.issueId`, `run.issueIdentifier`, and `run.issueState`.
- Reinject repository from the single repo instance config/cwd.

## Worker Linear Tooling Boundary

This ADR adopts upstream’s tracker write boundary:

> Symphony is a scheduler/runner and tracker reader. Ticket writes (state transitions, comments, PR links) are typically performed by the coding agent using tools available in the workflow/runtime environment.

### Linear auth boundary

The canonical workflow config may reference `api_key: $LINEAR_API_KEY`, matching upstream. The orchestrator/runtime resolves that secret and uses it to configure Linear runtime tooling.

The preferred worker boundary is tool-mediated auth: worker sessions receive a `linear_graphql` tool and pass only GraphQL `query`/`variables`. The model should not need to inspect, echo, or scrape the raw Linear token.

For MVP compatibility, the runtime may also inject `LINEAR_API_KEY` into the worker process environment when required by the selected agent/tooling stack. Treat this as a bootstrap fallback, not the design center:

- do not persist the token in run state;
- do not include it in structured logs, prompts, workpad comments, or observability metadata;
- scrub it from child process diagnostics where possible;
- prefer `linear_graphql` over shell-level Linear API calls;
- allow disabling raw env exposure once the runtime tool bridge can execute authenticated GraphQL directly.

`LINEAR_GRAPHQL_URL` is optional and defaults to `tracker.endpoint` or `https://api.linear.app/graphql`.

### `linear_graphql` tool contract

Therefore:

1. Include a `linear_graphql` client-side tool for worker sessions.
2. Reuse active Symphony workflow/runtime Linear endpoint and auth; the worker should not scrape tokens from disk.
3. Accept input shape:

   ```json
   {
     "query": "single GraphQL query or mutation document",
     "variables": {}
   }
   ```

4. Reject documents containing multiple GraphQL operations, matching upstream spec. TypeScript implementation should enforce this with a GraphQL parser rather than parser-lite string inspection. If a document contains exactly one operation, `operationName` is optional; if the parser detects more than one operation definition, reject before sending the request to Linear.
5. Return structured success/error payloads, preserving GraphQL errors for debugging.
6. Prefer workflow prompt + repo skills to define state transitions/comment policy.
7. Do not add orchestrator-side first-class APIs for Linear comments/state updates unless a future upstream spec requires it.

## Rejected: `extension-linear-workflow` as primary write path

The earlier draft proposed `extension-linear-workflow` implementing `ApprovalWorkflowClient` and delegating PR operations to GitHub. This is now rejected as the primary design because it moves ticket write business logic into the orchestrator/extension layer.

Worker-driven writes are simpler and closer to upstream:

- worker receives `linear_graphql` / Linear CLI/tool access;
- `WORKFLOW.md` defines the comment, workpad, state, and handoff policy;
- orchestrator remains scheduler/runner + reader;
- Linear comments and PR links are resolved by the worker, not by a hybrid approval client.

A thin helper package or skill may still exist for ergonomics, but it must be worker tooling, not orchestrator coordination policy.

## CLI Changes

- `gh-symphony repo init/start` remain cwd/repo based.
- `WORKFLOW.md` is the canonical config/prompt file.
- `gh-symphony workflow preview ENG-123` may recognize Linear identifiers (`^[A-Z]+-\d+$`) and fetch one issue through the active tracker adapter.
- `repo init` should validate that `LINEAR_API_KEY` resolves when `tracker.kind: linear`, and that `tracker.project_slug` is present.
- Do not add webhook setup commands for Linear.

## Wiring

`packages/orchestrator/src/tracker-adapters.ts`:

```ts
const localAdapters = new Map<string, OrchestratorTrackerAdapter>([
  ["file", fileTrackerAdapter],
  ["linear", linearTrackerAdapter],
]);
```

Runtime/tool wiring should ensure Linear sessions expose `linear_graphql` when `tracker.kind: linear` and valid auth is configured.

## Observability

- Reuse existing event types where possible (`tracker.list`, `tracker.fetchByIds`, `worker.dispatched`).
- Include `tracker.adapter = "linear"`, `tracker.projectSlug`, issue identifier, and issue id in structured metadata.
- Do not include `teamId` in required observability metadata for MVP.
- Normalize Linear rate-limit headers into existing `rateLimits` fields where available.

## Test Strategy

| Level       | Scope                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------ |
| Unit        | `tracker-linear` GraphQL query construction, pagination, normalization, blocker derivation, priority mapping |
| Unit        | `linear_graphql` tool input validation and success/error payloads                                            |
| Conformance | Required tracker operations: candidate fetch, fetch by states, fetch states by ids                           |
| Integration | `tracker-adapters.ts` resolves `"linear"`; runtime exposes `linear_graphql` for Linear workflow              |
| CLI         | `repo init`/`workflow preview ENG-123` read `WORKFLOW.md` and validate Linear config                         |
| E2E         | Linear sandbox project: Todo → In Progress → Human Review/Done via worker tooling and workpad comment        |

## Rollout

0. **Phase 0 — Contract alignment**: ensure single-repo contract is in place and `WORKFLOW.md` is treated as the policy/config source.
1. **Phase 1 — Linear reader MVP**: implement `tracker-linear` with `project_slug`, server-side state filtering, pagination, and reconciliation queries.
2. **Phase 2 — Worker tool support**: provide `linear_graphql`, runtime-managed Linear auth, optional `LINEAR_API_KEY` compatibility fallback, and issue env so worker can update state/comments directly.
3. **Phase 3 — CLI/docs**: `repo init`, `workflow preview`, docs, and examples aligned to upstream `WORKFLOW.md` shape.
4. **Phase 4 — Hardening**: rate-limit observability, sandbox E2E, retry/reconciliation edge cases.

No webhook phase is planned.

## Decision Record (2026-05-13)

Steve provided the following decisions, with explicit instruction to challenge them against upstream spec and simplicity:

1. **WORKFLOW.md source of truth** — accepted. Upstream spec and Elixir implementation agree.
2. **`teamId` required?** — resolved: remove from required config. Use `project_slug` as the Linear project boundary; resolve team-specific state ids from the issue (`issue.team.states`) when needed.
3. **One instance = one repo** — accepted. This is the reason for the single-repo work.
4. **`{project}-{repo}` disambiguation** — resolved: avoid. Upstream Elixir uses sanitized issue identifiers as workspace paths, and one repo instance already scopes the repository.
5. **Workspace key** — accepted: use issue identifier/workspace key (e.g. `ENG-123` sanitized), not project×repo compound keys.
6. **Current lifecycle structure** — accepted only insofar as it stays within upstream Symphony lifecycle. Do not add a universal Linear lifecycle phase mapping; `active_states`/`terminal_states` are workflow-local policy strings.
7. **Linear writes by worker** — accepted. Worker gets CLI/tool access and changes Linear directly.
8. **Spec alignment over custom structure** — accepted. Follow upstream spec and Elixir implementation where possible.
9. **Avoid orchestrator write business logic** — accepted, same rationale as #7.
10. **Include worker Linear capability** — accepted: include `linear_graphql`, issue env, runtime-managed auth, and optional `LINEAR_API_KEY` compatibility fallback.
11. **Linear comments + `linear_graphql`; no webhook** — accepted. Some Phase 2 worker-tool pieces should move earlier because comments/workpad are central. Webhook is out of spec.
12. **Personal API key first** — accepted.
13. **No `projectItemsCache` dependency for Linear** — accepted. Linear can server-side filter states.
14. **Keep polling model** — accepted.
15. **Most single-repo groundwork already implemented** — accepted as implementation context, but code must be verified per PR because main still contains legacy `projectId` references in some paths.

## Implementation Constraints / Deferred Hardening

1. **GraphQL operation validation**: `linear_graphql` must reject multiple operations, matching upstream spec. TypeScript should enforce this with a GraphQL parser before sending requests to Linear.
2. **Token exposure**: Passing `LINEAR_API_KEY` to worker is acceptable only as an MVP compatibility fallback. The preferred/default boundary is the upstream pattern: `linear_graphql` executes with Symphony runtime auth and does not require the model to inspect raw token values.
3. **Current implementation drift**: `main` has single-repo runtime layout mostly in place, but many core/CLI types still carry legacy `projectId` vocabulary. Treat this as an implementation constraint, not a Linear design input. Linear work should not wait for a full `projectId` cleanup; it must instead add adapter-specific normalization boundaries so Linear never aliases `tracker.project_id`, never writes/reads `settings.projectId`, and stays `tracker.project_slug`-only.

## References

- upstream spec: <https://github.com/openai/symphony/blob/main/SPEC.md>
- upstream Elixir workflow example: <https://github.com/openai/symphony/blob/main/elixir/WORKFLOW.md>
- upstream Elixir Linear client/tooling:
  - <https://github.com/openai/symphony/blob/main/elixir/lib/symphony_elixir/linear/client.ex>
  - <https://github.com/openai/symphony/blob/main/elixir/lib/symphony_elixir/codex/dynamic_tool.ex>
  - <https://github.com/openai/symphony/blob/main/elixir/lib/symphony_elixir/linear/adapter.ex>
- local spec: `docs/symphony-spec.md`
- single-repo ADR: `docs/adr/2026-05-04_single-repo-orchestrator.md`
