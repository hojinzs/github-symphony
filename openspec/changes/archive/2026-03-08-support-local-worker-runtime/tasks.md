## 1. Runtime Model

- [x] 1.1 Add environment-level runtime driver configuration and introduce a runtime-provider abstraction for workspace provisioning, status reconciliation, and teardown.
- [x] 1.2 Generalize `SymphonyInstance` persistence from container-specific metadata to runtime-oriented metadata, including driver-aware identity and endpoint fields.

## 2. Runtime Providers

- [x] 2.1 Refactor the existing Docker provisioning path behind the runtime-provider interface without changing current self-hosting behavior.
- [x] 2.2 Implement a local host-process runtime provider that writes per-workspace runtime artifacts, starts a dedicated worker process, and supports driver-aware teardown and health reconciliation.
- [x] 2.3 Update runtime broker URL and environment assembly so local workers can reach the control plane without Docker-specific host assumptions.

## 3. Control Plane Integration

- [x] 3.1 Update workspace orchestration and API flows to provision runtimes through the configured driver while preserving the existing workspace creation UX.
- [x] 3.2 Update dashboard and runtime status loading to use generic runtime metadata and report health across both Docker and local drivers.

## 4. Developer Experience And Validation

- [x] 4.1 Update README, local-development docs, and environment examples to document the local runtime driver as the preferred low-Docker development path.
- [x] 4.2 Add or update automated tests covering driver-aware provisioning, local runtime lifecycle management, and dashboard observability for both runtime modes.
