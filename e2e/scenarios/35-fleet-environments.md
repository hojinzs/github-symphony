# TC-35 — Environment list and connection UI (C15)

Issue #1019, Epic #983. Integration and Observability layers. The private fleet
management plane is a repository-local extension; upstream Symphony is unchanged.

After `pnpm build`:

```sh
node e2e/fleet-environments-e2e.mjs
node e2e/fleet-environments-mutations.mjs
bash e2e/run-fleet-environments-e2e.sh
C15_BROWSER=1 bash e2e/run-fleet-environments-e2e.sh
```

The Docker runner uses an isolated Compose project, removes its containers and
image, and optionally installs test-only Chromium/Playwright inside the container.
The optional browser mode exercises actual Linux Chromium with the same HTTPS
SQLite fixture; it is separate from native Linux systemd acceptance.

For host Chromium, install Playwright outside the checkout (keeping all command
working directories inside the checkout) and set these test-only variables:

```sh
scratch=$(mktemp -d "${TMPDIR:-/tmp}/symphony-1019-browser.XXXXXX")
npm --prefix "$scratch" install playwright --no-save --ignore-scripts
export C15_PLAYWRIGHT_MODULE="$scratch/node_modules/playwright/index.mjs"
export C15_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export C15_EVIDENCE="$scratch/evidence"
node e2e/fleet-environments-browser.mjs
node e2e/fleet-environments-mutations.mjs --browser
```

## Cases and boundaries

| Case                            | Expected                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name-only create / invalid name | Persist escaped name; blank/extra fields rejected; no side effect without same-origin CSRF                                                                  |
| CP-20 close, restart, reopen    | Persistent pending record; old secret is absent; no GET-side token generation                                                                               |
| Unused token regeneration       | Same environment, different token; previous unexpired token is fenced                                                                                       |
| Expiry                          | At ten minutes secret is cleared and copy disabled; regenerate explicitly                                                                                   |
| Enrolled / resume               | Exchange alone waits; resume command uses saved identity; regeneration rejected                                                                             |
| CP-21 zero inventory            | Actual C05 authenticated signal and C06 empty inventory produce online success independently from projects                                                  |
| Revoke                          | Explicit acknowledgement, management-only revocation; local execution continues message                                                                     |
| Loading / errors                | Busy state, readable loading dialog, bounded fetch timeout, recoverable error and retry, no automatic mutation replay                                       |
| Keyboard / clipboard            | Initial focus, explicit forward/backward containment including disclosure, Escape and row opener restoration; separate copy success/manual failure fallback |
| Responsive / assets             | Setup, reopened, enrolled, online, error and revoked at 1440/1024/390; no horizontal overflow; all local images load without distorted aspect ratios        |

The HTTPS suite prints 12 reached assertions. Its mutation runner modifies copied
compiled production artifacts (never the checkout), requires the named assertion
to be reached, and requires AssertionError rather than a startup error/timeout.
The browser suite prints 25 reached assertions with matching artifact probes.
These include deliberate secret retention, disabled focus containment, clipboard
selection loss, forbidden status transitions, broken SVG content types and
responsive overflow. Selected-assertion mode suppresses unrelated assertions only
so a probe must fail at its named contract. Normal runs assert every contract.

The fixture is a real ephemeral private HTTPS server composing C04 enrollment,
C05 sessions, C06 observations, C04 browser security and the C15 dispatcher.
Fault injection only interrupts the independent inventory-count callback.
It does not install services, execute native project lifecycle commands, or claim
systemd/LaunchAgent stop/restart/uninstall process preservation. Report macOS
Chromium, Linux container Chromium and actual native OS service evidence separately.
Production fleet listener assembly belongs to its owning slice.
