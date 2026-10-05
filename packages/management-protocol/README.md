# Management protocol

Private, dependency-free transport contracts for the repository-local management
extension approved in [the design](../../docs/designs/2026-10-04-control-plane-management-agents-design.md).
This package belongs to the Configuration and Integration layers. It does not
change the upstream Symphony scheduler or the existing per-project control plane.

`src/constants.ts` defines v1 versions, diagnostics and capacity/retention limits.
`src/contracts.ts` defines enrollment, session, inventory, lifecycle claim/result,
and bounded read contracts and the `AgentControlPlaneClient` consumer interface.
Global UUIDs stay separate from local folder-derived project IDs and local run IDs.
Receipt times, session fences, aggregate inventory limits and durable lifecycle
semantics must be enforced by the future service/agent implementations.

This initial typed boundary is not a running fleet service. Runtime validators
and executable wire fixtures are delivered in the next C01 implementation slice.
No new CLI commands or configuration are available from this package.

Run `pnpm --filter @gh-symphony/management-protocol test` and
`pnpm --filter @gh-symphony/management-protocol typecheck`.
