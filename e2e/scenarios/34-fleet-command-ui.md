# TC-34 — Fleet lifecycle confirmation and recovery UI (C17)

Layers: Integration and Observability. Repository-local management extension;
`docs/symphony-spec.md` is unchanged. Scope: CP-04/06–09/18/19 presentation and
U04/U05/U06 walkthroughs. No global scheduler or per-project server change.

## Run

After `pnpm build`:

```sh
node e2e/fleet-command-ui-e2e.mjs
node e2e/fleet-command-ui-mutations.mjs
./e2e/run-fleet-command-ui-e2e.sh
```

The first two commands report actual host OS. The runner repeats the HTTPS
walkthrough and 21 copied-artifact forbidden-condition probes in isolated Linux
Docker, using the existing Compose project isolation and cleanup. Every assertion
prints a reached marker; each mutation must reach its named assertion and fail
with AssertionError. A startup error or timeout is not evidence.

For native browser verification, install Playwright outside the checkout and
point at its ESM entry and a local Chrome binary (or Playwright's installed
Chromium). For example, keeping the checkout as the command working directory:

```sh
scratch=$(mktemp -d "${TMPDIR:-/tmp}/symphony-1021-browser.XXXXXX")
npm --prefix "$scratch" install playwright --no-save --ignore-scripts
export C17_PLAYWRIGHT_MODULE="$scratch/node_modules/playwright/index.mjs"
export C17_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export C17_EVIDENCE="$scratch/evidence"
node e2e/fleet-command-ui-browser.mjs
node e2e/fleet-command-ui-mutations.mjs --browser
```

`C17_*` variables are test-only; none configure the product. Browser probes use
copied compiled artifacts and the same browser binary. The 13 assertions cover
all approved command/recovery states and extra admission/error scenes at 1440/1024/390 and every image's loaded dimensions.
Screenshots include history, stop, unknown and closure at each width.

## Cases

| Case                    | Expected behavior                                                                                                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stop confirmation       | Names prepared project and environment, observed active work and timestamp, interruption impact; GET creates no command                                                                             |
| Admission               | C04 exact-Origin/session/CSRF required, service reasons displayed adjacent to disabled controls; no local execution queue                                                                           |
| Pending                 | Accepted/executing retain independent running observations and timestamps                                                                                                                           |
| Verified outcomes       | Succeeded/failed/expired rendered from durable protocol records, not inferred from observations                                                                                                     |
| Superseded target       | Explicitly states replacement process was not stopped; current running observation retained                                                                                                         |
| Unknown                 | Last evidence, no replay action, required nonblank reason and a second reviewed confirmation                                                                                                        |
| Unresolved closure      | Direct confirmation, mismatched reason and expired review denied; only management slot released; state stays unknown with actor/time/reason audit                                                   |
| History                 | Closed unknown remains visible; no success rewrite                                                                                                                                                  |
| Invalid workflow        | Start rejected; eligible Stop still admitted by actual command service                                                                                                                              |
| Ambiguous response      | Alert directs operator to inspect history before submitting new intent                                                                                                                              |
| Dialog                  | Native modal isolation, initial Cancel focus, Shift+Tab containment, Escape returns focus to original action                                                                                        |
| Validation and feedback | Inline reason error announced and focused; submission live region and busy state; no optimistic process update                                                                                      |
| Responsive              | History, start/stop, six outcomes, superseded, closed unknown, invalid, closure, stale and error scenes at all three widths; no horizontal overflow, local assets retain exact intrinsic dimensions |

## Evidence boundaries

The fixture hosts actual C04/C05/C06/C07 services on a real private HTTPS listener
with ephemeral certificates and real SQLite, enrollment credentials, session
ownership, inventory, claim/result and audit records. Current process observations
and C08-style result evidence are independent protocol fixtures; they do not
execute native lifecycle operations. The C07 clock alone is advanced for expiry
and unknown cases. Agent heartbeat time remains real. The UI uses current C06
observations and C07 retained records to display conflict/unknown admission
reasons. The production fleet listener assembly remains with its owning slice.

These tests prove browser/route/service composition, not native systemd/launchd
installation, isolation, interruption, released locks or process preservation.
Report macOS Chromium, native host HTTPS and Linux container evidence separately.
