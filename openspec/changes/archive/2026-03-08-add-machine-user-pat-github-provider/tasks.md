## 1. Provider Model and Persistence

- [x] 1.1 Simplify the persisted GitHub integration model to PAT-only encrypted metadata, fingerprint, actor identity, and validated owner fields.
- [x] 1.2 Remove GitHub App-specific load/save helpers and keep PAT-backed system configuration readable and writable.
- [x] 1.3 Keep PAT readiness and degraded-state classification aligned with PAT validation failures and missing metadata.

## 2. PAT-Only Setup Flow

- [x] 2.1 Add setup APIs to accept a machine-user PAT and intended organization owner, validate the required REST and GraphQL capabilities, and persist the validated PAT metadata.
- [x] 2.2 Update the setup UI to present machine-user PAT bootstrap as the only onboarding path with explicit organization-first guidance.
- [x] 2.3 Add setup validation and recovery messaging that routes all GitHub recovery back through PAT replacement.

## 3. PAT-Backed GitHub Operations

- [x] 3.1 Replace direct GitHub App assumptions in repository discovery with a PAT-backed broker.
- [x] 3.2 Update workspace provisioning and GitHub Project creation to use the PAT-backed broker and require organization-owned Projects.
- [x] 3.3 Update issue creation and runtime GitHub credential brokering to use the stored machine-user PAT.

## 4. Verification and Documentation

- [x] 4.1 Add regression coverage for PAT bootstrap success, PAT validation failure, and degraded PAT recovery.
- [x] 4.2 Add integration coverage for organization-first PAT setup from sign-in through workspace provisioning and issue creation.
- [x] 4.3 Update operator documentation and environment guidance for machine-user PAT setup, recommended organization ownership, and rotation/recovery steps.
