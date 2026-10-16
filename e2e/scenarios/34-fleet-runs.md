# TC-34 — Run history and bounded log UI

Issue #1022 / C18 / Epic #983. Covers the owned CP-12 and U07 paths plus
CP-01 project/environment identity, CP-10 historical observations and CP-15
bounded data. No lifecycle commands, tracker/budget mutation, native-service
isolation or production fleet listener deployment is claimed.

After `pnpm build`:

```bash
node e2e/fleet-runs-e2e.mjs
node e2e/fleet-runs-mutations.mjs
./e2e/run-fleet-runs-e2e.sh
```

The HTTPS test listener composes actual C04 enrollment/CSRF, C05 sessions,
C06 SQLite observations, C10 read acceptance/results and the C09 registered
filesystem adapter. It creates independently persisted run metadata and files.
C06 target lookup is wrapped in a shared store transaction at the C10 peer
boundary. No read implementation or inventory API is mocked. The fixture's
read hold, observation clock and physical rotation/truncation are explicit
fault drivers.

| Case                                          | Expected result                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| Known project history                         | Environment/project identity retained, 25 of at most 100 summaries per page |
| Foreign run, stream traversal, arbitrary path | 400, no read submitted                                                      |
| Missing CSRF                                  | 401                                                                         |
| Read and append                               | Actual file text with opaque continuation, 256 KiB request maximum          |
| Rotation and truncation                       | Historical text remains; explicit cursor reset before fresh generation      |
| Large Unicode log                             | 256 KiB text without split code points                                      |
| Missing file                                  | Explicit unavailable, never false empty success                             |
| Offline and reconnect                         | Preserve content/fetched timestamp and history identity; pause follow       |

All 17 assertions print `reached:`. Seventeen isolated copied-artifact
mutations must reach and fail their corresponding assertion. Startup failures
and timeouts do not qualify as mutation evidence.

## Real browser and C14 contracts

Install Playwright outside the checkout, or point at an existing installation:

```bash
scratch="$(mktemp -d "${TMPDIR:-/tmp}/symphony-1022.XXXXXX")"
npm --prefix "$scratch/browser" install playwright --no-audit --no-fund
# Use an installed Chromium, or install Playwright's browser into this scratch.
export PLAYWRIGHT_MODULE_PATH="$scratch/browser/node_modules/playwright/index.mjs"
export PLAYWRIGHT_BROWSERS_PATH="$scratch/browsers"
node "$scratch/browser/node_modules/playwright/cli.js" install chromium
export EVIDENCE_DIR="$scratch/evidence"
node e2e/fleet-runs-browser.mjs
node e2e/fleet-runs-mutations.mjs --browser
```

An installed Chrome can instead be selected using
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; no browser download is then needed.
The browser consumes the actual HTTPS fixture and local bundled client.
Its 21 reached assertions cover inert log text, known selection, stream change,
keyboard follow/pause, cached-page event restoration, rotation/reset focus,
historical labels/timestamps, 1440/1024/390 horizontal containment and exact
visible local SVG geometry, reconnect, missing-file recovery, expired reads,
runtime errors and empty-history controls. It records full-page screenshots
and OS/assertion metadata outside the checkout. Twenty-one copied-browser/output
mutations must reach and fail the named assertions.

The 30-second browser read deadline uses Playwright's accelerated browser clock
against a held actual C10 request. Offline is an observation-clock fault and
browser disconnect event; cached-page restoration uses persisted page lifecycle
events. Neither is a claim about native OS network/service isolation.
Report actual host OS/Chromium results separately from Linux Docker service
composition. Human assistive-technology and deployment walkthroughs remain
separate evidence.

On macOS headless Chrome, synthetic arrow keys do not drive the OS-native
select popup. The automated run focuses the native select and exercises its
change boundary through Playwright selection; native popup arrow traversal
and assistive-technology speech remain human validation. Follow/Pause and
Reset cursor are exercised with keyboard activation and focus assertions.
