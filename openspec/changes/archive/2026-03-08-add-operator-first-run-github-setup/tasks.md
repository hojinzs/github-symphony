## 1. Operator Authentication

- [x] 1.1 Add control-plane operator authentication configuration, session handling, and trusted-operator validation using GitHub OAuth.
- [x] 1.2 Gate setup, workspace creation, and issue creation routes on an authenticated operator session and preserve the intended return path through sign-in.
- [x] 1.3 Add backend and route tests for unauthenticated redirects, trusted-operator rejection, and post-login resume behavior.

## 2. First-Run Setup State

- [x] 2.1 Extend the persisted GitHub integration state to track personal-owner authorization readiness, authorized user identity, and encrypted token expiry metadata.
- [x] 2.2 Update the setup UI and setup-status APIs to surface the ordered prerequisites: operator sign-in, app bootstrap, installation, and personal-owner authorization.
- [x] 2.3 Add GitHub user-authorization start/callback flows for personal-account installations and persist or refresh the resulting user token material securely.

## 3. Workspace and Project Credential Flow

- [x] 3.1 Update workspace provisioning to require completed personal-owner authorization for user installs and to resolve project credentials dynamically between installation tokens and user access tokens.
- [x] 3.2 Update issue/project mutation and runtime GraphQL credential brokering so personal-account installs continue to work after workspace provisioning.
- [x] 3.3 Add validation and UX messaging that blocks workspace creation until the correct setup prerequisite is complete.

## 4. Verification and Recovery

- [x] 4.1 Add regression coverage for organization-install and personal-install flows, including personal-owner authorization expiry and recovery paths.
- [x] 4.2 Add integration coverage for first-run setup sequencing from sign-in through workspace creation.
- [x] 4.3 Update setup documentation and operator guidance for required GitHub OAuth configuration, callback URLs, and re-authorization steps.
