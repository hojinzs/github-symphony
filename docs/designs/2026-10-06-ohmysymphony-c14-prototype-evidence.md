# C14 prototype and accessibility evidence

Issue #1018, implementation child of Epic #983. Configuration, Integration and
Observability operator design; no runtime/package boundary change and no new
upstream divergence. `docs/symphony-spec.md` is unchanged. The approved Graphite
foundations and original 58-screen component mapping remain the baseline.

## Review entry points and operation

The [C14 interaction prototype page](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=99-5948)
contains **72 editable screen states**: copies of the 58 approved C22 roots,
12 component-derived interaction states and two persistent closed-list states.
No raster screen is imported into Figma. Same-page copies are necessary because
Figma rejected cross-page NAVIGATE actions; production pages keep their visual
mapping, with C14 annotations and some local prototype entry links. The unified
page is the authoritative C14 interaction graph. Original component masters,
Graphite roles and archive assets are preserved.

Open a listed root and use Figma's Present control. Click labelled controls to
follow the normal flow. Fault shortcuts deliberately select synthetic outcomes;
they are review harness controls, not proposed product shortcuts. Click a blank
reason/name input to advance to a predefined filled field; these are not editable
runtime forms. Re-select a flow to restart it. Native browser Tab, focus traps,
screen readers, clipboard APIs, HTTP, token storage and service commands are not
executed by this prototype.

| Flow               | Start here                                                                                    | Review controls                                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enrollment         | [Empty environment list](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=99-8928) | Add → Create; OS selector toggles Linux/macOS; separate setup/token copy; F = token copy failure, C = setup copy failure, E = expiry, I = invalid name on Create, S = setup resume after enrollment |
| Start              | [Stopped project](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=99-10238)       | Start → accepted → executing → running verified; P = separate process observation after success; fault branches use the Stop scenario to preserve command identity                                  |
| Stop / Cancel      | [Running project](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=99-10129)       | Stop → Cancel/Escape returns without acceptance; confirm → accepted → executing → verified exit; E selects unclaimed expiry while accepted                                                          |
| Unresolved closure | [Unknown command](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=99-11647)       | Blank Review → reason error; click input simulates inspection reason; Review → second confirmation; Back/Escape retains reason; Close unresolved preserves unknown audit                            |
| Logs               | [Following stream](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=99-12264)      | Pause/Resume; selector changes run/stream and cursor context; R = rotation, O = offline, M = missing, E = expired read; C from offline = reconnect to paused, Z while loading = empty               |
| Tablet             | [1024 fleet](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=99-6824)             | Fleet columns, filters and navigation; widths are fixed review frames                                                                                                                               |
| Mobile fleet       | [390 fleet](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=99-7048)              | Stacked identity/state, filters and navigation; this is a long scrolling composition                                                                                                                |
| Mobile enrollment  | [390 enrolled dialog](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=99-9201)    | Reachable resume and close controls; Escape preserves enrolled status                                                                                                                               |

Timeouts are accelerated: pending → enrolled after 15 seconds, enrolled →
connected after 8 seconds, command progress after 6 seconds per stage and log
loading after 4 seconds. They represent injected server observations, not actual
heartbeat polling, elapsed token lifetime or verified command execution. The
10-minute token rule remains the implementation contract. Copy success is a
feedback composition, not a measured clipboard write. Manual token selection
on clipboard failure and real expiration fencing need browser/backend execution.

The graph preserves pending identity on close/reopen without old token controls,
keeps enrolled status when closed, and moves the closed enrolled list online on
a simulated first signal. Zero projects is explicitly successful. In the closed
online list, A simulates later local registration and opens prepared inventory;
this is not UI project provisioning. A revoked environment ends management while
local execution remains described as continuing.

## Concrete artifact and model evidence

[Exported evidence](c14/prototype-evidence.json) captures actual Figma readback,
not a locally generated substitute for the UI. It records 72 root IDs, source
IDs, visible text, control bounds, annotations and **448 navigation edges**.
The capture timestamp comes from `date -u` and is stored in the artifact. Figma
is mutable; the export and renders freeze the reviewed state rather than
claiming future file contents are unchanged.

All destinations resolve within the unified page. A final audit checked 4,131 visible text/instance bounds across all 72 screens with no screen-bound overflow at a 1px tolerance. Hidden ancestors were excluded. This does not establish glyph clipping or paint-order correctness; the three rendered frames were reviewed separately. All wired click targets meet
24×24 minimum bounds. The audit found a 22px environment-name hit target; it was
replaced with its 1168×51 row target. Primary mobile/modal buttons generally use
44px instance frames (40px inner button paints). Inherited mobile navigation,
filters and tabs meet the 24px minimum; they do not all meet the preferred 44px.
No spacing exception is needed for the audited wired targets. Geometry does not
establish actual browser touch/focus behavior.

The audit also repaired close routes that incorrectly returned enrolled state to
pending, corrected startup language inherited from Stop, removed the new pending
row from the pre-create fixture, and retained the closure reason in confirmation.
C14 uses the approved components; these are scoped interaction/presentation
changes, not a redefinition of management protocols.

| Render / review   | Artifact                         | Observed result                                                                                        |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1440 copy failure | [PNG](c14/1440-copy-failure.png) | Failure text readable; setup and token controls separated; close remains reachable; no visible overlap |
| 1024 fleet        | [PNG](c14/1024-fleet.png)        | All six rows, environment-qualified identity, columns, filters and footer visible                      |
| 390 enrollment    | [PNG](c14/390-enrolled.png)      | Heading, saved-identity instructions, wrapped command and both actions visible within 844px height     |

