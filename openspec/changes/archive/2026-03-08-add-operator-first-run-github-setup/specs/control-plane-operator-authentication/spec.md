## ADDED Requirements

### Requirement: Control plane SHALL require authenticated operator access for privileged workflows
The system SHALL require a trusted operator to complete GitHub-based sign-in before accessing first-run setup, workspace provisioning, or issue creation flows, and SHALL preserve the intended destination so the operator can continue after authentication.

#### Scenario: Unauthenticated operator opens workspace creation
- **WHEN** a browser session without a valid operator session requests the setup, workspace creation, or issue creation routes
- **THEN** the control plane redirects the browser to the operator sign-in flow
- **THEN** it records the originally requested path so the operator returns to that path after successful sign-in

#### Scenario: Authenticated operator resumes intended flow
- **WHEN** a trusted operator completes GitHub sign-in successfully
- **THEN** the control plane establishes an operator session for subsequent privileged requests
- **THEN** it redirects the operator back to the previously requested setup or provisioning route

### Requirement: Control plane SHALL reject non-operator identities from privileged workflows
The system SHALL validate the signed-in GitHub identity against the configured trusted-operator policy before allowing setup or provisioning operations.

#### Scenario: Signed-in GitHub user is not trusted
- **WHEN** a GitHub-authenticated user who does not satisfy the trusted-operator policy requests setup or provisioning access
- **THEN** the control plane denies access to privileged control-plane workflows
- **THEN** it displays an actionable authorization error instead of exposing setup or workspace forms
