# C11 Linux agent user-service implementation plan

**Status:** Implemented — review and native pre-release acceptance pending (#1015, Epic #983)
**Symphony Layers:** Configuration, Execution, Integration (cross-layer)

## Ownership and existing contracts

This slice implements CP-22/23 from the approved
[management-agent design](2026-10-04-control-plane-management-agents-design.md).
Dependencies C03 (#1007, merged PR #1034) and C05 (#1009, merged PR #1039)
are available. The management plane is an explicit repository-local extension
to the upstream spec's non-goals. No scheduler, tracker policy, workflow loading,
or upstream `docs/symphony-spec.md` changes are proposed.

| Artifact                                                                   | Responsibility                                                                                       |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/management-agent/src/linux-service.ts`                           | Typed Linux service configuration, unit rendering, diagnosis, installation and lifecycle             |
| `packages/management-agent/src/linux-launcher.ts`                          | OS-isolated project launcher and sanitized process invocation                                        |
| Matching `*.test.ts`                                                       | Invalid configuration, quoting, installation recovery, lifecycle and independent OS-command fixtures |
| `packages/cli/src/management-agent.ts`                                     | Bundle/export Linux composition alongside existing C05 foreground boundary                           |
| `packages/cli/src/management-local.ts`                                     | Consume existing `ProjectLaunchContext` without weakening its native-service guard                   |
| Linux E2E runner and scenario under `e2e/`                                 | Real service lifecycle, managed project continuity and reached assertion probes                      |
| Package/root CLI READMEs, architecture/configuration docs, `AGENT_TEST.md` | Document shipped boundary and executable verification                                                |
| `.changeset/`                                                              | Required patch release metadata for `@gh-symphony/cli` only                                          |

Shared public setup/command routing must remain composable with the separate
CLI slice. C11 owns Linux implementation and bundled typed exports; it must not
claim an unimplemented public command. No changes to the per-project web server
or macOS service packaging are needed.

## Concrete service and isolation boundary

The agent is a user-owned systemd service installed under the user's systemd
configuration directory. Configuration records absolute Node, bundled CLI or
entry module, data and configuration paths. Reject relative paths, control
characters and conflicting installed definitions. Quote systemd arguments,
including literal percent specifiers, without shell evaluation. Credentials
remain in the existing user-owned C03 identity store and never enter unit
arguments, diagnostics or generated files.

The service invokes the C05 foreground loop, retaining the C03 exclusive owner
lock throughout execution. Use bounded restart delay and journald diagnostics.
Install is idempotent for identical configuration. A failed enable/start leaves
the saved identity intact so service installation can be retried without
enrollment. Stop/restart/uninstall touch only the agent unit; uninstall preserves
identity, registrations and journal.

The existing `ProjectLaunchContext` requires an explicit
`launchIsolatedProject(IsolatedProjectLaunch)` callback for native services.
Implement that callback by asking the user manager to create a **separate
transient service** for the trusted local `project start --daemon` invocation.
Its daemon descendants remain in that project service's control group, outside
the agent service. Use an independently retained project unit after the launcher
finishes; determine launcher completion from systemd execution status rather
than treating service submission as CLI success. Do not use a scope wrapping a
process already spawned inside the agent, or rely on detached spawning.

Project services must have no `PartOf`, `BindsTo`, or stop-propagating relationship
to the agent. Agent lifecycle methods must never stop project units. Retained
project units need safe cleanup/reuse after explicit project stop, without
signaling a replacement daemon. Unit names are locally derived identifiers,
never remote strings. Launch deadlines and sanitized project environment follow
the C03 contract; failed or uncertain launches remain non-success results.

Before declaring CP-23 implemented, verify the actual child daemon's control
group differs from the agent's and survives stop, restart and uninstall. Machine
shutdown and user-session teardown remain outside the continuity guarantee.

## Diagnosis and recovery

Check Linux, absolute systemd tooling, reachable user manager and user-unit
support before reporting installation success. Query linger through `loginctl`.
Absent linger produces an explicit boot/logout limitation and the suggested
`loginctl enable-linger` action, with local authorization requirements; never
invoke privilege escalation or enable linger implicitly. Unsupported managers
report the foreground recovery path and do not report service-installed.

Inspect only the owned unit and return bounded diagnostics. Distinguish a
missing unit, unavailable manager, conflicting configuration and failed start.
Preserve identity on all installation/recovery paths. Reusing the foreground
lock must reject a conflicting service or diagnostic foreground process.

## Verification cases and evidence limits

### Review repair scope (PR #1051)

The review return retains the Configuration, Execution and Integration ownership
above. Implement these repairs in the existing Linux adapters and fixtures:

- `linux-service.ts`: query the user manager environment and reject a non-default
  `XDG_CONFIG_HOME` with a foreground recovery limitation before writing a unit.
  Diagnose unified cgroup v2 from `/proc/self/cgroup`; unavailable, legacy and
  hybrid hierarchies must not report support. Keep OS-file fixture seams typed.
- Effective unit ownership: permit only trusted vendor type-wide `service.d`
  drop-ins; retain rejection of user-writable and unit-specific overrides,
  transient units and foreign fragments. Test both acceptance and rejection.
- `linux-launcher.ts`: before launch, attempt bounded best-effort reclamation of
  locally named retained transient project units. Require expected unit type,
  retained/exited state, separated control-group identity and `populated 0`
  immediately before stopping. Never stop a populated, uncertain, foreign or
  replaced unit; cleanup failure must not fail the requested launch. This is
  reclamation of empty OS containers, not project stop policy.
- Clarify the existing regular-file entry/config requirement with a `realpath`
  example, and move home-directory validation to the service constructor.

Add regression cases for default/non-default manager configuration, unavailable
and legacy cgroup evidence, vendor/user drop-ins, empty/populated/replaced units
and cleanup failure. Mutate each guarded condition and record the failing test.
Extend the independent black-box fixtures as needed, then run the full checks
and applicable Docker scenario. Reply to every review thread with the concrete
resolution before re-review. Actual Linux OS acceptance remains separate from
simulations. No upstream specification divergence is introduced by these repairs;
the management plane remains the explicit repository-local extension above.

1. Configuration: absolute paths, spaces, percent signs, quotes, invalid/newline
   input, user-only paths, no credential serialization.
2. CP-22: identical installation retry, conflicting configuration, manager or
   start failure after enrollment, preserved identity and registrations.
3. CP-23: linger enabled/absent/unavailable, lifecycle command targeting,
   foreground lock conflict and user-manager availability.
4. Independent process fixture: exercise the actual C03 isolated callback and
   C05 foreground composition; reject failed service submission and uncertain
   completion instead of returning success.
5. Native Linux: real user manager, enrolled foreground agent, actual managed
   project daemon, control-group readback, agent stop/restart/uninstall, unchanged
   project process identity and retained state. Include forbidden-condition
   probes proving each continuity assertion is reached and detects a killed
   project or shared control group.
6. Docker: run Linux contract fixtures through the repository E2E preflight.
   A container without a real systemd user manager supplies simulation evidence
   only. Report native systemd acceptance separately and do not infer it from
   captured command arguments or detached processes.

Run targeted tests and per-test mutations, then `pnpm lint`, `pnpm test`,
`pnpm typecheck`, `pnpm build` and applicable Docker E2E. Follow `AGENT_TEST.md`
for prerequisite limitations. Keep native OS verification limitations explicit
in the workpad and PR. This plan alone is not runtime acceptance evidence.
