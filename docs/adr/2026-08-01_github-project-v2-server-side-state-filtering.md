# ADR: GitHub Project V2 server-side state filtering and the per-tick cache contract

- **Date**: 2026-08-01
- **Status**: Accepted
- **Related Issues**: #475
- **Related PRs**: #500, #515 (runtime implementation and contract correction)
- **Supersedes**:
  [`2026-03-19_github-project-v2-state-filtering-cache.md`](./2026-03-19_github-project-v2-state-filtering-cache.md)
- **Related Analysis**:
  [`docs/reports/2026-07-19-github-api-rate-limit-audit.md`](../reports/2026-07-19-github-api-rate-limit-audit.md)
  §2 R1.5
- **Related Spec**: `docs/symphony-spec.md` §8.1, §8.6, §11.1

## Context

The 2026-03-19 ADR made the following two decisions together, under the
premise that the GitHub Project V2 GraphQL API cannot filter project items
by state at query time.

1. `listIssuesByStates()` fetches all project items and then filters by
   state locally.
2. A shared `projectItemsCache` reduces duplicate full fetches within the
   same poll tick.

Live schema introspection on 2026-07-19 confirmed that `ProjectV2.items` has
a `query: String` argument, and the following expressions worked on a real
board.

- `status:Ready`
- `status:Ready,"In progress"`
- `-status:Done`
- `is:open`, `is:issue`

Therefore the premise that "server-side filtering is impossible" is no
longer valid. On a board with accumulated completed states, paginating
through every item on each poll creates unnecessary GraphQL requests.

However, a positive filter such as `status:NoSuchState` returns an empty
result rather than an error. If a state option is renamed, a legitimate
zero-result cannot be distinguished from configuration drift, and dispatch
can silently stall. In addition, candidate listing and startup terminal
cleanup need different state sets, so the same filter snapshot cannot always
be shared between them.

## Affected Symphony Layers

| Layer         | Impact   | Description                                                                         |
| ------------- | -------- | ----------------------------------------------------------------------------------- |
| Policy        | Yes      | Establishes the principle of preferring safe negative filters for candidate reads.  |
| Integration   | Yes      | Defines the GitHub Project V2 adapter's `items(query:)` and cache identity.         |
| Configuration | No       | Uses the existing workflow lifecycle config as input; adds no new configuration.    |
| Coordination  | No       | Does not change poll, cleanup, or reconciliation ordering or dispatch decisions.    |
| Execution     | No       | Does not change the worker lifecycle or workspace execution contract.               |
| Observability | Indirect | Observes the filter query and before/after item counts via existing tracker events. |

This decision is a repository-local implementation choice confined to the
GitHub tracker. The upstream Symphony spec's candidate fetch, terminal-state
fetch, and normalized output contracts are unchanged.

## Decision

### 1. Adopt server-side filtering for candidate listing

The candidate snapshot in `listIssues()` excludes terminal states on the
server via `ProjectV2.items(query:)`. The existing content type, assignee,
and repository filters, plus the final lifecycle decision, continue to apply
to the returned items. The server filter is a pre-filter that reduces
transfer volume and page count; it is not the sole arbiter of dispatch
eligibility.

Since the state qualifier in the current GitHub query syntax is `status:`,
the server filter is applied only when the workflow's `stateFieldName` is
`Status`, compared case-insensitively. For custom state fields, we do not
build an unvalidated query and instead safely fall back to an unfiltered
fetch. No query is generated when the terminal state set is empty either.

### 2. State expressions default to negative filters

Expressions are built in the following form.

```text
-status:Done,"Won't do"
```

The principles are:

- Exclude only the workflow's terminal states.
- Quote values containing whitespace or special characters and escape `\`
  and `"`.
- Trim state names and deduplicate them case-sensitively.
- If the same state appears in both active and terminal sets, fail loud
  before sending the query.
- If a terminal state is renamed so the filter no longer matches, fail in
  the direction of fetching more items. The subsequent local lifecycle
  decision defends dispatch.

