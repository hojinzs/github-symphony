## Why

Local development currently assumes Docker access even when an operator only wants to run the control plane and worker directly on the host. That raises setup friction, makes iteration slower, and turns the runtime model into a blocker for contributors who only need a single-machine development loop.

## What Changes

- Add a development-friendly local runtime mode that allows the control plane to provision and manage a workspace worker as a host process instead of requiring a Docker container.
- Keep the existing Docker-based runtime path for self-hosting and production-style isolation so operators can still choose container-backed execution where it makes sense.
- Generalize runtime metadata, lifecycle management, and status polling so the control plane can manage either runtime driver without changing the operator workflow for creating workspaces.
- Update local-development guidance and environment contracts so developers can bootstrap PostgreSQL plus the control plane locally without also running Docker for worker execution.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `isolated-symphony-runtime`: runtime provisioning must support a local host-process driver in addition to the existing container-backed driver while preserving per-workspace isolation and credential brokering.
- `workspace-control-plane`: workspace provisioning and dashboard behavior must support runtime-driver-aware lifecycle management and observability without assuming Docker-only metadata.

## Impact

- Affects runtime provisioning, teardown, and status reconciliation in the control plane.
- Changes persisted runtime metadata so it can describe both local-process and Docker-backed workers.
- Updates local development documentation, environment defaults, and workspace bootstrap expectations.
- Preserves Docker Compose and self-hosting flows while reducing Docker requirements for day-to-day development.