Render SHA-256 values:

- 1440: `fa4b886ede0f31458bec55cdfcada3f41295c1782d70e353d9fcb56ccd97817e`
- 1024: `e5c3a43206c78f2f88112d66c198a5aab191653dfb18c2e78d7c3f57b1181dbb`
- 390: `59fa2bc58180ce12cf7d07bd8ef0647187ff8b435f60cb979af5051746e65a5c`

These are model/render checks, not operator approval. The C22 approval applies
to the unchanged visual baseline only. C14 human review is **pending**.

## Operator walkthroughs 1–10

| Case | Prototype/model evidence recorded                                                                                                                                  | Explicit remaining evidence                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| W01  | Enrollment path, environment-qualified fleet/inventory and local folder-registration guidance linked; prepared inventory is an injected scenario                   | Actual enrollment, two local registrations and aggregate identity/deduplication                                                   |
| W02  | Start acceptance/execution/success paths pass exported-graph fixtures; acceptance is distinct from running verification                                            | Duplicate-submission fencing, local locks and real process observation                                                            |
| W03  | Cancel/Escape return to running without accepted state; confirmed Stop goes through acceptance/execution/verified exit                                             | Actual graceful signal, exit and lock verification; human disruption comprehension                                                |
| W04  | Offline route, historical detail and disabled lifecycle controls checked; tablet fleet retains fresh versus historical totals                                      | Disconnect/clock/session behavior and live count updates                                                                          |
| W05  | Blank reason/error, filled reason, second confirmation, Back/Escape and retained unknown audit checked; no Retry link                                              | Real input validation, durable evidence reconciliation and audited slot release                                                   |
| W06  | Run/stream selection, pause/resume, rotation/reset, offline reconnect-to-paused, missing/expired/empty paths checked                                               | Bounded reads, cursor ownership/rotation, safe log rendering and scroll-follow execution                                          |
| W07  | Revoke confirmation/cancel/revoked paths linked; unmanaged detail preserves history and explains execution boundary                                                | Allowlist removal/revocation enforcement and continued local execution                                                            |
| W08  | Modal annotations and written initial-focus/trap/return, tab semantics, names, focus visibility and announcement contracts; Escape links and target bounds checked | Full keyboard walkthrough, focus trap/return, browser DOM names/live regions, screen-reader and zoom/reflow execution             |
| W09  | Copy feedback branches, persistent close/reopen, no old token controls, expiry/regeneration, enrolled waiting and online-zero-project paths checked                | Clipboard success/failure, one-use token fencing and authenticated first-signal transition                                        |
| W10  | Existing Linux/macOS setup/resume, linger, private CA and saved-identity guidance inspected; no actual native command run                                          | Real Linux/macOS partial-install retry, foreground lock, logout/login and service stop/restart/uninstall preserving orchestrators |

W01–W10 are model walkthrough records, not human walkthrough passes. The
[interaction contract](2026-10-06-ohmysymphony-c14-interaction-contracts.md)
maps every CP-01–CP-23 case and separates backend-only security gates. All
runtime CP cases remain with their implementation owners; no Linux/container
simulation or actual OS acceptance is claimed here.

## Typed fixture boundary and executable verification

[Typed fixtures](c14/walkthrough-fixtures.ts) specify design events and expected
screen destinations independently of the exported graph. They identify #1019,
#1020, #1021 and #1022 consumers; they are intentionally not HTTP or agent protocol
types. [Seven tests](c14/interaction-contracts.test.ts) integrate these fixtures
with actual exported Figma text/reactions. They check normal, invalid and recovery
routes, closed-state persistence, absent token controls, zero-project success,
disabled safety, unknown audit and target bounds. They do not exercise a mocked
implementation reducer or assert runtime acceptance from synthetic events.

Run from the repository root:

```sh
node --experimental-strip-types --test docs/designs/c14/interaction-contracts.test.ts
pnpm exec tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --skipLibCheck docs/designs/c14/walkthrough-fixtures.ts docs/designs/c14/interaction-contracts.test.ts
```

Both pass. Node's module-detection warning is harmless for this standalone design
fixture; no runtime package/configuration is added. Tests are separate from
workspace package discovery, so the explicit command above is required in
addition to `pnpm test`.

Each test was mutation-checked by editing the exported evidence, running only
the affected test and restoring the original bytes:

| Guarded test       | Planted forbidden condition               | Result                             |
| ------------------ | ----------------------------------------- | ---------------------------------- |
| enrollment         | Remove Create environment edge            | Failed at Create → waiting         |
| fleet              | Remove All states edge                    | Failed at fleet filter route       |
| lifecycle          | Remove Cancel edge                        | Failed at Cancel → running         |
| closure            | Remove Close unresolved edge              | Failed at confirmed closure route  |
| logs               | Remove Reset cursor edge                  | Failed at rotation recovery route  |
| snapshot integrity | Set Add environment target height to 12px | Failed small-target assertion      |
| token absence      | Add Copy token to reopened visible text   | Failed old-token-control assertion |

All seven then pass with the unmodified final snapshot. These mutations prove
that the assertions execute and detect their prohibited graph/text conditions;
they do not prove implementation behavior that is outside the exported artifact.

Repository checks and final publication are recorded in the issue workpad/PR.
No integration behavior changed, so Docker E2E is N/A. No shipped CLI command,
configuration/environment variable or package ownership changed; runtime README,
configuration and architecture documents remain applicable. The operator-required
CLI patch changeset records this design/documentation delivery without claiming
a new shipped fleet feature.
