# OhMySymphony C22 visual design handoff

- **Date:** 2026-10-06 (Graphite full-system review candidate)
- **Status:** A — Graphite applied to the full system; final operator approval pending
- **Symphony Layers:** Configuration, Integration, Observability (cross-layer presentation contracts)
- **Tracking:** [C22 #1026](https://github.com/hojinzs/github-symphony/issues/1026), [Epic #983](https://github.com/hojinzs/github-symphony/issues/983)
- **Source:** [Approved management-plane design](2026-10-04-control-plane-management-agents-design.md), [#984 completion](https://github.com/hojinzs/github-symphony/issues/984), merged [PR #982](https://github.com/hojinzs/github-symphony/pull/982)
- **Plan:** [C22 execution plan](2026-10-05-ohmysymphony-c22-redesign-plan.md)
- **Artifact:** [OhMySymphony overview](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-368), in the existing [Dani Works / OhMySymphony folder](https://www.figma.com/files/team/987232692286731920/folder/665174118)

## Delivery boundary and approval

The operator selected [A — Graphite](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=53-490)
on 2026-10-05. The [theme decision record](2026-10-05-ohmysymphony-theme-directions.md)
preserves that selection. Graphite is now applied to the shared foundations,
components, widgets and all **58 screen frames: 48 at 1440px, five at 1024px and
five at 390px**. All 58 existing screen-root IDs remain stable. The original
decision archive and the three exploration samples remain available.

This is the **2026-10-06 Graphite review candidate**, not an approved release.
The [dated review manifest](2026-10-06-ohmysymphony-graphite-review.json) records
the exact node set, final render hashes and static verification totals. Figma
is mutable; final approval must identify this dated candidate or explicitly
identify a later reviewed revision. Selection of A does not approve the full
result, and no frontend/runtime implementation is claimed here.

The presentation preserves the approved Control Plane → Management Agent →
per-project orchestrator authority boundary. It adds no scheduler, tracker,
execution, CLI or protocol behavior. The management plane remains an explicit
repository-local extension above the upstream service; C22 adds no new upstream
divergence and does not modify `docs/symphony-spec.md`.

One operator, a private network, Linux/macOS and already prepared project folders
remain the available scope. Projects is the landing view; Projects, Environments
and Commands are the primary navigation. Runs/logs is a design area reached from
project context. Login/OIDC, public deployment, Docker, project provisioning,
arbitrary remote paths, force kill, bulk lifecycle controls and global dispatch
are unavailable in this release. Screen context/footer identifies **Private
workspace · Single operator**.

The operator approved the specification and decision samples in #984 on
2026-10-05. That approval does not approve this redesign. Authorization to begin
C22 also does not substitute for review of its resulting frames.

| Evidence stage                     | Current status                  | Evidence / remaining work                                                                                                              |
| ---------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Graphite application               | Complete                        | Shared foundations, 62 component definitions on production pages, 15 production widget definitions and 58 screen roots                 |
| Structural and semantic inspection | Passed                          | All instance references resolve; no missing fonts or raster screen fills; 1,168 static assertions pass with zero screen-bound overflow |
| Rendered/model review              | Passed after repairs            | All 58 screens reviewed; modal, tablet, context and fixture corrections re-rendered and rechecked                                      |
| Repository checks                  | Passed                          | Fresh full retry: 2,150 tests in 14 packages; document, formatting and whitespace checks                                               |
| Human redesign approval            | **Pending**                     | Actual operator approval of the dated full-system candidate                                                                            |
| Prototype/accessibility behavior   | Pending #1018                   | Executable focus, keyboard, clipboard, transitions and walkthrough evidence                                                            |
| CP runtime/OS acceptance           | Pending implementation children | Executable CP-01–CP-23 and real OS service evidence                                                                                    |

Screenshots or static checks do not establish keyboard behavior, command safety,
runtime responsiveness or human approval. C22 completion and the downstream
unblock condition remain pending explicit redesign approval.

## Page and source inventory

| Page                                   | Node                                                                         | Purpose / screen count                                     |
| -------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 00 Overview / Handoff                  | [23:368](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-368) | Artifact scope, source references and evidence boundary    |
| 10 Foundation / Color and state        | [23:369](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-369) | Shared visual roles and implementation rules               |
| 11 Foundation / Typography             | [23:370](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-370) | Shared visual roles and implementation rules               |
| 12 Foundation / Geometry and elevation | [23:371](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-371) | Shared visual roles and implementation rules               |
| 13 Foundation / Layout and responsive  | [23:372](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-372) | Shared visual roles and implementation rules               |
| 20 Components / Controls               | [23:373](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-373) | Reusable primitives, variants and editable text properties |
| 21 Components / Navigation and data    | [23:374](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-374) | Reusable primitives, variants and editable text properties |
| 22 Components / Dialogs and feedback   | [23:375](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-375) | Reusable primitives, variants and editable text properties |
| 30 Widgets / Environment and project   | [23:376](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-376) | Composed operator UI and data/intent contracts             |
| 31 Widgets / Setup and commands        | [23:377](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-377) | Composed operator UI and data/intent contracts             |
| 32 Widgets / Runtime and logs          | [23:378](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-378) | Composed operator UI and data/intent contracts             |
| 40 Screens / Environments              | [23:379](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-379) | 17 screen frames                                           |
| 41 Screens / Projects                  | [23:380](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-380) | 8 screen frames                                            |
| 42 Screens / Project detail            | [23:381](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-381) | 9 screen frames                                            |
| 43 Screens / Commands and recovery     | [23:382](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-382) | 15 screen frames                                           |
| 44 Screens / Runs and logs             | [23:383](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-383) | 9 screen frames                                            |
| 90 Archive / Decision prototypes       | [0:1](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=0-1)       | Preserved decision samples and source links                |

The original page `0:1` is named **90 Archive / Decision prototypes**. Its source
nodes remain references, including [original fleet U01](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=4-593),
[U02–U08 connection board](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=13-154),
[original project U04](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=4-795),
[stop U05](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=4-844),
[unknown U06](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=4-873)
and [logs U07](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=4-908).
These are archived decisions, not the final implementation assets. Inspection
resolved the original U01/U04/U05/U06/U07 IDs and the connection board. The archive
retains its eight original top-level nodes; source board `3:52` has 471
descendants and connection board `13:154` has 484. This establishes the recorded
structure and resolvable source references. No strict byte-identity comparison
against a pre-edit baseline is claimed.

The [copied Tailwind file](https://www.figma.com/design/Bg9Hb0nSo97A4eNHqeApwk)
discrepancy was resolved by inspecting through the Figma plugin API: all eight
pages were visible, whereas the earlier metadata surface exposed only Welcome.
This was an inspection/access-surface discrepancy, not evidence of deleted
assets. Reuse includes the existing copied Inter styles, operational mono style,
spacing/radius variables and a wrapped existing shadcn button instance. New OMS
semantic roles and domain compositions are local to the product file; no library
publication or Code Connect integration is claimed.

## Shared foundations

The selected A — Graphite direction uses `OMS / Primitives`
(`VariableCollectionId:23:384`, 37 variables) and `OMS / Semantic`
(`VariableCollectionId:23:385`, 30 variables: 23 color roles and seven geometry
variables). Color roles alias primitive values. Existing spacing/radius
definitions are reused, with missing sizes added. Archived sample and exploration
collections remain available to preserve their references; they are not counted
as additional production semantic roles.

| Role                                        | Semantic variable                                                        | Value / rule                                                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas / surface / elevated / muted surface | `oms/bg/default`, `oms/bg/surface`, `oms/bg/elevated`, `oms/bg/muted`    | `#171819`, `#1c1d1f`, `#202124`, `#27282c`                                                                                                                  |
| Primary / secondary text                    | `oms/text/primary`, `oms/text/secondary`                                 | `#e9e9e7`, `#9b9da4`                                                                                                                                        |
| Quiet separator                             | `oms/border/default`                                                     | `#2b2d31`; not the sole meaningful control boundary                                                                                                         |
| Meaningful control boundary                 | `oms/border/control`                                                     | `#73767f`; default input outlines; focus/error keep their corresponding state strokes                                                                       |
| Primary action fill / text / focus          | `oms/interactive`, `oms/interactive/text`, `oms/focus`                   | `#ededee`, `#202124`, `#cac7ff`                                                                                                                             |
| Information                                 | `oms/info/bg`, `oms/info/text`                                           | `#29273b`, `#cac7ff`                                                                                                                                        |
| Verified success                            | `oms/success/bg`, `oms/success/text`                                     | `#1e322c`, `#7acfac`                                                                                                                                        |
| Warning / unresolved outcome                | `oms/warning/bg`, `oms/warning/text`                                     | `#362f22`, `#d9b56a`                                                                                                                                        |
| Failure / destructive consequence           | `oms/danger/bg`, `oms/danger/text`                                       | `#3b2428`, `#ef9a9a`                                                                                                                                        |
| Navigation surface / selected surface       | `oms/nav/bg`, `oms/nav/selected`                                         | `#111213`, `#242528`                                                                                                                                        |
| Navigation primary / muted text             | `oms/nav/text`, `oms/nav/muted`                                          | `#e9e9e7`, `#9b9da4`                                                                                                                                        |
| Spacing                                     | `spacing/0`, `/4`, `/8`, `/12`, `/16`, `/20`, `/24`, `/32`, `/40`, `/48` | Shared gaps and padding in pixels                                                                                                                           |
| Radius                                      | `radius/0`, `/6`, `/8`, `/12`, `/16`                                     | Controls 6, panels 8, overlays 12; documentation may use 16                                                                                                 |
| Control / target size                       | `size/control`, `size/target` and button wrapper sizing                  | Reused button wrappers retain a 44px minimum; concept-derived compact controls have separate visible geometry. Verify interactive target envelopes in #1018 |
| Dialog elevation                            | `OMS/Elevation/Dialog` effect style                                      | 0 / 16 / 48 shadow, black at 40%                                                                                                                            |

Graphite uses warm charcoal surfaces, neutral light primary actions and
restrained lavender information/focus accents. This is an intentional visual
departure from the shipped runtime palette; runtime CSS has not changed.
Essential secondary metadata and remapped faint/icon content use `#9b9da4`.
The quieter `#2b2d31` separator is distinct from the `#73767f` input boundary;
focus and error states retain their corresponding strokes. The target is 4.5:1
normal text and 3:1 large text and meaningful control/focus boundaries.

| Measured token pair                       | Contrast ratio |
| ----------------------------------------- | -------------- |
| Primary text / surface                    | 13.88:1        |
| Secondary text / surface                  | 6.23:1         |
| Secondary text / muted selected surface   | 5.44:1         |
| Button text / primary fill                | 13.76:1        |
| Warning text / warning background         | 6.79:1         |
| Danger text / danger background           | 6.64:1         |
| Information text / information background | 9.07:1         |
| Success text / success background         | 7.33:1         |
| Control stroke / surface                  | 3.72:1         |
| Control stroke / muted selected surface   | 3.24:1         |
| Focus / muted selected surface            | 9.20:1         |

These are opaque sRGB token-pair calculations. The quiet separator/surface pair
is 1.22:1 and is used for decorative division, not as the sole input or focus
affordance. These results do not establish complete
accessibility conformance for every rendered state, opacity, focus treatment or
interaction. #1018 and implementation verification retain those checks.

The file contains 18 local text styles, including six exploration styles and
four new `OMS/Graphite` styles. The current type hierarchy is below. Copied
Tailwind styles and the earlier `OMS/Metric` remain available; concept-derived
assets can retain equivalent exploration styles. Their presence does not mean
that every current screen uses the first candidate's 14px body or 24px title.

| Style                        | Font / size / line height       | Use                              |
| ---------------------------- | ------------------------------- | -------------------------------- |
| `OMS/Graphite/Body`          | Inter Regular, 13 / 20          | Body and operational UI          |
| `OMS/Graphite/Label`         | Inter Medium, 13 / 20           | Controls and compact emphasis    |
| `OMS/Graphite/Page title`    | Inter Semi Bold, 28 / 36        | Page titles and compact metrics  |
| `OMS/Graphite/Entity`        | Inter Medium, 15 / 22           | Project and environment identity |
| `Sample/Operational command` | JetBrains Mono Regular, 13 / 20 | Commands, paths, IDs and logs    |
| `OMS/Display`                | Inter Semi Bold, 36 / 44        | Documentation covers             |
| `OMS/Section`                | Inter Semi Bold, 18 / 26        | Panels and confirmations         |
| `OMS/Caption`                | Inter Regular, 12 / 18          | Secondary labels and timestamps  |

Connection, process, health, work and command outcome are separate state axes.
Pair state colors with labels and timestamps. A disabled action requires a
readable adjacent reason; tooltip-only explanations are insufficient. Focus is
an explicit 2px ring with offset, with actual keyboard and screen-reader behavior
assigned to #1018.

At 1440px, navigation is 208px wide, the location header is 56px high and content
uses 32px gutters. Continuous data rows and compact, unboxed summaries carry
Graphite's hierarchy. The shared shell keeps environment-specific observations
in the inventory and shows private-workspace context rather than an invented
live freshness timestamp. At 1024px, navigation moves into a top bar, content
uses 24px gutters and project/environment identity is combined in one column.
At 390px, content uses 16px gutters; the three fleet totals remain visible and
each project row places identity above Connection/Process and Work/Observed
pairs. The log toolbar wraps while preserving its run/stream and follow state.
Narrow dialogs have 16px outside gutters and scrollable bodies;
title/close and actions must stay reachable. Long paths wrap in detail. Logs and
tables may use explicitly named overflow regions; critical text cannot silently
clip. The 390px frames represent vertical compositions, not proof that every
section fits a single viewport.

## Component inventory and proposed code mapping

Figma names are inspectable design assets. The code names here are proposed
frontend boundaries, not existing exports, generated code or Code Connect
mappings. Reuse of shipped `Button`, `Badge` and related frontend patterns must
preserve the separate fleet-service package boundary.

| Figma component                                                                                            | Definition / properties                                                                                                          | Proposed code name      |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| [Component/Button](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=25-424)                     | Kind: Primary/Secondary/Destructive; State: Default/Hover/Focus/Disabled/Loading; editable label; wraps existing shadcn instance | `Button`                |
| [Component/Field](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=25-450)                      | State: Default/Focus/Disabled/Error/Loading; Label/Value/Hint                                                                    | `TextField`             |
| [Component/Search](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=25-451)                     | Editable search label/value; field-based composition                                                                             | `SearchField`           |
| [Component/Select](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=25-455)                     | Editable label/value; option behavior deferred to C14                                                                            | `SelectField`           |
| [Component/Badge](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-382)                      | Tone: Neutral/Info/Success/Warning/Danger; Label                                                                                 | `StatusBadge`           |
| [Component/NavigationItem](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-391)             | State: Default/Selected/Focus/Disabled; Label                                                                                    | `PrimaryNavigationItem` |
| [Component/Tab](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-400)                        | State: Default/Selected/Focus/Disabled; Label                                                                                    | `DetailTab`             |
| [Component/DataCell](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-401)                   | Label/Value                                                                                                                      | `ObservationCell`       |
| [Component/Metric](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-404)                     | Label/Value/Caption; compact unboxed value-and-label composition                                                                 | `MetricSummary`         |
| [Component/TimelineItem](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-408)               | Label/Value                                                                                                                      | `TimelineItem`          |
| [Component/Notice/Info](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-415)                | Title/Body; information                                                                                                          | `Notice`                |
| [Component/Notice/Warning](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-418)             | Title/Body; warning or uncertainty                                                                                               | `Notice`                |
| [Component/Notice/Danger](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-421)              | Title/Body; error                                                                                                                | `Notice`                |
| [Component/Notice/Success](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-424)             | Title/Body; verified success                                                                                                     | `Notice`                |
| [Component/EmptyState/Neutral](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-427)         | Title/Body; successful empty state                                                                                               | `EmptyState`            |
| [Component/LoadingState/Neutral](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-430)       | Title/Body; data pending                                                                                                         | `LoadingState`          |
| [Component/Dialog](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-433)                     | Title/Body and nested Cancel/Stop buttons; confirmation contract                                                                 | `ConfirmationDialog`    |
| [Component/GraphiteSidebar](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=65-426)            | 208px desktop shell; navigation instances, explicit selection indicator and private-workspace context                            | `WorkspaceSidebar`      |
| [Component/GraphiteLocationHeader](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=65-435)     | Location TEXT property; 56px workspace header without a synthetic live-update timestamp                                          | `WorkspaceHeader`       |
| [Widget/GraphiteProjectRow/Tablet](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=78-416)     | 976px row; preserves desktop TEXT properties, combines project/environment identity and aligns five observation columns          | `ProjectRow`            |
| [Widget/GraphiteProjectRow/Narrow](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=71-5520)    | 358px row; preserves desktop TEXT properties, identity then Connection/Process and Work/Observed pairs                           | `ProjectRow`            |
| [Widget/GraphiteEnvironmentRow/Tablet](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=81-417) | 976px environment row with aligned registry, connection, host, project-count and contact columns                                 | `EnvironmentRow`        |
| [Widget/GraphiteCommandRow](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=76-395)            | 1168px row; Timestamp/Command/Target/Result TEXT properties, aligned Submitted/Command/Target/Result columns                     | `CommandHistoryRow`     |

The live desktop project row is the referenced
[Widget/A/Project row master](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=54-568)
on the theme-assets page. It remains an explicit dependency of the final desktop
fleet compositions, outside the production-page definition count. The tablet
and narrow project masters preserve its editable text properties. The earlier
project rows remain available for legacy and special-state compositions; they
are not the primary six-project fleet table.

## Widget contracts and traceability paths

All timestamps describe observations or records, not browser guesses. Connection
freshness uses Control Plane receipt time; agent observation time is displayed
separately and cannot extend liveness. UI intent addresses registered opaque
project/environment identities, never an arbitrary remote folder or executable.
Widgets display aggregate projections and durable command records; the
orchestrator retains work/retry authority.

The production pages contain **15 widget definitions**, including retained
legacy/special-state rows and four new Graphite row definitions. They also
reference the desktop A project-row master outside those pages. Combined rows
in the table below can describe more than one definition; the shared shell is
listed separately in the component inventory.

| Widget / proposed code name                                                                                                                                                                                                                                                                                                                     | Owner and inputs                                                                                                        | State, freshness and disabled reasons                                                                                                               | Operator intent                                                                            | Components                                                                | Consumer                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------- |
| [Widget/EnvironmentRow/Wide](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-372)<br>[Widget/GraphiteEnvironmentRow/Tablet](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=81-417)<br>[Widget/EnvironmentRow/Narrow](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-411); proposed `EnvironmentRow` | Registry/agent transport: name, nullable host/OS/version, connection, project count, last authenticated contact         | Pending/enrolled/online/offline/revoked; no invented host metadata; contact freshness uses server receipt                                           | View environment or reopen connection; no lifecycle intent                                 | DataCell, row chevron; retained button composition                        | #1019                   |
| [Widget/A/Project row](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=54-568)<br>[Widget/GraphiteProjectRow/Tablet](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=78-416)<br>[Widget/GraphiteProjectRow/Narrow](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=71-5520); proposed `ProjectRow`          | Project projection: environment-qualified identity, connection, process, work/retrying counts, observation time and age | Fresh/stale/offline; historical work remains labeled and excluded from current totals; desktop/tablet rows reflow to explicit state pairs on mobile | Open project; registered project identity only                                             | Editable text properties, monogram, connection indicator and row chevron  | #1020                   |
| [Widget/ProjectRow/Wide](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-392)<br>[Widget/ProjectRow/Narrow](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-430); retained `ProjectRow` references                                                                                                                | Legacy/special-state project projection: environment-qualified identity, connection, process, work, observedAt          | Fresh/stale/offline/invalid/unmanaged; historical work remains labeled; disconnect never means stopped                                              | Open project; registered project identity only                                             | DataCell, retained Button/row affordance                                  | #1020                   |
| [Widget/ConnectionCard](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-449); proposed `ConnectionCard`                                                                                                                                                                                                                          | Registry/agent transport: current connection, host/version and last authenticated contact                               | Enrolled/awaiting signal differs from online; project readiness and count independent                                                               | Inspect environment                                                                        | Badge, DataCell                                                           | #1019                   |
| [Widget/SetupPanel](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-480); proposed `SetupPanel`                                                                                                                                                                                                                                  | Enrollment issuance session: configured origin, OS, issuance/expiry, pending/enrolled and one-session token             | Waiting/expired/reopened/resume; never recover old token or regenerate an enrolled identity implicitly                                              | Copy setup/token; regenerate pending token; resume setup using saved identity              | Select, Button, Notice, operational text                                  | #1019; host setup #1017 |
| [Widget/CommandProgress](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-496); proposed `CommandProgress`                                                                                                                                                                                                                        | Durable command: commandId, operation/target, state, submittedAt, original claimedAt, resultAt and evidence             | Accepted/executing/terminal/expired/unknown; 30s claim and 60s execution deadlines; process time separate                                           | Inspect record; no duplicate submission from progress                                      | Badge, TimelineItem, Notice                                               | #1021                   |
| [Widget/GraphiteCommandRow](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=76-395); proposed `CommandHistoryRow`                                                                                                                                                                                                                   | Durable command history: submission time, operation, environment-qualified target, result and diagnostic summary        | Workspace-wide history has explicit scope; command results remain separate from current process observations; unknown is not success                | Inspect command history; no replay or lifecycle Retry                                      | Timestamp/Command/Target/Result text properties and semantic result color | #1021                   |
| [Widget/RecoveryPanel](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-508); proposed `RecoveryPanel`                                                                                                                                                                                                                            | Durable command and audit: unknown outcome, last evidence, required reason, closure actor/time                          | Unknown and closed-unresolved; no Retry; closure preserves unknown; new command still needs online/process checks                                   | Inspect host evidence, review closure and confirm separately                               | Notice, TimelineItem, Field, Button                                       | #1021                   |
| [Widget/RuntimeMetrics](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-527); proposed `RuntimeMetrics`                                                                                                                                                                                                                          | Current aggregate observations: fresh running, active work and stale/offline totals                                     | Freshness-qualified totals; stale observations excluded from running count; no global scheduler authority                                           | Display only                                                                               | Metric                                                                    | #1020                   |
| [Widget/HistoryPanel](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-540); proposed `HistoryPanel`                                                                                                                                                                                                                              | Known project run summaries: run identity, local timestamp/status and diagnostics                                       | Empty/loading/recent/historical; maximum 100 cached summaries; read failures are explicit                                                           | Inspect known run; no issue retry/cancel                                                   | TimelineItem, text styles                                                 | #1022                   |
| [Widget/LogPanel](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-548); proposed `LogPanel`                                                                                                                                                                                                                                      | Bounded read lane: known project/run/stream, request state, cursor/generation, text and fetchedAt                       | Following/paused/reset/offline/unavailable; 256 KiB chunks, 30s read lifetime; fetched content stays historical                                     | Choose run/stream, pause/follow, request read or reset cursor; offline disables fresh read | Select, Badge, Button, mono text                                          | #1022                   |

Use the following path keys in the frame inventory. Each path ends in the shared
semantic colors, text styles and geometry above. Direct empty/loading/diagnostic
compositions use feedback component instances without introducing a domain
widget solely for wrapping them. Modal shells preserve the page context and use
the documented Dialog contract plus reusable fields, buttons and notices.

| Path     | Screen → widget → component → foundation                                                                                                                                                                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ENV      | Environment screen → wide/tablet/narrow EnvironmentRow / ConnectionCard / SetupPanel as applicable → DataCell, Select, Button, Badge, Notice, Field and row affordance → OMS roles, Graphite/reused type styles, shared geometry                                                               |
| PROJ     | Fleet screen → referenced A desktop / Graphite tablet/narrow ProjectRow and compact metrics; retained rows for special states → text properties, monogram, connection indicator, row affordance, Metric, Search/Select/Notice → documented semantic roles, Graphite/reused styles and geometry |
| DETAIL   | Project detail → HistoryPanel and CommandProgress → TimelineItem, Badge, Notice; DataCell/Tab/Button → OMS roles, type styles, shared geometry                                                                                                                                                 |
| CMD      | Command history/state → GraphiteCommandRow / CommandProgress / RecoveryPanel as applicable → editable result text, TimelineItem, Badge, Notice, Field, Button; Dialog contract → OMS roles, Graphite/reused styles and shared geometry                                                         |
| LOG      | Run/log state → HistoryPanel / LogPanel as applicable → TimelineItem, Select, Badge, Button; operational text → OMS roles, mono style, shared geometry                                                                                                                                         |
| FEEDBACK | Empty/loading/error state → direct EmptyState / LoadingState / Notice and applicable Button → OMS roles, type styles, shared geometry                                                                                                                                                          |

## Screen inventory

Every row links an editable review frame. Its path key expands through the
widget and component inventories above. U02, U03 and U08 share the Environments
page; U05 and U06 share Commands and recovery. Widths are review compositions;
the responsive rules apply to remaining state variants.

| Editable frame                                                                                                             | U / CP references                         | Path     | Consumer               |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------- | ---------------------- |
| [Screen/Environments/list/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-372)                        | U08; CP-03/05/11/14/20/21; setup CP-22/23 | ENV      | #1019; inventory #1020 |
| [Screen/Environments/create/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-466)                      | U02; CP-03/05/11/14/20/21; setup CP-22/23 | ENV      | #1019; inventory #1020 |
| [Screen/Environments/waiting-linux/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-565)               | U02; CP-03/05/11/14/20/21; setup CP-22/23 | ENV      | #1019; inventory #1020 |
| [Screen/Environments/waiting-macos/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-683)               | U02; CP-03/05/11/14/20/21; setup CP-22/23 | ENV      | #1019; inventory #1020 |
| [Screen/Environments/enrolled/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-792)                    | U02; CP-03/05/11/14/20/21; setup CP-22/23 | ENV      | #1019; inventory #1020 |
| [Screen/Environments/connected/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-887)                   | U02; CP-03/05/11/14/20/21; setup CP-22/23 | ENV      | #1019; inventory #1020 |
| [Screen/Environments/expired/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-981)                     | U02; CP-03/05/11/14/20/21; setup CP-22/23 | ENV      | #1019; inventory #1020 |
| [Screen/Environments/reopened/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-1075)                   | U02; CP-03/05/11/14/20/21; setup CP-22/23 | ENV      | #1019; inventory #1020 |
| [Screen/Environments/resume-setup/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-1169)               | U02; CP-03/05/11/14/20/21; setup CP-22/23 | ENV      | #1019; inventory #1020 |
| [Screen/Environments/inventory/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-1264)                  | U03; CP-03/05/11/14/20/21; setup CP-22/23 | ENV      | #1019; inventory #1020 |
| [Screen/Environments/revoke-confirm/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-1355)             | U03; CP-03/05/11/14/20/21; setup CP-22/23 | ENV      | #1019; inventory #1020 |
| [Screen/Environments/revoked/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-1439)                    | U08; CP-03/05/11/14/20/21; setup CP-22/23 | ENV      | #1019; inventory #1020 |
| [Screen/Environments/empty/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-1522)                      | U08; CP-03/05/11/14/20/21; setup CP-22/23 | FEEDBACK | #1019; inventory #1020 |
| [Screen/Environments/loading/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-1548)                    | U08; CP-03/05/11/14/20/21; setup CP-22/23 | FEEDBACK | #1019; inventory #1020 |
| [Screen/Environments/error/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-1574)                      | U08; CP-03/05/11/14/20/21; setup CP-22/23 | FEEDBACK | #1019; inventory #1020 |
| [Screen/Environments/list/1024](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-1600)                       | U08; CP-03/05/11/14/20/21; setup CP-22/23 | ENV      | #1019; inventory #1020 |
| [Screen/Environments/enrolled/390](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=29-1679)                    | U02; CP-03/05/11/14/20/21; setup CP-22/23 | ENV      | #1019; inventory #1020 |
| [Screen/Projects/fleet/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-372)                           | U01; CP-01/03/05/10/17                    | PROJ     | #1020                  |
| [Screen/Projects/filtered/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-508)                        | U01; CP-01/03/05/10/17                    | PROJ     | #1020                  |
| [Screen/Projects/scope-warning/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-621)                   | U01; CP-01/03/05/10/17                    | PROJ     | #1020                  |
| [Screen/Projects/empty/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-737)                           | U01; CP-01/03/05/10/17                    | FEEDBACK | #1020                  |
| [Screen/Projects/loading/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-759)                         | U01; CP-01/03/05/10/17                    | FEEDBACK | #1020                  |
| [Screen/Projects/error/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-781)                           | U01; CP-01/03/05/10/17                    | FEEDBACK | #1020                  |
| [Screen/Projects/fleet/1024](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-803)                           | U01; CP-01/03/05/10/17                    | PROJ     | #1020                  |
| [Screen/Projects/fleet/390](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-915)                            | U01; CP-01/03/05/10/17                    | PROJ     | #1020                  |
| [Screen/Project detail/running/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2005)                  | U04; CP-03/05/08/13/14/17                 | DETAIL   | #1020/#1021            |
| [Screen/Project detail/stopped/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2076)                  | U04; CP-03/05/08/13/14/17                 | DETAIL   | #1020/#1021            |
| [Screen/Project detail/offline/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2147)                  | U04; CP-03/05/08/13/14/17                 | DETAIL   | #1020/#1021            |
| [Screen/Project detail/stale/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2220)                    | U04; CP-03/05/08/13/14/17                 | DETAIL   | #1020/#1021            |
| [Screen/Project detail/invalid-workflow/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2293)         | U04; CP-03/05/08/13/14/17                 | DETAIL   | #1020/#1021            |
| [Screen/Project detail/unmanaged/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2366)                | U04; CP-03/05/08/13/14/17                 | DETAIL   | #1020/#1021            |
| [Screen/Project detail/incompatible/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2439)             | U04; CP-03/05/08/13/14/17                 | DETAIL   | #1020/#1021            |
| [Screen/Project detail/offline/1024](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2512)                  | U04; CP-03/05/08/13/14/17                 | DETAIL   | #1020/#1021            |
| [Screen/Project detail/offline/390](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2584)                   | U04; CP-03/05/08/13/14/17                 | DETAIL   | #1020/#1021            |
| [Screen/Commands and recovery/history/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2660)           | U05/U06; CP-04/06/07/08/09/18/19          | CMD      | #1021                  |
| [Screen/Commands and recovery/stop-confirm/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2693)      | U05/U06; CP-04/06/07/08/09/18/19          | CMD      | #1021                  |
| [Screen/Commands and recovery/accepted/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2724)          | U05/U06; CP-04/06/07/08/09/18/19          | CMD      | #1021                  |
| [Screen/Commands and recovery/executing/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2751)         | U05/U06; CP-04/06/07/08/09/18/19          | CMD      | #1021                  |
| [Screen/Commands and recovery/succeeded/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2787)         | U05/U06; CP-04/06/07/08/09/18/19          | CMD      | #1021                  |
| [Screen/Commands and recovery/failed/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2811)            | U05/U06; CP-04/06/07/08/09/18/19          | CMD      | #1021                  |
| [Screen/Commands and recovery/expired/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2835)           | U05/U06; CP-04/06/07/08/09/18/19          | CMD      | #1021                  |
| [Screen/Commands and recovery/rejected/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2859)          | U05/U06; CP-04/06/07/08/09/18/19          | CMD      | #1021                  |
| [Screen/Commands and recovery/superseded-target/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2883) | U05/U06; CP-04/06/07/08/09/18/19          | CMD      | #1021                  |
| [Screen/Commands and recovery/unknown/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2907)           | U05/U06; CP-04/06/07/08/09/18/19          | CMD      | #1021                  |
| [Screen/Commands and recovery/reason-error/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2942)      | U05/U06; CP-04/06/07/08/09/18/19          | CMD      | #1021                  |
| [Screen/Commands and recovery/closure-confirm/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-2980)   | U05/U06; CP-04/06/07/08/09/18/19          | CMD      | #1021                  |
| [Screen/Commands and recovery/closed-unresolved/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-3026) | U05/U06; CP-04/06/07/08/09/18/19          | CMD      | #1021                  |
| [Screen/Commands and recovery/unknown/1024](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-3049)           | U05/U06; CP-04/06/07/08/09/18/19          | CMD      | #1021                  |
| [Screen/Commands and recovery/unknown/390](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-3083)            | U05/U06; CP-04/06/07/08/09/18/19          | CMD      | #1021                  |
| [Screen/Runs and logs/following/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-3121)                 | U07; CP-12                                | LOG      | #1022                  |
| [Screen/Runs and logs/rotation/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-3160)                  | U07; CP-12                                | LOG      | #1022                  |
| [Screen/Runs and logs/offline/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-3202)                   | U07; CP-12                                | LOG      | #1022                  |
| [Screen/Runs and logs/unavailable/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-3244)               | U07; CP-12                                | LOG      | #1022                  |
| [Screen/Runs and logs/expired-read/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-3277)              | U07; CP-12                                | LOG      | #1022                  |
| [Screen/Runs and logs/empty/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-3310)                     | U07; CP-12                                | FEEDBACK | #1022                  |
| [Screen/Runs and logs/loading/1440](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-3332)                   | U07; CP-12                                | FEEDBACK | #1022                  |
| [Screen/Runs and logs/offline/1024](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-3354)                   | U07; CP-12                                | LOG      | #1022                  |
| [Screen/Runs and logs/offline/390](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=31-3395)                    | U07; CP-12                                | LOG      | #1022                  |

## Approved state contracts

### Connection and local setup

The name-only creation modal persists an environment and issues a ten-minute,
single-use enrollment token. It displays the configured HTTPS origin, OS
selection and separate Copy setup command / Copy token controls. The approved
command is `gh-symphony agent setup --server <configured-origin>`; it contains no
token argument. The user pastes the token into a hidden terminal prompt.
Synthetic examples must never contain a real credential. The compatible CLI
version, supported prerequisites and installation method require release-time
verification; this visual artifact is not a runnable installation runbook.

Token exchange means **Enrolled · Awaiting first signal**. Only the current
session's authenticated heartbeat/observation makes the environment online.
Connected with zero projects is success, followed by local registration through
`gh-symphony agent project add <prepared-folder>`. No Refresh or second approval
is needed after the first signal. Waiting shows elapsed time, expiry and
troubleshooting for token, TLS/private CA, reachability and service startup;
absence of a signal cannot diagnose a specific host failure.

Closing preserves the environment. Reopen never restores the token. Regenerate
replaces a pending unused token while retaining the environment ID. After token
exchange, partial setup retries use the saved identity; replacement of an
enrolled agent is a separate explicit revocation flow.

Linux setup uses a current-user systemd service; boot/logout operation requires
linger and may need local authorization for `loginctl enable-linger`. macOS uses
a user LaunchAgent that starts at login, without pre-login boot or logout
survival promises. Agent stop/restart/uninstall preserves managed orchestrators;
uninstall preserves identity, registrations and journal. Actual OS behavior is
implementation evidence under CP-22/23.

Revoke agent access ends management while local execution continues. Removing a
local allowlist entry displays Unmanaged and preserves historical observations;
neither operation means Delete project or Stop project.

### Observation and lifecycle

An online environment may have stale or unavailable project data. Missing
snapshots, empty inventory and disconnect do not prove a process stopped. Fleet
running totals include only freshly confirmed running projects, with a separate
offline/stale count. Detail keeps Connection, Process, Health and Last observed
independent. Missing workflow can block Start while verified Stop remains
available. Unmanaged/incompatible/offline/unresolved targets have visible
disabled reasons.

```text
accepted → executing → succeeded | failed
accepted → expired
executing → unknown → succeeded | failed
```

Accepted expires when not durably claimed within 30 seconds; an unclaimed command
never becomes unknown. Execution observation timeout is 60 seconds from the
original `claimedAt`, and replay does not reset it. Stop confirmation names the
project/environment, observed active-run count and interruption impact. Accepted
or executing does not optimistically change process state. Stop completion
requires verified exit, released locks and no replacement process, rather than
signal delivery. A superseded target diagnostic does not claim that its
replacement was stopped. Result and process observation have separate times.

Unknown shows last verified evidence and reconnection/local-inspection guidance,
with no Retry. It prevents a replacement command. Required reason plus a second
confirmation allows audited unresolved closure; the record retains outcome
`unknown`, `closedAt`, actor and reason. Closure releases only the management
command slot. A fresh command still needs online state and process verification.
One outstanding command per project and four concurrent commands per agent are
limits; excess capacity is rejected with `agent_busy`, without a hidden queue.

### History and logs

Logs address a known run and fixed stream selection. Reads expire after 30
seconds and chunks are at most 256 KiB. Rotation/truncation is an explicit cursor
reset. Disconnect pauses follow and retains fetched text as historical. Missing
files, expired reads and unavailable details cannot appear as successful empty
streams. Fresh reads can be requested again; this is distinct from forbidden
blind retry of an unknown lifecycle command. History/log UI cannot retry or
cancel issues or change tracker state or budgets.

The default page size is 25, maximum 100. At most 100 run summaries are cached per
project. Terminal or explicitly closed command history is retained for 90 days
by default; unresolved records are never pruned to unlock a project.

## CP-01–CP-23 coverage and evidence boundary

“Visual” identifies a required presentation contract and its review frame family;
it does not claim the backend scenario passed. All runtime checks below remain
pending implementation evidence. CP-02, CP-15 and CP-16 are backend-only cases
without a dedicated product screen.

| CP    | C22 visual coverage / owning scenario                                      | Required backend or OS evidence                               |
| ----- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| CP-01 | U01, environment-qualified identity in fleet rows                          | Same local ID remains separate across environments            |
| CP-02 | Backend-only; local registration guidance                                  | Canonical/symlink deduplication and retarget fencing          |
| CP-03 | U03/U04, unstarted/invalid inventory and disabled Start with verified Stop | Workflow validation and safe existing-process stop            |
| CP-04 | U04/U05, one command progress/result                                       | CLI lock arbitration and duplicate-delivery deduplication     |
| CP-05 | U01/U03/U04, offline historical observations and disabled actions          | Agent/Control Plane disconnect preserves execution            |
| CP-06 | U05/U06, offline rejection, accepted/expired versus unknown                | Atomic claim/expiry race; unclaimed never unknown             |
| CP-07 | U06, unknown/recovery with no replacement command                          | Lost result durability and restart reconciliation             |
| CP-08 | U05/U04, interruption, verified exit and superseded-target diagnostic      | Expected-target/PID/lock fencing; no signal to replacement    |
| CP-09 | U06, reason validation, second confirmation, unknown closed audit          | Evidence reconciliation and audited slot release              |
| CP-10 | U01/U03/U04, receipt freshness distinct from observed time                 | Sequence, clock skew and exclusive-session enforcement        |
| CP-11 | U02/U03/U08, expired/revoked/replacement guidance                          | Token one-use, credential scoping and revocation              |
| CP-12 | U07, missing/expired-read unavailable, rotation/reset, offline history     | Path containment, chunk/read bounds and safe text rendering   |
| CP-13 | U04/command failure, actionable local remediation                          | Noninteractive failure without policy rewrite                 |
| CP-14 | U03/U04, unmanaged history and local registration guidance                 | Removed/moved folder identity and control revocation          |
| CP-15 | Backend-only; no credentials in design samples                             | Credentials excluded from child environment and uploads       |
| CP-16 | Backend-only                                                               | Same-origin/CSRF enforcement and local-owner audit            |
| CP-17 | U01/U04, scope warning and incompatible disabled reason                    | Version rejection and adapter-owned overlap metadata          |
| CP-18 | U05/U06, original claim time and unchanged deadline                        | Idempotent same-owner claim replay after deadline             |
| CP-19 | U06, terminal/unknown gives no replay permission                           | Stale/foreign ownership rejection and effect marker fencing   |
| CP-20 | U02/U08, create/close/reopen/expire/regenerate/enrolled-waiting            | Persistent record and atomic token transitions                |
| CP-21 | U02/U08, first signal with zero projects succeeds                          | Authenticated current-session first-signal transition         |
| CP-22 | U02, setup-resume with saved identity                                      | Actual Linux/macOS partial-install retry and absolute paths   |
| CP-23 | U02, service/linger/logout scope guidance                                  | Actual service stop/restart/uninstall preserves orchestrators |

## Design test cases and delivery evidence

This record supersedes the first candidate's visual measurements. Verification
was repeated for the 2026-10-06 Graphite candidate. Static evidence does not
establish runtime command safety, input behavior or human approval.

| ID                             | Procedure                                                                    | Graphite result                                                                                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01 Archive and reuse          | Resolve source IDs and inspect reusable assets                               | Eight original top-level archive nodes remain; original source links resolve. Shared geometry, Inter/mono and button assets remain referenced. No byte-identity claim                                                                     |
| D02 Foundation/component graph | Inspect aliases, styles, instances, fonts and contrast                       | 23 semantic colors, 62 production component definitions and 15 production widget definitions; no broken references, missing fonts or image fills in the audited production graph. Contrast pairs are recorded above                       |
| D03 Enrollment matrix          | Distinguish waiting, enrolled, authenticated signal and zero-project success | Pending/enrolled/connected/expired/reopened/resume and revoke states pass. Create does not claim prior persistence. Setup names the 10-minute token lifetime and trusted HTTPS/private CA guidance                                        |
| D04 Freshness matrix           | Derive totals from fixture and verify historical labels/actions              | Six projects across three environments; 3 fresh running, 6 active runs, 2 offline. Filtered rows/page count agree while workspace totals remain explicitly scoped. Offline/stale detail keeps action reasons                              |
| D05 Lifecycle/recovery         | Verify target, acceptance/result distinction and unresolved closure          | Unknown has no Retry; required reason, error feedback and separate second confirmation remain visible. Historical command result stays separate from current process state                                                                |
| D06 Layout/log states          | Inspect 1440/1024/390 compositions and recovery states                       | All 58 renders reviewed. Tablet columns, mobile state grid, modal stacking, loading target and historical log timestamps corrected. Rotation requires reset; offline follow is paused; unavailable/expired reads retain selection context |
| D07 Handoff/delivery           | Verify links, metadata, docs/tests and approval boundary                     | All 58 root links, U01–U08, CP matrix and CLI patch metadata retained. Mandatory repository tests pass; final operator approval remains pending                                                                                           |

The read-only state audit executed **1,168 assertions** over all 58 screens:
Environments 265, Projects 318, detail 220, commands/recovery 233 and runs/logs 132. There were zero errors, review flags or visible text/control overflows
past screen bounds at a 1px tolerance. Hidden ancestors are excluded; clipping
at the screen root does not mask the boundary check. These assertions cover
text/property contracts and geometry, not glyph-level clipping or paint order.
Separate screenshot review caught and repaired the modal stacking defect.

The fully loaded production graph was inspected recursively, including nested
instances, across pages `23:368`–`23:383`. It contains 62 component definitions,
five component sets and 15 widgets. The shared A desktop project-row master
`54:568` and its exploration assets remain external dependencies within this
same file. The manifest records the final graph measurement. Four local text
overrides remain editable; this is not a claim that every text node uses a style.
There are no missing fonts, broken instance references or image fills in this
audit. The archive and B/C concepts are excluded from production counts.

Rendered review covered all 58 screens. Independent reviewers inspected the 32
Environment/Command states and 26 Project/Detail/Log states; the latter were
inspected at full size. Reported issues were repaired and focused renders were
rechecked: tablet column alignment and fragmented labels, modal paint order and
backdrop opacity, mobile navigation wrapping, command-history scope, project/log
identity, and the run/log sample timestamps. Final render hashes identify the
dated review set. This remains model/static review.

Repository verification on 2026-10-06:

- Mandatory `pnpm test`: the initial run timed out in the existing
  `hooks.test.ts` large-stdout case at its 1-second limit. A focused retry passed
  12/12; the fresh full retry passed **2,150 tests across 14 packages and 142 test
  files**, exit 0. No runtime code or test configuration was changed. The
  timing-sensitive failure's OS cause was not measured.
- Document checks cover the 58 unique screen IDs, U01–U08, CP-01–23, D01–D07,
  local links, selected A provenance, pending final approval, patch metadata,
  manifest counts and render hashes. Targeted Prettier and whitespace checks pass.
- Earlier `pnpm build` success is baseline evidence from the first candidate;
  this Graphite revision changes Figma and documentation only.
- `docs/symphony-spec.md` has no branch changes. Presentation stays within
  Configuration, Integration and Observability; no new upstream divergence.
- Runtime/Docker/OS verification was not run for this design-only revision.
  Implementation children retain those gates. Focus, keyboard and clipboard
  behavior remain #1018 work; static designs do not satisfy them.
- Operator approval is **pending**. C22 and its Goal remain incomplete until
  actual full-system approval is received and recorded.

## C14 handoff and downstream gates

[#1018](https://github.com/hojinzs/github-symphony/issues/1018) consumes this
redesign after explicit operator approval and C22 completion. Its remaining work:

1. Link prototype transitions, including Cancel versus Stop, acceptance and
   asynchronously verified outcomes, and unknown unresolved closure.
2. Verify modal focus trap, initial focus, Escape/close persistence, focus return,
   narrow-body scrolling and reachable actions.
3. Verify keyboard navigation, tab semantics, visible focus, screen-reader names,
   progress/error announcements and labels that do not depend on color.
4. Verify clipboard success/failure and safe command quoting; an issued token is
   never recovered on reopen. Verify elapsed/expiry display and automatic
   pending → enrolled → online transitions.
5. Validate empty/error/revoked/unmanaged/incompatible states and adjacent
   disabled explanations, with data-consistent counts and timestamps.
6. Exercise required-reason validation, second closure confirmation and retained
   unknown audit, without adding lifecycle Retry.
7. Exercise run/stream selection, bounded follow, pause/reconnect, cursor reset,
   missing file and expired read states.
8. Run operator walkthroughs 1–10 from the approved design, separating human
   review from static/model evidence and runtime/OS evidence.

UI implementation ownership remains [#1019](https://github.com/hojinzs/github-symphony/issues/1019)
(Environments/connection), [#1020](https://github.com/hojinzs/github-symphony/issues/1020)
(fleet/runtime detail), [#1021](https://github.com/hojinzs/github-symphony/issues/1021)
(lifecycle/recovery) and [#1022](https://github.com/hojinzs/github-symphony/issues/1022)
(history/logs). Their native backend prerequisites remain binding. Creating these
assets does not make any implementation child independently ready.

The CLI patch changeset records this operator-required design/documentation
delivery. It does not claim new commands have shipped. Shipped CLI usage,
configuration schemas and package ownership are unchanged, so runtime README,
configuration and architecture references are not rewritten as feature delivery.
