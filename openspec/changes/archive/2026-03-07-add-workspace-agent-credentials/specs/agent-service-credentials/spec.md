## ADDED Requirements

### Requirement: The control plane SHALL register and protect agent service credentials
The system SHALL allow a trusted operator to create and manage agent service credentials for runtime execution, SHALL encrypt secret values at rest, and SHALL never return stored secret plaintext through the control-plane UI after initial submission.

#### Scenario: Operator registers a platform-usable agent credential
- **WHEN** the operator submits a valid agent service credential with a supported provider type and label
- **THEN** the control plane validates the credential before marking it ready for runtime use
- **THEN** the control plane stores only encrypted secret material, metadata, and a fingerprint suitable for audit and duplicate detection

#### Scenario: Operator attempts to save an invalid credential
- **WHEN** credential validation fails during create or rotate
- **THEN** the control plane rejects the update or marks the credential degraded with an actionable error
- **THEN** the invalid secret is not made available for workspace binding or runtime execution

### Requirement: The control plane SHALL broker agent runtime credentials per workspace
The system SHALL expose an authenticated runtime broker path that resolves the effective agent credential for a workspace and returns only the environment contract needed to start agent execution for that workspace.

#### Scenario: Workspace inherits the platform default credential
- **WHEN** an authenticated worker runtime requests agent credentials for a workspace configured to use the platform default
- **THEN** the broker resolves the current default ready credential
- **THEN** the broker returns the environment payload required to launch the agent for that workspace without exposing unrelated credentials

#### Scenario: Workspace uses a workspace-specific override credential
- **WHEN** an authenticated worker runtime requests agent credentials for a workspace bound to its own override credential
- **THEN** the broker resolves that specific ready credential instead of the platform default
- **THEN** the broker returns the environment payload required to launch the agent for that workspace

### Requirement: The control plane SHALL support agent credential rotation and recovery
The system SHALL let operators rotate or replace an existing agent service credential, SHALL ensure subsequent runs use the new ready credential, and SHALL block new runtime starts when no valid effective credential is available for a workspace.

#### Scenario: Operator rotates the platform default credential
- **WHEN** the operator replaces the secret material for the credential used as the platform default and validation succeeds
- **THEN** the control plane preserves the default binding and marks future workspace runs to use the rotated credential
- **THEN** previously disclosed secret values are not shown again in the UI

#### Scenario: Effective credential is missing or degraded
- **WHEN** a workspace's effective agent credential is deleted, revoked, or degraded
- **THEN** the control plane prevents new runs for that workspace from starting
- **THEN** the operator is shown that credential recovery or reassignment is required
