# GitHub Project adapter profile

This is the compact profile required by Symphony specification §11.2 for the
`github-project` tracker adapter. It describes the repository's current
Integration-layer behavior; it does not add provider semantics to core.

## Configuration and scope

| Item           | Contract                                                                                                                                                                                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracker.kind` | `github-project`                                                                                                                                                                                                                                                                                                                |
| Provider scope | `tracker.provider.project_id` selects one GitHub Project V2. `repository` is derived from each issue; the optional runtime repository filter and `--assigned-only` are adapter dispatchability rules.                                                                                                                           |
| Provider keys  | `project_id`, `endpoint`, `state_field`, `priority_field`, `priority`, `pickup_labels`, `active_states`, `terminal_states`, `blocker_check_states`, and `planning_states`. Unknown provider keys are preserved by core configuration parsing. Flat `tracker.*` keys are deprecated compatibility aliases.                       |
| Defaults       | Lifecycle defaults are `Status`, active `Todo`/`In Progress`, terminal `Done`, and no planning states. Unless explicitly configured, blocker checks use the first active state (`Todo` with these defaults). Priority is `null` unless the configured `priority` policy or deprecated `priority_field` resolves a value.        |
| Credentials    | `GITHUB_GRAPHQL_TOKEN` is the polling credential. `secretEnvironmentNames()` declares `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_TOKEN`, and `GITHUB_GRAPHQL_TOKEN`; these names are removed from agent-child inheritance.                                                                                                      |
| Validation     | Declared string keys must be non-empty; `endpoint` must be an HTTP(S) URL; state lists must contain non-empty strings; `priority` and `pickup_labels` must be objects. Missing `project_id` or `GITHUB_GRAPHQL_TOKEN` prevents adapter use. See the error table for the §11.4 target mapping and current unnormalized surfaces. |

Candidate polling excludes configured terminal states with the GitHub `query`
argument; it can therefore return non-terminal items outside `active_states`.
State and ID refreshes are unfiltered so terminal items remain reconcilable. The
adapter uses cursor pagination with a default page size of 25; a next-page
response without a cursor is an integrity failure. Each GraphQL request has a
30-second default timeout (or the configured positive `timeoutMs`). It records
GraphQL rate-limit metadata and applies the shared GitHub policy: it honors the
later of `Retry-After` and a known primary reset. If that required wait exceeds
60 seconds, the request is not retried and the rate-limit error is surfaced.

The [2026-07-19 GitHub API rate-limit audit](../reports/2026-07-19-github-api-rate-limit-audit.md)
records why the profile keeps the page size at 25 and measures query cost by
returned `rateLimit` data rather than guessing from page count.

## Normalized issue contract

| Field or condition            | GitHub Project mapping                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                          | GitHub Issue or Pull Request **node ID** (not the Project item ID).                                                                                                                                                                                                                                                                                                                      |
| `native_ref`                  | Opaque adapter data containing Project `itemId`, content type, source state, and linked-PR metadata. The Project item ID is used for Project mutations and never replaces `id`.                                                                                                                                                                                                          |
| State                         | The configured Project status field is used. An archived Project item becomes synthetic `Archived`; this is a GitHub-specific extension, not a core state.                                                                                                                                                                                                                               |
| Labels and priority           | Labels are trimmed, lowercased, deduplicated, and sorted. Priority is explicit Project-field or label policy output; unmapped/disabled values are `null`.                                                                                                                                                                                                                                |
| Timestamps                    | Issue and Project-item timestamps are parsed to canonical RFC 3339/ISO 8601; invalid or absent values become `null`. The newer item timestamp wins.                                                                                                                                                                                                                                      |
| `dispatchable`                | Starts `true`, then the adapter applies assignment, repository, fork-PR, pickup-label, and configured blocker rules. Ineligible items remain listed with `dispatchable: false` and an explainable `dispatchReason`.                                                                                                                                                                      |
| Malformed and optional fields | Candidate polling silently drops non-Issue/PR Project content. Items missing the configured state are skipped with a structured event and recorded in `skippedItems`; requested ID refreshes fail instead. Optional body, labels, assignee, timestamps, priority, and linked metadata normalize to `null`, empty collections, or documented defaults rather than leaking provider shape. |

## Native tool

The host-side [`github_graphql`](github.md) tool accepts one GraphQL query or
mutation plus optional variables/operation name. It is always advertised for
repository and PR operations, but its credential and opaque `native_ref` stay
in the host process. See the linked tool document for scope and safe-use rules.

## Error-category mapping

This table records the Symphony §11.4 target mapping required by §11.2. Today,
only `tracker_pagination` is emitted as a structured adapter `category`.
The other rows describe the intended normalized category; current failures are
surfaced as `GitHubTrackerHttpError`, `GitHubTrackerQueryError`, or
`WorkflowValidationError` and are not yet normalized.

| Provider-native failure                                | §11.4 target category    | Current adapter surface                                                     |
| ------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------- |
| Network/transport failure or timeout                   | `tracker_request`        | `GitHubTrackerHttpError`                                                    |
| Non-rate-limited HTTP status                           | `tracker_status`         | `GitHubTrackerHttpError`                                                    |
| Invalid JSON, GraphQL errors, or missing expected data | `tracker_response`       | `GitHubTrackerQueryError`                                                   |
| Missing cursor or incomplete cursor traversal          | `tracker_pagination`     | Structured `tracker_pagination`                                             |
| GitHub quota exhaustion or `Retry-After` response      | `tracker_rate_limited`   | `GitHubGraphQLRateLimitError` (core `TrackerRateLimitError`, no `category`) |
| Invalid Project/provider setting or configured shape   | `invalid_tracker_config` | `WorkflowValidationError`                                                   |
| No resolved GitHub credential                          | `missing_tracker_secret` | Adapter initialization/configure error                                      |
