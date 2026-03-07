## Context

The current control plane is intentionally simple: workspace and issue APIs expect a user-supplied GitHub token on each request, the UI asks for that token directly, and self-hosting documentation assumes GitHub App metadata or a pre-minted app token is supplied through `.env`. That model works for an MVP, but it does not satisfy the desired first-run operator experience where a new control-plane instance can bootstrap its own GitHub integration by checking the config database, guiding the operator through GitHub login and app installation, and immediately enabling project setup without editing environment variables.

This change is cross-cutting. It touches Prisma data modeling, startup routing, the control-plane UI, GitHub OAuth and App flows, runtime credential issuance, and failure recovery for revoked integrations. The product is still a trusted-operator self-hosted deployment, so the design can optimize for a single system-level GitHub integration rather than per-user app ownership.

## Goals / Non-Goals

**Goals:**
- Detect whether the control plane has a complete GitHub integration configuration and block provisioning flows until setup is complete.
- Allow the operator to create and install the GitHub App from the UI by using GitHub's manifest and installation authorization flows.
- Persist the app metadata needed for future GitHub API calls in the config database instead of requiring `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, or `GITHUB_APP_TOKEN` in `.env`.
- Replace long-lived static GitHub tokens with on-demand installation token issuance for control-plane and runtime GitHub operations.
- Surface actionable recovery states for incomplete setup, expired bootstrap sessions, revoked installations, and token refresh failures.

**Non-Goals:**
- Adding a full multi-user authentication and authorization system to the control plane.
- Supporting multiple GitHub App configurations per tenant or per workspace in this change.
- Introducing webhooks or event-driven synchronization as a requirement for the MVP bootstrap flow.
- Eliminating all environment-based secret management; a non-GitHub application secret for encrypting stored credentials may still be required.

## Decisions

### 1. Add a singleton system GitHub integration record in the control-plane database

The control plane will store a single system-level GitHub integration record that tracks setup state and app metadata. The record will include bootstrap state, GitHub App identifiers, installation identifiers, target owner metadata, and encrypted secret material such as the app private key and client secret. The state model will distinguish at least `unconfigured`, `pending`, `ready`, and `degraded` so startup routing and recovery can be deterministic.

Rationale: the product is currently a trusted-operator single-instance deployment, so a singleton configuration model matches the deployment shape and keeps first-run checks simple. The main alternative was keeping GitHub configuration purely in environment variables, but that cannot support the requested self-serve first-run bootstrap and does not allow the product to recover or report setup state through the UI.

### 2. Use GitHub App manifest flow plus installation authorization for first-run setup

The setup flow will start from a control-plane page such as `/setup/github-app`. The server will generate a manifest payload, a state token, and a short-lived bootstrap attempt record, then redirect the operator to GitHub's app creation flow. After GitHub returns the manifest conversion code, the control plane will exchange it for the created app's credentials, persist the resulting metadata, and redirect the operator to the GitHub App installation step. Once installation is complete, the control plane will verify the selected installation and mark the singleton configuration as `ready`.

Rationale: the manifest flow is the only GitHub-supported path that removes the need to pre-create the app and manually copy client credentials into `.env`. The alternative was requiring a manual "create app in GitHub settings, then paste values into the control plane" path, but that preserves the exact operator burden this change is intended to remove.

### 3. Move from request-scoped PAT input to a system credential broker

After bootstrap, workspace creation, issue creation, GitHub Project scaffolding, and other control-plane GitHub calls will obtain short-lived installation tokens from a central credential broker service inside the control plane. The steady-state path will use the stored app metadata plus installation ID to mint installation tokens on demand. If GitHub login is needed during bootstrap to discover or verify the installing account, that user-scoped token will be treated as transient setup state rather than the normal application credential model.

Rationale: installation tokens expire quickly and are intended to be minted from app credentials, not stored as a durable system secret. The alternative was persisting a long-lived `GITHUB_APP_TOKEN` or continuing to accept per-request PATs, but both approaches make the operator responsible for token lifecycle and contradict the desired "bootstrap once, then use the product" flow.

### 4. Keep the control plane in trusted-operator mode after bootstrap

This change will not add a full end-user auth system. Instead, once the instance is configured, the local control-plane UI will operate in trusted-operator mode and no longer ask for a GitHub token on workspace or issue forms. API routes that currently expect bearer tokens will be rewritten to use stored system credentials and setup-state checks.

Rationale: the repository already assumes a trusted operator through Docker socket access and local self-hosting. Adding robust end-user authentication would significantly expand scope and is not required to satisfy the first-run bootstrap story. The alternative was combining bootstrap and full user auth in one change, but that would slow down delivery and obscure the GitHub App integration work.

### 5. Keep GitHub App private keys inside the control plane and refresh runtime credentials through a broker path

Worker containers will no longer receive a long-lived GitHub token at provisioning time. Instead, the control plane will issue short-lived installation tokens to the runtime through a brokered path scoped to each workspace. The worker can cache the token until near expiry, then request a replacement. A workspace-scoped shared secret or signed request mechanism will authenticate worker refresh requests so the app private key remains confined to the control plane.

Rationale: this keeps the most sensitive GitHub material out of worker containers and resolves the current mismatch between long-lived workers and one-hour installation tokens. The alternative was copying the app private key into each worker so it could mint its own tokens, but that expands secret distribution and weakens the isolation boundary.

### 6. Treat revoked installations and incomplete bootstrap as first-class degraded states

The control plane will actively validate the stored integration when it starts and when token issuance fails. If the installation is revoked, the app secret material is incomplete, or token refresh is rejected, the system will mark the integration as `degraded`, block provisioning and issue submission, and route the operator back to reconnect or re-run setup. Existing workspace records remain intact so operators can diagnose the issue without losing metadata.

Rationale: bootstrap state is not binary once real credentials and external installations are involved. The alternative was handling failures only at the point of GitHub API calls, but that would create repeated opaque errors across the UI and runtime without a clear operator workflow for recovery.

## Risks / Trade-offs

- [Stored GitHub secrets in the database] -> Mitigation: encrypt sensitive values before persistence and keep the decryption key outside the database.
- [GitHub manifest/install flow complexity] -> Mitigation: model bootstrap as explicit states with resumable retries and operator-visible error messages.
- [Runtime token refresh introduces new control-plane dependency] -> Mitigation: cache tokens briefly in the worker, expose clear degraded states, and keep refresh endpoints narrow and workspace-scoped.
- [Trusted-operator mode removes per-request user identity] -> Mitigation: limit this change to self-hosted deployments and avoid claiming multi-user audit guarantees that do not exist.
- [Organization policies may block app creation or installation] -> Mitigation: surface setup prerequisites early and support a reconnect/manual-admin fallback inside the setup flow.

## Migration Plan

1. Add database support for singleton GitHub integration state, bootstrap attempts, and encrypted secret persistence.
2. Implement the setup routes and UI for manifest creation, callback handling, installation completion, and degraded-state recovery.
3. Replace workspace and issue API auth from bearer-token passthrough to setup-state validation plus installation-token issuance.
4. Introduce a control-plane credential broker and update worker/runtime code to consume renewable installation tokens instead of a static token env var.
5. Remove manual GitHub token fields from the operator UI and update self-hosting documentation to describe first-run setup.
6. Update the repository `README` and installation entry points so the default getting-started flow matches the new bootstrap-first setup model.
7. Roll out behind a bootstrap feature flag or staged release path if needed; rollback by disabling the new routes and temporarily restoring legacy env-backed credential handling until operators can be migrated.

## Open Questions

- What encryption mechanism should protect stored GitHub secrets in self-hosted deployments: app-level symmetric encryption, a mounted key file, or an external secret manager integration?
- Should the control plane request a user access token during installation only for operator identity and installation discovery, or are there target GitHub Project operations that require user-scoped access in some deployments?
- Do we want a supported fallback path for environments where GitHub App creation is restricted and an admin must supply an existing app installation instead of using manifest bootstrap?
