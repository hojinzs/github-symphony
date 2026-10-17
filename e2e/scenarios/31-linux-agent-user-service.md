# TC-31: C11 Linux user-service recovery and orchestrator isolation

## Setup

Run `pnpm build`. On an ordinary host, run
`node e2e/linux-agent-service-e2e.mjs --simulate` and
`node e2e/run-linux-agent-service-probes.mjs --simulate`.
Run `./e2e/run-linux-agent-service-e2e.sh` for the same contract in Linux Docker.

For actual native acceptance, use a prepared Linux operator account with systemd
254+, a reachable systemd user manager, unified cgroup v2 and no existing
`gh-symphony-agent.service`. Run
`node e2e/linux-agent-service-e2e.mjs --native`, followed by
`node e2e/run-linux-agent-service-probes.mjs --native`. The runner refuses to
replace an existing agent definition. It does not enable linger or elevate.
Native preflight returns 69 on unsupported hosts/managers; this is distinct from
Docker's accepted unattended-worker prerequisite exception.

The fixture creates ephemeral TLS material, saved C03 identity/allowlist, a
prepared project with literal dollar/percent/space characters and an invalid
workflow folder. C05 runs in the service entrypoint through real verified TLS;
an independent schema-validated C01 peer supplies sessions, observations and
one-shot delivery. The C06 entrypoint/journal is a fixture, not production
command claim/replay acceptance. C11 native mode uses production systemd tools
and actual `/proc/<pid>/cgroup`; simulation substitutes only the OS command
manager and control-group readback. Every managed project is the actual bundled
CLI daemon.

## Steps

1. Pack the CLI and verify the Linux module and declarations. Diagnose linger;
   absent/unknown linger must include the explicit authorization/startup limits.
2. Save enrollment and registrations, then fail installation with an absent
   trusted entrypoint. Verify unchanged identity. Create that entrypoint and
   retry install without token exchange; repeat identical installation.
3. Verify private credential absence from the installed unit. While C05 owns
   the local registry lock, reject a conflicting foreground owner.
4. Deliver a typed start for the invalid folder and verify `project_invalid`.
   Deliver a start for the prepared folder through TLS. The real C03 adapter uses
   C11's native-service callback; wait for actual daemon readiness.
5. Native mode first runs `systemd-analyze --user verify` on the rendered unit.
   Read the actual project PID/process identity. Verify management credentials,
   aliases do not reach CLI startup. Simulation additionally seeds inherited
   manager-only credentials; native mode does not claim that seeded-manager
   case or journal credential readback.
   Native mode reads the actual daemon cgroup and agent unit's ControlGroup and
   requires disjoint ownership. Simulation checks virtual OS readback only.
6. Stop the agent service and verify unchanged running project identity,
   registry and journal. Start and reconnect, restart and reconnect, then repeat
   continuity checks. Uninstall and verify the definition is absent while the
   original project and all saved state persist.
7. Run eighteen forbidden-condition probes. Each must reach its named assertion
   and fail with AssertionError: removed packed declaration, replaced identity,
   serialized credential, removed owner lock, corrupted cgroup evidence, changed
   repeat-install definition, omitted linger limits, corrupted invalid-result
   evidence, environment/diagnostic credential leaks, changed journals or a
   retained uninstalled definition. Process probes explicitly stop the project
   before the start/stop/restart/uninstall assertions. Native mode substitutes a
   malformed-unit parser probe for the simulation-only diagnostics probe.

## Expected

CP-22/23 and applicable service operator walkthrough cases have executable
normal, invalid and recovery coverage. Every assertion emits `reached:`.
The probes test reached assertions against forbidden input/state; the cgroup
probe corrupts readback evidence, while unit mutations independently remove the
production cgroup guard. The stop/restart/uninstall probes kill the real CLI
project before checking continuity.

Report `mode: native-systemd` separately from `mode: OS-manager-simulation`.
A macOS run or a standard Linux container with virtual manager evidence cannot
establish native systemd lifecycle isolation. Native acceptance must be confirmed
before release; CI/container evidence alone does not meet that gate. Machine
shutdown or user-session teardown is outside the continuity guarantee.

## Cleanup

Close TLS clients/server, uninstall only the fixture's owned agent definition,
gracefully stop only its prepared project and remove its temporary directory.
Native cleanup addresses only the known fixture project unit after explicit
project stop and an empty-cgroup check; it never stops unrelated project units.
The Docker runner removes its isolated Compose resources/image.

## Review regression cases

The typed OS fixtures cover manager XDG configuration rejection before unit
creation, legacy/hybrid/unavailable cgroup evidence, vendor type-wide defaults
and targeted/user override conflicts. Launcher tests use actual cgroup-event
fixture files and check repeated invocation observations: empty transient units
are reclaimed, populated/replaced/foreign/uncertain units remain untouched, and
cleanup failures leave requested launch outcomes intact.

Simulation seeds independent empty and populated retained units before the real
C03/C05 project start. The assertions `C11 empty retained-unit reclamation` and
`C11 populated retained-unit preservation` are reached after startup; `cleanup`
and `cleanup-live` probes plant the forbidden states and must fail at those
assertions. These two additional assertions are explicitly simulation evidence,
separate from native OS lifecycle acceptance.
