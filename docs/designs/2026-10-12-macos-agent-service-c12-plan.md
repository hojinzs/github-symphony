# C12 macOS agent user-service implementation plan

**Status:** Implemented, pending review (#1016; Epic #983)
**Symphony Layers:** Configuration, Execution, Integration (cross-layer)

## Scope and conformance

This slice packages the management agent as a current-user LaunchAgent. It is
an explicit repository-local management-plane extension to the upstream Symphony
specification, not a change to orchestration policy or tracker integration.
`docs/symphony-spec.md` remains unchanged. The shipped per-project control plane,
`project` commands and `--web` keep their existing ownership.

Prerequisites C03 (#1007, merged #1034) and C05 (#1009, merged #1039) provide
local management and foreground/outbound transport. Linux systemd packaging,
fleet UI and the agent command journal belong to other children.

## Files and typed interfaces

- `packages/management-agent/src/macos-service.ts`: trusted local service
  configuration, deterministic plist generation, current-user launchctl adapter,
  installation conflict checks and service lifecycle methods. Export through
  `src/index.ts` and the CLI's existing bundled `management-agent.ts` boundary.
- `packages/management-agent/src/macos-service.test.ts`: real temporary files,
  independent typed launchctl fixture, malformed/conflicting configuration and
  retry/recovery coverage. Inject an executable runner, not a mock of service
  methods. Production runner uses absolute `/bin/launchctl`, argument arrays and
  no shell.
- `packages/management-agent/src/cli-process.ts`: isolate locally invoked project
  CLI processes from the foreground agent process group on macOS. Preserve
  existing deadline and credential stripping behavior.
- `e2e/macos-agent-service-e2e.mjs`: native launchd service lifecycle evidence,
  using a uniquely named user job and temporary data. The OS fixture composes the
  service adapter with the real bundled local adapter/foreground contracts where
  available; its launched project must use the actual prepared-project CLI.
- `e2e/scenarios/31-macos-agent-service.md`: executable CP-22/23 normal, invalid
  and recovery cases, assertion probes and explicit native/container distinction.
- Living documents: package README, root/CLI README, architecture/configuration
  slices and `AGENT_TEST.md` scenario table. Patch changeset releases only
  `@gh-symphony/cli`.

Service configuration contains absolute Node executable, CLI entrypoint,
configuration/data directories and user home, plus the owning UID. Never accept
remote executable or path overrides. The service contract accepts a typed local
foreground entrypoint; if the public CLI composition is not yet present, use an
explicit typed fixture and document that boundary rather than inventing unrelated
commands. Do not silently claim a production command exists.

## Lifecycle and persistence

The adapter owns only its plist in `~/Library/LaunchAgents` and uses the current
user's `gui/<uid>` domain. Installation creates an owner-only definition,
validates absolute paths, escapes XML and rejects symlinks/conflicting content.
Identical installation is idempotent. Bootstrap failure leaves the definition
and enrolled identity available for retry. No service action consumes enrollment
tokens, mutates the allowlist or deletes the identity/journal.

Start loads the definition; status queries launchd instead of inferring loaded
state from a file. Stop unloads the job to suppress KeepAlive. Restart unloads
and loads it again. Uninstall unloads before removing only the owned definition;
a failed unload must not report successful uninstall. Errors must preserve
recovery evidence without leaking credentials. Reject a conflicting foreground
process through the shared existing agent lock, not a second service-only lock.

Plist arguments contain no credentials. Use absolute diagnostic paths,
`RunAtLoad`, restart-on-unsuccessful-exit and a finite `ThrottleInterval`.
Auto-start covers user login only: no pre-login boot startup, no survival after
logout, no privileged LaunchDaemon, no elevation. Machine shutdown and session
teardown do not promise managed project survival.

## Process isolation and acceptance gate

Use a separate process group for local project CLI invocations, retain the
project daemon's existing detached lifetime, and explicitly disable launchd's
job-exit process-group cleanup with `AbandonProcessGroup`. The directly launched
agent remains foreground and handles termination normally. These choices must
be verified together on the actual OS; neither plist text assertions nor a
standalone detached child proves CP-23.

Apple documents job-exit process-group handling in
[launchd.plist](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5).
Verify current host `man launchd.plist` and `man launchctl` while implementing.
Record the platform/version and actual bootstrap availability. A host without a
GUI user domain supplies configuration/contract evidence only.

Native acceptance starts a real prepared project through the managed agent
boundary, captures its verified PID/ownership record and process group, then
stops, restarts and uninstalls the loaded service. After every action, assert the
same project identity is alive and its state endpoint remains responsive. Check
that journal/identity/allowlist bytes remain unchanged and the service actually
exits/restarts. Clean up the project explicitly after assertions. A forbidden
kill of the project must reach and fail the survival assertion.

CP-22 also covers retry after service installation/bootstrap failure using saved
identity, duplicate/conflicting installation, relative paths, escaped path names
and missing GUI-session support. CP-23 covers loaded status, repeated lifecycle
actions, unexpected-exit restart/backoff and foreground-lock conflict. Login and
logout coverage must report its own evidence; automated stop/restart evidence is
not a claim that logout was tested.

## Verification

Run `pnpm lint`, `pnpm test`, `pnpm typecheck`, `pnpm build` and format checks.
For every new/changed test, remove/invert its guarded behavior, run the test to
confirm failure, then restore behavior and record the mutation. Docker can verify
portable command/fixture boundaries, but cannot verify launchd. Run the applicable
Docker preflight/scenario and record status 69 only when the documented worker
prerequisite exception applies. Report native launchd evidence separately and
keep the PR draft until in-scope implementation and acceptance are resolved.
