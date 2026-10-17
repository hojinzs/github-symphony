# TC-31: macOS agent user-service lifecycle (C12)

## Setup

Run `pnpm build`, then
`pnpm exec tsc --noEmit --module NodeNext --target ES2023 --strict --skipLibCheck e2e/fixtures/macos-agent-entrypoint.mts`.
Use macOS with an available current-user GUI launchd domain. Run
`./e2e/run-macos-agent-service-e2e.sh` for the normal case and five reached
forbidden-condition probes. Every job uses a unique label and real user home
(from `userInfo()`, not an overridden worker `HOME`), and all project/agent data
uses a temporary directory. No privileges or real credentials are required.

## Steps and expected results

1. Save C03 identity/allowlist, then install the real plist. Validate with
   `plutil -lint`. Inject a bootstrap failure, retry with the same persisted
   identity and start the job (CP-22).
2. The independently typed foreground entrypoint composes C05's actual
   `runForegroundAgent` with a schema-validated v1 peer fixture. Its poll delivers
   a start command to C03's actual bundled local adapter using C12's isolated
   launcher. Wait for the real prepared-project CLI daemon to start.
3. Read launchd's actual agent PID and compare its process group to the managed
   project. Attempt a second C03 registry owner and require lock rejection.
4. Stop the loaded service and confirm job removal; assert the same verified
   managed-project PID/opaque identity and live authenticated state endpoint.
5. Start/restart the service, kill only the agent to exercise bounded unexpected
   exit recovery, and repeat project preservation checks (CP-23).
6. Uninstall the service. Require absent job/definition and unchanged
   enrollment/allowlist/journal fixture bytes. Project must remain running.
7. Plant each forbidden condition. Each probe must print its named reached
   assertion and fail with `AssertionError`: mismatched loaded PID, accepted
   foreground lock conflict, actual SIGTERM to the project before survival
   assertion, missing unexpected-exit recovery, and modified journal bytes.

Portable unit contracts additionally cover relative paths, malformed labels,
foreign user domains, symlink directories/files, conflicting installation or
loaded definitions, asynchronous bootout, repeated lifecycle operations and
unload failure preserving the definition. Run
`pnpm --filter @gh-symphony/management-agent test`.

## Evidence boundaries

The native runner records its Darwin version. Linux/Docker cannot establish
launchd isolation. The applicable C05 Docker dependency scenario is
`./e2e/run-agent-transport-e2e.sh`; record its result separately, including the
AGENT_TEST worker preflight-69 exception when applicable.

The peer's command/projection/journal are typed fixture boundaries, not production
fleet HTTP routing or C08 journal evidence. The agent is a real launchd job and
the orchestrator is the actual CLI daemon. C13 owns public agent command routing;
this TC does not invent or test `agent service` CLI commands.

Login/logout walkthrough: on an interactive test account, install a production
foreground entrypoint, log out/in, and verify login startup. The agent is not a
pre-login boot daemon and does not survive logout; project persistence through
session teardown is not promised. This walkthrough is manual and reported
separately from automated stop/restart/uninstall. Do not log out the shared test
host as part of an unattended run.

## Cleanup

The runner unloads/removes only its uniquely labeled plist, explicitly stops its
prepared project and removes temporary fixture data. It does not touch the
operator's standard management job, identity, registrations or journal.
