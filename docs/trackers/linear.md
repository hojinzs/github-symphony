# Linear adapter profile and tools

This compact profile required by Symphony specification §11.2 describes the
current `linear` adapter before documenting its native tool.

## Configuration and scope

| Item           | Contract                                                                                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracker.kind` | `linear`                                                                                                                                                                                                                                        |
| Provider scope | `tracker.provider.project_slug` selects the Linear project; the adapter polls its issues by workflow state. Team IDs and board IDs are not configuration substitutes.                                                                           |
| Provider keys  | Required `project_slug`; optional `endpoint`, environment-reference `api_key`, and `pickup_labels` (`include`/`exclude`). `project_id`, `projectId`, `teamId`, and `team_id` are rejected. Unknown provider keys are preserved by core parsing. |
| Defaults       | Endpoint defaults to `https://api.linear.app/graphql`; lifecycle defaults are `Status`, active `Todo`/`In Progress`, terminal `Done`, blocker checks in `Todo`, and no planning states.                                                         |
| Credentials    | `api_key`, if given, must be `$NAME`, `env:NAME`, or `${NAME}`; otherwise polling uses `LINEAR_API_KEY`. `secretEnvironmentNames()` declares `LINEAR_API_KEY` and `LINEAR_AUTHORIZATION`, which stay out of agent-child inheritance.            |
| Validation     | `project_slug` is required; optional strings must be non-empty; label rules must be string lists. These failures map to `invalid_tracker_config`; unavailable credentials map to `missing_tracker_secret`.                                      |

The adapter uses cursor pagination with a default page size of 50, a default
maximum of 100 pages (capped at 1,000), and a 10-second per-page timeout
(capped at 60 seconds). Missing cursors and page-limit exhaustion are
pagination-integrity failures. Linear rate-limit headers are preserved as
tracker metadata, including `Retry-After`; callers must avoid bursts and honor
provider throttling because the adapter does not impose a separate scheduler.

## Normalized issue contract

| Field or condition                  | Linear mapping                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` and `native_ref`               | `id` is the Linear issue ID. `native_ref` contains that `itemId` and the configured `projectSlug`.                                                                                                                                                                                                                                                                        |
| State, labels, priority, timestamps | State is the Linear workflow-state name. Labels are trimmed, lowercased, and deduplicated. Priority `0` (No priority) becomes `null`; other Linear values are retained. Timestamps parse to canonical RFC 3339/ISO 8601 or `null`.                                                                                                                                        |
| `dispatchable`                      | Candidate polling includes unassigned issues. With `--assigned-only`, only the authenticated viewer's assigned issues are dispatchable; configured non-terminal blockers also make an item non-dispatchable with a reason. `pickup_labels` instead filters label-ineligible candidates from the list (a documented repository divergence from GitHub's retained records). |
| Malformed and optional fields       | Candidate-state listing may omit malformed records with a diagnostic; requested ID refresh fails on malformed required data. Optional labels, assignee, timestamps, priority, and relations normalize to empty collections or `null`.                                                                                                                                     |

## Error-category mapping

| Provider-native failure                         | Adapter category         |
| ----------------------------------------------- | ------------------------ |
| Network failure or page timeout                 | `tracker_request`        |
| Non-rate-limited HTTP status                    | `tracker_status`         |
| Invalid JSON, GraphQL errors, or absent data    | `tracker_response`       |
| Missing cursor or maximum-page truncation       | `tracker_pagination`     |
| Linear throttle / `Retry-After` response        | `tracker_rate_limited`   |
| Invalid provider keys or unsupported scope keys | `invalid_tracker_config` |
| No resolved Linear credential                   | `missing_tracker_secret` |

## Native tool

The Linear tracker adapter exposes `linear_graphql` to an agent runtime as a
host-side dynamic tool. The coding-agent child receives the schema and result
only; the adapter keeps `LINEAR_API_KEY` or `LINEAR_AUTHORIZATION` in the host
process.

## `linear_graphql`

| Property    | Contract                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name        | `linear_graphql`                                                                                                                                                                                                                                                                                                                                                                                                       |
| Input       | An object with required `query: string`; optional `variables: object` and `operationName: string`; no additional top-level properties.                                                                                                                                                                                                                                                                                 |
| Mutations   | Permitted. A mutation must be intentionally scoped to the active Linear issue or its team.                                                                                                                                                                                                                                                                                                                             |
| Scope       | The worker supplies the normalized active issue `{ id, identifier, nativeRef }` to the adapter. `nativeRef` remains host-internal and is never added to the GraphQL payload. The tool validates that a request has exactly one GraphQL operation, but it is an arbitrary Linear GraphQL transport: callers must constrain the operation and variables to the active issue/team; it does not infer or rewrite a target. |
| Result      | The provider GraphQL response payload.                                                                                                                                                                                                                                                                                                                                                                                 |
| Errors      | Empty or multi-operation documents, invalid GraphQL syntax, missing host authentication, HTTP failures, and GraphQL errors are returned to the runtime as structured tool failures. Unknown tool names are rejected.                                                                                                                                                                                                   |
| Rate limits | Linear's GraphQL response is returned unchanged. No Symphony-side rate-limit scheduler is currently applied, so callers must avoid bursts and honor provider throttling responses.                                                                                                                                                                                                                                     |

The tool is advertised only when the selected tracker adapter is Linear. It is
not an MCP subprocess and must not be recreated by the coding-agent child.

## Safe usage

Use one named operation and bind the active issue ID explicitly in variables.
Keep mutations narrow—for example, update the active issue state or create a
comment on that issue—and inspect the returned `success` flag and node ID. Do
not query or mutate unrelated teams, issues, or workspace resources.
