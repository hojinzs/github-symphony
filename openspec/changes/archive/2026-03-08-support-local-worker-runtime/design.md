## Context

The current control plane treats Docker as the only supported runtime driver for workspace workers. Workspace provisioning creates Docker containers directly, persisted runtime metadata is container-shaped, and local-development guidance still requires Docker even though the worker package itself can run as a host Node process.

This change is primarily about developer workflow. We want contributors to run PostgreSQL plus the control plane locally and let the control plane provision workspace workers as local host processes, while preserving the existing Docker-backed path for self-hosting and isolation-oriented deployments.

## Goals / Non-Goals

**Goals:**
- Allow the control plane to provision a workspace worker through either Docker or a local host-process driver.
- Preserve the existing workspace creation UX, credential brokering flow, and dashboard behavior regardless of runtime driver.
- Reduce Docker requirements for development without weakening the production/self-hosting path.
- Normalize runtime metadata so lifecycle operations and observability are no longer container-specific.

**Non-Goals:**
- Replacing Docker as the recommended self-hosting or production runtime model.
- Introducing a shared multi-workspace worker process.
- Changing the GitHub, approval workflow, or agent credential contracts beyond what is needed for driver-aware runtime startup.
- Making runtime driver selection a per-workspace operator-facing product choice in the first iteration.

## Decisions

### 1. Introduce a runtime-driver abstraction in the control plane

The control plane will provision workspaces through a runtime provider interface with at least two implementations: Docker-backed runtime and local host-process runtime.

Rationale: the current coupling lives in a small number of provisioning and lifecycle entry points, so an explicit abstraction keeps the operator workflow stable while allowing runtime behavior to branch cleanly.

Alternatives considered:
- Keep Docker-only provisioning and document manual local worker startup. Rejected because it keeps the control plane blind to the local runtime lifecycle and breaks the existing dashboard/runtime contract.
- Expose runtime driver selection in the workspace creation form. Rejected for now because the user need is environment-level developer ergonomics, not per-workspace runtime customization.

### 2. Select the runtime driver from environment-level configuration

The runtime driver will be configured for the control-plane environment, with local development able to choose `local` and self-hosting retaining `docker` as the default-compatible path.

Rationale: driver choice is operational context, not workspace business data. Keeping it out of the workspace creation UX minimizes scope and prevents mixed-mode operator confusion.

Alternatives considered:
- Infer the driver implicitly from Docker socket availability. Rejected because silent fallback makes provisioning behavior hard to reason about and easy to misconfigure.
- Persist driver choice only in memory. Rejected because runtime reconciliation and dashboard state need to know how an instance was launched.

### 3. Generalize persisted runtime metadata now instead of extending container-specific fields indefinitely

`SymphonyInstance` should represent a runtime instance rather than a container record. The persisted shape should include the runtime driver, a generic runtime identifier/name, host and port information for the state endpoint, workflow path, and optional local-process metadata such as PID.

Rationale: the codebase is still early enough that continuing to encode container-only semantics would create unnecessary churn in every dashboard, teardown, and recovery path that touches runtime state.

Alternatives considered:
- Keep `containerId` and `containerName` and add local-only side fields. Rejected because it would preserve misleading semantics and complicate every runtime codepath with asymmetric metadata handling.

### 4. Implement the local driver as one host process per workspace using the existing runtime artifacts contract

The local driver will still write `WORKFLOW.md`, hook scripts, and broker configuration per workspace, then spawn a dedicated worker process bound to that workspace runtime directory and state-server port.

Rationale: this preserves the product's one-workspace-one-runtime model, reuses the existing runtime artifact contract, and keeps the dashboard polling path unchanged except for metadata generalization.

Alternatives considered:
- Run one shared local worker for all workspaces. Rejected because it weakens isolation and diverges from the product model.
- Require developers to build a separate worker binary before every provisioning event. Rejected because the primary goal is fast local iteration.

### 5. Keep Docker as the isolation-oriented deployment path and scope the local driver to development ergonomics

Documentation, environment examples, and validation should clearly distinguish the two modes: local host-process runtime for development, Docker runtime for self-hosting and production-like setups.

Rationale: local processes reduce setup friction but do not provide the same isolation, cleanup guarantees, or host-boundary control as containers.

Alternatives considered:
- Promote the local driver as a production-equivalent runtime. Rejected because that would require a larger security and operations design than this change intends to solve.

## Risks / Trade-offs

- [Process lifecycle drift] -> Local PIDs can become stale after crashes or host restarts. Mitigation: persist driver-aware metadata, reconcile against process liveness on dashboard/status reads, and degrade cleanly when the runtime disappears.
- [Reduced isolation in development] -> Local processes share the host environment more directly than containers. Mitigation: scope the local driver to development guidance and preserve per-workspace directories, ports, and broker secrets.
- [Schema churn] -> Renaming container-specific fields affects tests and provisioning code in several places. Mitigation: make the metadata model generic in one pass instead of layering more container-only exceptions.
- [Configuration ambiguity] -> Operators may expect automatic fallback between drivers. Mitigation: require explicit runtime-driver configuration and document the intended defaults for each environment.
- [Port and cleanup conflicts] -> Multiple local runtimes may collide or outlive the control plane. Mitigation: keep port allocation centralized and provide driver-aware teardown/reconciliation paths.

## Migration Plan

1. Add the runtime-driver-aware metadata model and update the control-plane runtime orchestration interfaces.
2. Implement the local host-process runtime provider while keeping the existing Docker provider intact.
3. Update workspace provisioning, status reconciliation, teardown, and dashboard code to dispatch through the runtime provider instead of Docker-only helpers.
4. Update local-development, README, and environment templates to document local runtime mode and minimize Docker requirements for development.
5. Validate both drivers with automated tests, then keep Docker Compose and self-hosting behavior unchanged apart from the generalized runtime metadata.

Rollback strategy: switch the configured runtime driver back to `docker`, disable or ignore the local provider path, and retain the generic metadata model. Because this change is additive to runtime selection rather than changing GitHub or workspace identity, rollback is primarily application-level rather than data-destructive.

## Open Questions

- Should local development default to the `local` driver automatically in checked-in `.env.example` files, or should the default remain `docker` with docs steering contributors to opt in?
- Do we want to persist only a PID for local runtimes, or also persist the exact launch command for easier operator diagnostics during development?
