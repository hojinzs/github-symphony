# C15 environment UI implementation plan

Issue #1019, Epic #983. This slice crosses Integration (enrollment/browser
security boundaries) and Observability (environment connection presentation).
The approved Graphite handoff is the visual and state baseline.

## Ownership and interfaces

- `packages/fleet-control-plane/src/environment-presentation.ts` derives display
  stages from the protocol's `EnvironmentRecord` and an optional freshly issued
  `EnrollmentTokenResponse`. It owns no persistent state or authentication.
- Planned `environment-pages.ts` and `environment-styles.ts` compose the list,
  ConnectionCard and SetupPanel using shared Graphite foundations. Unknown host,
  OS, version and project count remain unknown rather than invented.
- Planned `environment-routes.ts` mounts `/environments` and connection actions
  on the fleet listener, following the existing project/command route boundary.
  Reads use `EnrollmentService.listEnvironments`; mutations delegate to
  `createEnvironment`, `regenerateEnrollment` and `revoke` after existing browser
  session/origin/CSRF checks. GET never mutates enrollment.
- Planned `environment-browser.ts` handles modal focus, Escape/close, clipboard
  success/failure, expiry and polling. Polling reads authoritative records; only
  the authenticated session service can produce an online transition. Secrets
  remain ephemeral and are cleared on close; no local/session storage or URL
  carries a token. Command and token have separate copy controls.
- `ObservationService` supplies inventory counts independently from transport
  status. Existing inventory/project UI remains owned by C16.

The setup command is `gh-symphony agent setup --server <configured-origin>`.
Origin validation and shell-safe construction must precede rendering. Tokens
belong in the hidden terminal prompt. Regeneration applies only to pending
identities; enrolled hosts resume using their saved identity. Revocation ends
management access while preserving local execution.

## Verification plan

Protocol-schema-validated presentation fixtures cover pending/new/reopened,
expiry, enrolled waiting, online without inventory, offline and revoked states.
Route integration tests must exercise the real SQLite enrollment/session
services for CP-20/21, invalid input and CSRF failures. Browser verification must
exercise focus/keyboard/clipboard and responsive widths 1440, 1024 and 390.
Add an applicable Docker black-box scenario and record actual native OS evidence
separately. Every added test needs a failing behavior mutation before handoff.
Run pnpm lint, test, typecheck and build before completion. Update related living
documents and add the required CLI patch changeset before review.

## Upstream conformance

The management plane is the explicitly approved repository-local extension to
upstream Symphony, whose non-goals exclude prescribing a rich fleet UI. No
scheduler, tracker policy, workspace lifecycle or per-project web listener is
changed. `docs/symphony-spec.md` remains untouched. This slice introduces no new
upstream divergence beyond that documented management-plane extension.
