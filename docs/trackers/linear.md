# Linear tracker tools

The Linear tracker adapter exposes `linear_graphql` to an agent runtime as a
host-side dynamic tool. The coding-agent child receives the schema and result
only; the adapter keeps `LINEAR_API_KEY` or `LINEAR_AUTHORIZATION` in the host
process.

## `linear_graphql`

| Property | Contract |
| --- | --- |
| Name | `linear_graphql` |
| Input | An object with required `query: string`; optional `variables: object` and `operationName: string`; no additional top-level properties. |
| Mutations | Permitted. A mutation must be intentionally scoped to the active Linear issue or its team. |
| Scope | The worker supplies the normalized active issue `{ id, identifier, nativeRef }` to the adapter. `nativeRef` remains host-internal and is never added to the GraphQL payload. The tool validates that a request has exactly one GraphQL operation, but it is an arbitrary Linear GraphQL transport: callers must constrain the operation and variables to the active issue/team; it does not infer or rewrite a target. |
| Result | The provider GraphQL response payload. |
| Errors | Empty or multi-operation documents, invalid GraphQL syntax, missing host authentication, HTTP failures, and GraphQL errors are returned to the runtime as structured tool failures. Unknown tool names are rejected. |
| Rate limits | Linear's GraphQL response is returned unchanged. No Symphony-side rate-limit scheduler is currently applied, so callers must avoid bursts and honor provider throttling responses. |

The tool is advertised only when the selected tracker adapter is Linear. It is
not an MCP subprocess and must not be recreated by the coding-agent child.

## Safe usage

Use one named operation and bind the active issue ID explicitly in variables.
Keep mutations narrow—for example, update the active issue state or create a
comment on that issue—and inspect the returned `success` flag and node ID. Do
not query or mutate unrelated teams, issues, or workspace resources.
