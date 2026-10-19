# TC-36 — Production fleet listener and shared CLI (C23)

## Boundary and prerequisites

Build with Node.js 24 and `pnpm build`. OpenSSL must be available. Run:

```bash
node e2e/fleet-listener-e2e.mjs
node e2e/fleet-listener-mutations.mjs
# Isolated Linux container, including both commands:
bash e2e/run-fleet-listener-e2e.sh
```

The scenario starts the actual built `gh-symphony control-plane run --config`
process on a reserved loopback port, with a real TLS certificate and private
SQLite directory. It uses real HTTPS browser requests and actual built
`agent setup --server ... --token-stdin` and native agent entry processes. No
fleet listener, HTTP API, credential/session boundary or persistence service is
replaced by a fixture. The primary configuration is YAML, not just its JSON
subset. Agent trust uses the private CA; certificate verification remains on.

`fleet-listener-os-peer.mjs` supplies an independent test OS peer only to the
setup child through `node --import`. It confines the native definition to a
temporary `os-home`, simulates systemctl/loginctl or launchctl responses and a
unified cgroup file, and refuses unexpected subprocesses. The harness then
starts the actual agent entry named by the generated service definition. This
proves CLI/setup/transport assembly, including first authenticated signal, but
**does not prove native service supervision, login/logout behavior or project
process isolation**. No operator service definition or real service manager is
modified. The ordinary foreground listener runs on the actual reported host OS;
Linux Docker and the OS-command simulations are reported separately from native
service acceptance. Native systemd/LaunchAgent validation remains with the
consuming installation/release acceptance slices.

A second deployment uses a real TLS-terminating test reverse proxy forwarding
Host/Origin to the actual production HTTP backend on loopback. The proxy is the
only server fixture; it does not implement fleet behavior. No authenticated
project-ID allocation, project provisioning, tracker, scheduler, public hosting
or human login is added or claimed.

## Reached assertions

Every row prints `reached: <name>` immediately before its assertion. Setup uses
actual files and subprocesses, each with bounded observation and cleanup.
Credentials are passed on stdin or HTTPS and are removed with the temporary
directory. Only a sanitized report is printed.

| Assertion                               | Expected observation                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| shared CLI help                         | Root help lists `control-plane run`; namespace help describes the fleet.                                                                      |
| foreground readiness                    | Actual process emits `fleet-ready`; configured HTTPS `/healthz` returns `{"status":"ready"}`.                                                 |
| invalid configuration diagnostics       | Unknown YAML field exits nonzero without a ready event.                                                                                       |
| unsafe storage diagnostics              | Existing mode-0755 data directory fails without chmod/ownership takeover.                                                                     |
| TLS material diagnostics                | Missing certificate exits nonzero with TLS/file context.                                                                                      |
| fleet pages                             | Environments and Projects return HTML through the production listener.                                                                        |
| packaged local assets                   | Fleet/environment/run SVGs and the bounded-log browser script return nonempty content from the CLI package.                                   |
| missing CSRF rejected                   | Browser mutation without the session token returns 401 and no permissive CORS header.                                                         |
| cross origin rejected                   | Valid cookie/token from a different origin still returns 401 and no permissive CORS header.                                                   |
| configured Host required                | A different Host is rejected even on health.                                                                                                  |
| duplicate body rejected                 | Duplicate JSON keys are rejected rather than interpreted differently across layers.                                                           |
| browser actor cannot authenticate agent | Browser session/cookie/actor cannot substitute for agent authentication.                                                                      |
| persisted browser environment           | Actual browser mutation creates a durable environment and separate one-use enrollment token.                                                  |
| CLI setup against production listener   | Built `agent setup` enrolls over trusted HTTPS, writes the private registry and reaches the simulated native manager's start operation.       |
| CP21 zero project signal                | Actual native entry negotiates a session and reports an authenticated complete empty inventory; UI says “No projects yet.”                    |
| occupied port without fallback          | A conflicting CLI exits with a bind diagnostic and no ready event; the first agent remains online.                                            |
| SIGINT drains listener                  | Foreground process exits normally on SIGINT and the socket is closed.                                                                         |
| restart preserves environments          | Same configuration restarts with the saved environment.                                                                                       |
| saved agent reconnects after restart    | The saved credential establishes a different session and authenticates a new signal; a retained online label alone cannot satisfy this check. |
| SIGTERM closes storage                  | SIGTERM exits normally with the persisted database available after process exit.                                                              |
| trusted HTTPS proxy boundary            | Trusted TLS proxy reaches backend health with public Host; direct backend Host is rejected.                                                   |
| diagnostics do not expose secrets       | Captured CLI/server/agent diagnostics contain neither the token nor the agent credential.                                                     |

The unit listener contract additionally verifies partial empty inventories remain
unknown until complete, one-project counts, session fencing, command delivery,
claim/result ownership, bounded-read delivery and revocation on actual HTTPS and
SQLite. Its one trusted C06 project mapping is seeded because allocation is the
separate #1061 slice.

## Mutation and assertion evidence

The mutation command first plants a forbidden observation at each of the 22
named assertion boundaries. Each run must exit nonzero with both its exact
`reached:` marker and the named `AssertionError`; a timeout, crash or earlier
failure is rejected as invalid evidence. This verifies every assertion executes.

It then copies the built CLI and assets into a temporary package, links its
existing runtime dependencies, and mutates that copy only. Nine real behavior
probes must reach and fail the appropriate normal black-box assertion:

| Compiled/package mutation                            | Required failing assertion           |
| ---------------------------------------------------- | ------------------------------------ |
| Rewrite prefix-only `node:sqlite` to npm `sqlite`    | foreground readiness                 |
| Return a starting health body after ready            | foreground readiness                 |
| Bypass the browser actor resolver                    | missing CSRF rejected                |
| Remove the public Host guard                         | configured Host required             |
| Select an ephemeral fallback on bind conflict        | occupied port without fallback       |
| Remove the SIGINT handler                            | SIGINT drains listener               |
| Remove startup session recovery                      | saved agent reconnects after restart |
| Invent a nonzero count for completed empty inventory | CP21 zero project signal             |
| Empty a packaged SVG                                 | packaged local assets                |

Every copied artifact is restored or deleted in `finally`; production source is
never mutated by this command. There is no test-only mutation switch in product
code. `C23_PLANT` and `C23_CLI` are test-only harness controls, not product
configuration or deployment options.

## Evidence and interpretation

The positive report includes actual host platform, Node version, built entry
SHA-256, the explicit native-service simulation boundary and all assertion
names. The mutation runner requires 22 reached negative probes and nine compiled
behavior failures. The Docker runner must end with
`C23 production fleet listener Docker E2E passed`. Keep complete command output
outside the checkout, for example `/tmp/c23-evidence/`; report actual macOS/Linux
runs separately from Linux containers. Docker preflight 69 is the narrow
unattended-worker exception defined in AGENT_TEST.md; a post-preflight failure
remains a test failure.
