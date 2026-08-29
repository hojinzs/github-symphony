# GitHub tracker tools

The GitHub Project tracker adapter exposes `github_graphql` to an agent runtime
as a host-side dynamic tool. The coding-agent child receives the schema and
the result only; the adapter uses the host's GitHub credential or token broker.

## `github_graphql`

| Property | Contract |
| --- | --- |
| Name | `github_graphql` |
| Input | An object with required `query: string`; optional `variables: object` and `operationName: string`; no additional top-level properties. |
| Mutations | Permitted. A mutation must be intentionally scoped to the active issue or its repository. |
| Scope | The worker supplies the normalized active issue `{ id, identifier, nativeRef }` to the adapter. `nativeRef` remains host-internal and is never sent as an extra GraphQL payload field. The tool is an arbitrary GitHub GraphQL transport, so callers must constrain their document and variables to that active issue/repository; it does not infer or rewrite a query's target. |
| Result | The provider GraphQL payload. For queries, Symphony adds the GitHub `rateLimit` selection when absent and may return normalized rate-limit metadata with the payload. |
| Errors | Invalid tool arguments, missing host authentication, HTTP failures, and GraphQL errors are returned to the runtime as structured tool failures. Unknown tool names are rejected. |
| Rate limits | GitHub GraphQL rate-limit headers and the GraphQL `rateLimit` field are measured by the host and applied to the shared GitHub rate-limit policy; callers should keep queries small and respect retry guidance. |

The tool is advertised only when the selected tracker adapter is GitHub. It is
not an MCP subprocess and must not be recreated by the coding-agent child.

## Safe usage

Use a named operation and pass the active issue/repository identifiers as
variables. Keep mutations narrow—for example, update the active issue's
project item or create a comment on that issue—and verify the returned node
identifier before performing a follow-up mutation. Do not use this tool to
enumerate or modify unrelated repositories, organizations, or projects.
