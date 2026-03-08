## 1. Runtime Model

- [ ] 1.1 Add environment-level runtime driver configuration and introduce a runtime-provider abstraction for workspace provisioning, status reconciliation, and teardown.
- [ ] 1.2 Generalize `SymphonyInstance` persistence from container-specific metadata to runtime-oriented metadata, including driver-aware identity and endpoint fields.

## 2. Runtime Providers

- [ ] 2.1 Refactor the existing Docker provisioning path behind the runtime-provider interface without changing current self-hosting behavior.
- [ ] 2.2 Implement a local host-process runtime provider that writes per-workspace runtime artifacts, starts a dedicated worker process, and supports driver-aware teardown and health reconciliation.
- [ ] 2.3 Update runtime broker URL and environment assembly so local workers can reach the control plane without Docker-specific host assumptions.

## 3. Control Plane Integration

- [ ] 3.1 Update workspace orchestration and API flows to provision runtimes through the configured driver while preserving the existing workspace creation UX.
- [ ] 3.2 Update dashboard and runtime status loading to use generic runtime metadata and report health across both Docker and local drivers.

## 4. Developer Experience And Validation

- [ ] 4.1 Update README, local-development docs, and environment examples to document the local runtime driver as the preferred low-Docker development path.
- [ ] 4.2 Add or update automated tests covering driver-aware provisioning, local runtime lifecycle management, and dashboard observability for both runtime modes.
