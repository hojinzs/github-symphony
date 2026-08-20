# ADR: GitHub Project V2 state filtering limitation and per-tick cache

- **Date**: 2026-03-19
- **Status**: Superseded by
  [`2026-08-01_github-project-v2-server-side-state-filtering.md`](./2026-08-01_github-project-v2-server-side-state-filtering.md)
- **Related Issues**: #59, #60, #61
- **Related Spec**: `docs/symphony-spec.md` Section 11.2

## Context

> **Superseded (2026-08-01):** 2026-07-19 live introspection and board
> verification confirmed that `ProjectV2.items` supports `query: String`.
> The successor ADR adopts server-side filtering while retaining a per-tick
> cache with a revised contract. **All assumptions, decisions, and consequences
> below are retained only as historical context and must not be used as the
> current adapter contract.**

The GitHub Project V2 GraphQL API does not provide query-time filtering by status field when listing project items.
Therefore, even when the orchestrator only needs a specific workflow state, it must fetch all project items and filter by state in code.

This constraint can cause duplicate fetches across the orchestrator's different tracker query paths.

- Startup cleanup calls `listIssuesByStates()` to find terminal-state issues
- Candidate listing in the same poll tick calls `listIssues()` to find dispatch candidates

Since `#60`, running issue reconciliation uses the `nodes()`-based `fetchIssueStatesByIds()`, so the cache sharing covered by this ADR is limited to the `listIssues()` family of calls that require a full-project fetch.

## Decision

Adopt the following principles.

1. `listIssuesByStates()` does not delegate the state filter to the GitHub API; it filters the full-project fetch result locally.
2. The orchestrator creates a `projectItemsCache` scoped to each poll tick and shares it across tracker calls within the same tick.
3. The cache scope is limited to a single tick so that a stale project item snapshot is not reused in the next tick.

## Consequences

- Startup cleanup and subsequent loop ticks use different cache instances, so after cleanup side effects a fresh project snapshot is read again.
- When `listIssues()` and `listIssuesByStates()` are both called within the same loop tick, they reuse a single full-project fetch result.
- When the tick boundary changes, the cache is discarded and the latest project state is read again.
- The GitHub Project V2 API's state filtering limitation is documented as an intended adapter constraint, not an implementation difference.