The positive allowlist `status:Ready,"In progress"` is not used as the
default strategy, because an option rename or a nonexistent state becomes an
empty result without an error and can halt all dispatch. If positive
filtering becomes necessary in the future, a separate decision is required
that first queries the Project field options to validate the names and
fails loud on a mismatch.

### 3. Keep `projectItemsCache` as a per-tick snapshot cache

The cache lifetime remains a single poll tick, per the existing decision. A
new cache is created for the next tick so a stale project snapshot is never
reused. Startup cleanup and subsequent loop ticks also use different caches.

A cache entry means not "all Project items" but a **snapshot produced with
the same server filter mode and normalization inputs**. Therefore the key
must include at minimum the inputs that distinguish the following result
dimensions.

- The Project, GraphQL endpoint, and authentication principal
- The workflow lifecycle that determines the server-side state filter
- Whether the normalized terminal-state server filter is active (identical
  when the query is `null`)
- Repository and assignee scope
- Priority normalization settings
- Adapter inputs that must distinguish fetch results/behavior, such as
  timeouts

The filtered candidate snapshot and the unfiltered state-lookup snapshot are
distinct cache entries. Calls that differ in query or normalization
dimensions do not share an entry. Within the same tick, only calls whose
keys are fully identical reuse the in-flight promise and result.

### 4. `listIssuesByStates()` keeps the full fetch and local filter

The principle of `listIssuesByStates(project, states)` remains valid. This
operation must find the requested terminal states themselves, as in upstream
spec §8.6's startup terminal workspace cleanup. Reusing the candidate
`-status:<terminal>` snapshot would break correctness because the needed
items are already excluded.

This path keeps the workflow lifecycle as a normalization input but disables
only the terminal-state server filter, fetching an unfiltered snapshot. It
then locally filters the requested state names with trimmed,
case-insensitive comparison. The reasons for not turning arbitrary requested
states into a positive query are:

- Avoid the silent failure where a nonexistent or renamed state succeeds
  with an empty result.
- The adapter operation handles the arbitrary requested state set exactly.
- The conservative correctness of startup cleanup takes precedence over
  candidate read cost optimization.

Accordingly, the 2026-03-19 ADR's consequence statement that `listIssues()`
and `listIssuesByStates()` in the same tick always share a single fetch is
retired. When candidate filtering is active, the two operations deliberately
use the filtered and unfiltered entries respectively.

## Consequences

### Positive

- Even as terminal items such as Done accumulate, the candidate fetch page
  count does not grow linearly with total board size.
- Negative filters include new active/wait states by default, so they fail
  open on state additions.
- The per-tick cache continues to eliminate duplicates and concurrent
  fetches of the same query.
- Startup cleanup keeps its existing semantics without missing terminal
  items.

### Negative

- Even within a single tick, candidate and arbitrary-state reads may require
  separate GraphQL fetches.
- GitHub's query parser and the `status:` qualifier are an external API
  contract, so schema and real-board behavior must be regression-verified.
- An incorrect negative state name weakens the cost optimization but may not
  surface as an error. The local lifecycle decision preserves safety, but
  observability checks are needed.

### Neutral

- The `nodes(ids:)`-based active-run reconciliation in
  `fetchIssueStatesByIds()` is not subject to the project item candidate
  cache and is unchanged by this decision.
- This ADR documents the runtime behavior of #500 and the explicit state
  lookup correction of #515. It requires no new configuration changes.

## Validation

Maintain the following contracts as TCs.

1. With a `Status` lifecycle, a negative query with quoted terminal states
   is passed to `ProjectV2.items(query:)`.
2. With a custom state field or no terminal states, fall back to an
   unfiltered fetch.
3. If active/terminal states overlap, fail before the GraphQL call.
4. The same query key shares the per-tick cache, and filtered/unfiltered
   lifecycles do not share a cache key.
5. `listIssuesByStates()` locally filters the requested states from a full
   snapshot without a server filter.

These contracts are verified by the Project item filtering and shared cache
TCs in `packages/tracker-github/src/tracker-github.test.ts`.
