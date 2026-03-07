## 1. Agent credential data model and secret foundation

- [ ] 1.1 Add Prisma models and enums for agent credentials, platform-default credential selection, workspace credential source, and workspace override binding.
- [ ] 1.2 Refactor the existing GitHub secret-protection utilities into a shared platform secret-protection layer with backward-compatible coverage for current encrypted GitHub data.
- [ ] 1.3 Implement control-plane persistence helpers that create, validate, list, rotate, and resolve effective agent credentials without exposing stored plaintext secrets.

## 2. Control-plane operator flows

- [ ] 2.1 Add control-plane API routes for agent credential creation, validation, default selection, rotation, and degraded-state reads.
- [ ] 2.2 Update workspace creation parsing, services, and UI so operators can choose `platform default` or a workspace-specific override and are blocked when no usable credential exists.
- [ ] 2.3 Add workspace-facing status surfaces that show the effective credential source and recovery messaging when a bound credential is missing or degraded.

## 3. Runtime broker and launch contract

- [ ] 3.1 Add a workspace-scoped agent credential broker endpoint authenticated with the existing runtime auth secret pattern.
- [ ] 3.2 Update workspace provisioning so worker runtimes receive the broker URL, auth secret, and any cache-path metadata needed for pre-launch agent credential resolution.
- [ ] 3.3 Update the worker runtime to resolve brokered agent authentication environment before spawning `codex app-server` and to fail cleanly when resolution is unavailable.

## 4. Failure handling and lifecycle behavior

- [ ] 4.1 Add runtime and control-plane degraded-state handling for invalid, revoked, deleted, or missing effective agent credentials.
- [ ] 4.2 Ensure credential rotation changes the effective credential for subsequent runs without requiring workflow-file edits or repository secret persistence.
- [ ] 4.3 Add migration-safe handling for existing workspaces so new runs are blocked or guided until a valid effective agent credential is configured.

## 5. Verification and documentation

- [ ] 5.1 Add unit coverage for secret protection, credential validation, effective credential resolution, and runtime broker authentication.
- [ ] 5.2 Add integration coverage for workspace creation with platform-default and override credentials, runtime pre-launch resolution, and degraded-state recovery.
- [ ] 5.3 Update `README`, self-hosting, and local-development documentation to describe agent credential setup, default vs override selection, rotation, and runtime recovery expectations.
