# OhMySymphony C22 visual design handoff

- **Date:** 2026-10-05
- **Status:** A — Graphite selected — previous candidate retained as reference; full-system application pending
- **Symphony Layers:** Configuration, Integration, Observability (cross-layer presentation contracts)
- **Tracking:** [C22 #1026](https://github.com/hojinzs/github-symphony/issues/1026), [Epic #983](https://github.com/hojinzs/github-symphony/issues/983)
- **Source:** [Approved management-plane design](2026-10-04-control-plane-management-agents-design.md), [#984 completion](https://github.com/hojinzs/github-symphony/issues/984), merged [PR #982](https://github.com/hojinzs/github-symphony/pull/982)
- **Plan:** [C22 execution plan](2026-10-05-ohmysymphony-c22-redesign-plan.md)
- **Artifact:** [OhMySymphony overview](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=23-368), in the existing [Dani Works / OhMySymphony folder](https://www.figma.com/files/team/987232692286731920/folder/665174118)

## Delivery boundary and approval

The operator requested a new visual direction after reviewing this candidate,
then explicitly selected [A — Graphite](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=53-490)
on 2026-10-05. The [theme decision record](2026-10-05-ohmysymphony-theme-directions.md)
contains the selection evidence. The 58 screens below remain unapproved
behavior/state references. Their earlier verification records describe that
candidate only; Graphite must be applied and verified across the
full system before final operator review.

This candidate reorganizes the existing file into shared foundations, reusable
components and widgets, and five screen areas. The inventory contains **58
screen frames: 48 at 1440px, five at 1024px and five at 390px**. Their names and
node links below identify the review set. Figma is mutable; final approval must
identify the reviewed revision or dated review snapshot as well as these nodes.

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

| Evidence stage                        | Current status                                          | Recorded evidence / remaining work                                                                               |
| ------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Artifact inventory                    | Complete                                                | 58 screen frames and page/component/widget IDs recorded below                                                    |
| Independent structural inspection     | Complete                                                | Source links resolve; final graph/font/binding/overflow and measured color-pair results recorded below           |
| Rendered inspection/model walkthrough | Complete; reported defects repaired                     | 58 screens reviewed; nine focused repair/library renders rechecked                                               |
| Repository delivery checks            | Build, fresh full test retry and document checks passed | `pnpm build`; 2,150 tests across 14 packages; eight document assertions; targeted Prettier and whitespace checks |
| Human redesign approval               | **Pending**                                             | Operator, date, exact revision/node set and approval reference required                                          |
| Prototype/accessibility behavior      | Pending #1018                                           | Actual focus, keyboard, clipboard, transitions and walkthrough evidence                                          |
| CP runtime/OS acceptance              | Pending implementation children                         | Executable CP-01–CP-23 evidence and real OS service validation                                                   |

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

`OMS / Primitives` (`VariableCollectionId:23:384`) holds color values.
`OMS / Semantic` (`VariableCollectionId:23:385`) has 18 semantic color roles,
including the added `oms/border/control`, and aliases primitive values by role.
Existing spacing/radius definitions are reused, with missing sizes added. The
archived sample collection is retained to avoid breaking old references.

| Role                                        | Semantic variable                                                        | Value / rule                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Canvas / surface / elevated / muted surface | `oms/bg/default`, `oms/bg/surface`, `oms/bg/elevated`, `oms/bg/muted`    | `#09090b`, `#18181a`, `#1c1c1f`, `#27272a`                                            |
| Primary / secondary text                    | `oms/text/primary`, `oms/text/secondary`                                 | `#fafafa`, `#a1a1aa`                                                                  |
| Border                                      | `oms/border/default`                                                     | `#3e3e42`                                                                             |
| Meaningful control boundary                 | `oms/border/control`                                                     | `#71717a`; default input outlines; focus/error keep their corresponding state strokes |
| Filled primary action / focus               | `oms/interactive`, `oms/focus`                                           | `#1d4ed8`, `#93c5fd`                                                                  |
| Information                                 | `oms/info/bg`, `oms/info/text`                                           | `#172554`, `#93c5fd`                                                                  |
| Verified success                            | `oms/success/bg`, `oms/success/text`                                     | `#052e16`, `#4ade80`                                                                  |
| Warning / unresolved outcome                | `oms/warning/bg`, `oms/warning/text`                                     | `#422006`, `#facc15`                                                                  |
| Failure / destructive consequence           | `oms/danger/bg`, `oms/danger/text`                                       | `#450a0a`, `#f87171`                                                                  |
| Spacing                                     | `spacing/0`, `/4`, `/8`, `/12`, `/16`, `/20`, `/24`, `/32`, `/40`, `/48` | Shared gaps and padding in pixels                                                     |
| Radius                                      | `radius/0`, `/6`, `/8`, `/12`, `/16`                                     | Controls 6, panels 8, overlays 12; documentation may use 16                           |
| Control / target size                       | `size/control`, `size/target` and button wrapper sizing                  | 44px controls and target envelope; wraps the reused library button without overflow   |
| Dialog elevation                            | `OMS/Elevation/Dialog` effect style                                      | 0 / 16 / 48 shadow, black at 40%                                                      |

The product zinc surfaces follow the existing runtime reference. Filled primary
actions intentionally change the runtime reference `#3b82f6` to `#1d4ed8` for
small-text contrast. Essential muted metadata uses `#a1a1aa`, rather than the
older `#71717a`. These are proposed visual implementation changes; runtime CSS
has not changed. The border uses the runtime subtle-border value `#3e3e42`,
rather than the muted surface `#27272a`. Reused button wrappers were increased
from the initial 40px control baseline to 44px after a 2px overflow was identified.
Default inputs use the separate `oms/border/control` value `#71717a`; focus and
error states retain their respective strokes. The target is 4.5:1 normal text
and 3:1 large text and meaningful control/focus boundaries.

| Measured token pair                       | Contrast ratio |
| ----------------------------------------- | -------------- |
| Primary text / surface                    | 16.99:1        |
| Secondary text / surface                  | 6.92:1         |
| Button text / primary fill                | 6.42:1         |
| Warning text / warning background         | 9.52:1         |
| Danger text / danger background           | 5.84:1         |
| Information text / information background | 8.15:1         |
| Control stroke / surface                  | 3.67:1         |

These are measured token-pair results. They do not establish complete
accessibility conformance for every rendered state, opacity, focus treatment or
interaction. #1018 and implementation verification retain those checks.

| Style                                            | Font / size / line height       | Use                             |
| ------------------------------------------------ | ------------------------------- | ------------------------------- |
| `Tailwind copy/text-sm/leading-5/font-normal`    | Inter Regular, 14 / 20          | Body and controls               |
| `Tailwind copy/text-sm/leading-5/font-semibold`  | Inter Semi Bold, 14 / 20        | Emphasis and control labels     |
| `Tailwind copy/text-2xl/leading-8/font-semibold` | Inter Semi Bold, 24 / 32        | Area titles                     |
| `Sample/Operational command`                     | JetBrains Mono Regular, 13 / 20 | Commands, paths, IDs and logs   |
| `OMS/Display`                                    | Inter Semi Bold, 36 / 44        | Documentation covers            |
| `OMS/Section`                                    | Inter Semi Bold, 18 / 26        | Panels and confirmations        |
| `OMS/Caption`                                    | Inter Regular, 12 / 18          | Secondary labels and timestamps |
| `OMS/Metric`                                     | Inter Semi Bold, 32 / 40        | Metric values                   |

Connection, process, health, work and command outcome are separate state axes.
Pair state colors with labels and timestamps. A disabled action requires a
readable adjacent reason; tooltip-only explanations are insufficient. Focus is
an explicit 2px ring with offset, with actual keyboard and screen-reader behavior
assigned to #1018.

At 1440px, navigation is 216px wide and content uses 32px gutters. At 1024px,
navigation moves into a top bar and grids/tools wrap. At 390px, rows become
stacked cards, identity and environment stay together, and controls remain
reachable. Narrow dialogs have 16px outside gutters and scrollable bodies;
title/close and actions must stay reachable. Long paths wrap in detail. Logs and
tables may use explicitly named overflow regions; critical text cannot silently
clip. The 390px frames represent vertical compositions, not proof that every
section fits a single viewport.

## Component inventory and proposed code mapping

Figma names are inspectable design assets. The code names here are proposed
frontend boundaries, not existing exports, generated code or Code Connect
mappings. Reuse of shipped `Button`, `Badge` and related frontend patterns must
preserve the separate fleet-service package boundary.

| Figma component                                                                                      | Definition / properties                                                                                                          | Proposed code name      |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| [Component/Button](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=25-424)               | Kind: Primary/Secondary/Destructive; State: Default/Hover/Focus/Disabled/Loading; editable label; wraps existing shadcn instance | `Button`                |
| [Component/Field](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=25-450)                | State: Default/Focus/Disabled/Error/Loading; Label/Value/Hint                                                                    | `TextField`             |
| [Component/Search](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=25-451)               | Editable search label/value; field-based composition                                                                             | `SearchField`           |
| [Component/Select](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=25-455)               | Editable label/value; option behavior deferred to C14                                                                            | `SelectField`           |
| [Component/Badge](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-382)                | Tone: Neutral/Info/Success/Warning/Danger; Label                                                                                 | `StatusBadge`           |
| [Component/NavigationItem](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-391)       | State: Default/Selected/Focus/Disabled; Label                                                                                    | `PrimaryNavigationItem` |
| [Component/Tab](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-400)                  | State: Default/Selected/Focus/Disabled; Label                                                                                    | `DetailTab`             |
| [Component/DataCell](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-401)             | Label/Value                                                                                                                      | `ObservationCell`       |
| [Component/Metric](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-404)               | Label/Value/Caption                                                                                                              | `MetricCard`            |
| [Component/TimelineItem](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-408)         | Label/Value                                                                                                                      | `TimelineItem`          |
| [Component/Notice/Info](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-415)          | Title/Body; information                                                                                                          | `Notice`                |
| [Component/Notice/Warning](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-418)       | Title/Body; warning or uncertainty                                                                                               | `Notice`                |
| [Component/Notice/Danger](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-421)        | Title/Body; error                                                                                                                | `Notice`                |
| [Component/Notice/Success](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-424)       | Title/Body; verified success                                                                                                     | `Notice`                |
| [Component/EmptyState/Neutral](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-427)   | Title/Body; successful empty state                                                                                               | `EmptyState`            |
| [Component/LoadingState/Neutral](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-430) | Title/Body; data pending                                                                                                         | `LoadingState`          |
| [Component/Dialog](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=26-433)               | Title/Body and nested Cancel/Stop buttons; confirmation contract                                                                 | `ConfirmationDialog`    |

## Widget contracts and traceability paths

All timestamps describe observations or records, not browser guesses. Connection
freshness uses Control Plane receipt time; agent observation time is displayed
separately and cannot extend liveness. UI intent addresses registered opaque
project/environment identities, never an arbitrary remote folder or executable.
Widgets display aggregate projections and durable command records; the
orchestrator retains work/retry authority.

| Widget / proposed code name                                                                                                                                                                                                       | Owner and inputs                                                                                                | State, freshness and disabled reasons                                                                             | Operator intent                                                                            | Components                               | Consumer                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------- | ----------------------- |
| [Widget/EnvironmentRow/Wide](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-372)<br>[Widget/EnvironmentRow/Narrow](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-411); proposed `EnvironmentRow` | Registry/agent transport: name, nullable host/OS/version, connection, project count, last authenticated contact | Pending/enrolled/online/offline/revoked; no invented host metadata; contact freshness uses server receipt         | View environment or reopen connection; no lifecycle intent                                 | DataCell, Button                         | #1019                   |
| [Widget/ProjectRow/Wide](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-392)<br>[Widget/ProjectRow/Narrow](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-430); proposed `ProjectRow`             | Project projection: environment-qualified identity, connection, process, work, observedAt                       | Fresh/stale/offline/invalid/unmanaged; historical work remains labeled; disconnect never means stopped            | Open project; registered project identity only                                             | DataCell, Button                         | #1020                   |
| [Widget/ConnectionCard](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-449); proposed `ConnectionCard`                                                                                                            | Registry/agent transport: current connection, host/version and last authenticated contact                       | Enrolled/awaiting signal differs from online; project readiness and count independent                             | Inspect environment                                                                        | Badge, DataCell                          | #1019                   |
| [Widget/SetupPanel](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-480); proposed `SetupPanel`                                                                                                                    | Enrollment issuance session: configured origin, OS, issuance/expiry, pending/enrolled and one-session token     | Waiting/expired/reopened/resume; never recover old token or regenerate an enrolled identity implicitly            | Copy setup/token; regenerate pending token; resume setup using saved identity              | Select, Button, Notice, operational text | #1019; host setup #1017 |
| [Widget/CommandProgress](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-496); proposed `CommandProgress`                                                                                                          | Durable command: commandId, operation/target, state, submittedAt, original claimedAt, resultAt and evidence     | Accepted/executing/terminal/expired/unknown; 30s claim and 60s execution deadlines; process time separate         | Inspect record; no duplicate submission from progress                                      | Badge, TimelineItem, Notice              | #1021                   |
| [Widget/RecoveryPanel](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-508); proposed `RecoveryPanel`                                                                                                              | Durable command and audit: unknown outcome, last evidence, required reason, closure actor/time                  | Unknown and closed-unresolved; no Retry; closure preserves unknown; new command still needs online/process checks | Inspect host evidence, review closure and confirm separately                               | Notice, TimelineItem, Field, Button      | #1021                   |
| [Widget/RuntimeMetrics](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-527); proposed `RuntimeMetrics`                                                                                                            | Current aggregate observations: fresh running, active work and stale/offline totals                             | Freshness-qualified totals; stale observations excluded from running count; no global scheduler authority         | Display only                                                                               | Metric                                   | #1020                   |
| [Widget/HistoryPanel](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-540); proposed `HistoryPanel`                                                                                                                | Known project run summaries: run identity, local timestamp/status and diagnostics                               | Empty/loading/recent/historical; maximum 100 cached summaries; read failures are explicit                         | Inspect known run; no issue retry/cancel                                                   | TimelineItem, text styles                | #1022                   |
| [Widget/LogPanel](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=27-548); proposed `LogPanel`                                                                                                                        | Bounded read lane: known project/run/stream, request state, cursor/generation, text and fetchedAt               | Following/paused/reset/offline/unavailable; 256 KiB chunks, 30s read lifetime; fetched content stays historical   | Choose run/stream, pause/follow, request read or reset cursor; offline disables fresh read | Select, Badge, Button, mono text         | #1022                   |

Use the following path keys in the frame inventory. Each path ends in the shared
semantic colors, text styles and geometry above. Direct empty/loading/diagnostic
compositions use feedback component instances without introducing a domain
widget solely for wrapping them. Modal shells preserve the page context and use
the documented Dialog contract plus reusable fields, buttons and notices.

| Path     | Screen → widget → component → foundation                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ENV      | Environment screen → EnvironmentRow / ConnectionCard / SetupPanel as applicable → DataCell, Select, Button, Badge, Notice, Field → OMS roles, copied type styles, shared geometry |
| PROJ     | Fleet screen → ProjectRow and RuntimeMetrics → DataCell, Metric, Button; Search/Select/Notice → OMS roles, type styles, shared geometry                                           |
| DETAIL   | Project detail → HistoryPanel and CommandProgress → TimelineItem, Badge, Notice; DataCell/Tab/Button → OMS roles, type styles, shared geometry                                    |
| CMD      | Command state → CommandProgress / RecoveryPanel as applicable → TimelineItem, Badge, Notice, Field, Button; Dialog contract → OMS roles, type styles, shared geometry             |
| LOG      | Run/log state → HistoryPanel / LogPanel as applicable → TimelineItem, Select, Badge, Button; operational text → OMS roles, mono style, shared geometry                            |
| FEEDBACK | Empty/loading/error state → direct EmptyState / LoadingState / Notice and applicable Button → OMS roles, type styles, shared geometry                                             |

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

These cases distinguish completed artifact inspection and repository checks from
remaining interaction/runtime work. All 58 screens were reviewed through 15
contact sheets and seven original-size renders; the reported findings were
repaired in the live file. Focused review of the repaired frames and final structural inspection also passed.

| ID                             | Procedure and passing result                                                                                  | Current evidence / result                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01 Archive and reuse          | Resolve original IDs; inspect archive structure and Tailwind reuse provenance                                 | Source IDs resolve; eight original top-level archive nodes, `3:52` with 471 descendants and `13:154` with 484. Eight Tailwind pages and copied styles/spacing/button reuse verified. No byte-identity baseline claim                    |
| D02 Foundation/component graph | Resolve instances/variants; inspect bindings, fonts, auto-layout, contrast and disabled reasons               | Shared assets inventoried; 18 semantic color roles and token-pair contrast recorded. 2px button-wrapper overflow repaired with 44px controls. Final inspection: no broken instances, missing fonts, image fills or containment overflow |
| D03 Enrollment matrix          | Distinguish waiting/enrolled/zero-project success/reopen/regeneration/resume                                  | Full screen review completed; create copy repaired to avoid premature saved/keep claims, revoke target repaired to studio-mac. Focused repairs re-rendered and checked; actual transitions remain #1018/#1019                           |
| D04 Freshness matrix           | Check historical state, fresh-only totals, timestamps and action reasons                                      | Full review completed; filtered rows/paging and totals aligned, stale/unmanaged metrics made historical, mobile active/stale metrics restored. Focused repairs re-rendered and checked                                                  |
| D05 Lifecycle/recovery         | Check stop impact, accepted versus verified exit, original deadlines, no Retry and audited unresolved closure | U05/U06 states reviewed; project detail command history repaired to avoid an outstanding-command/active-action contradiction. Runtime command safety remains implementation evidence                                                    |
| D06 Layout/log edge cases      | Inspect 1440/1024/390 long content, reachable controls and distinct log recovery states                       | All 58 frames reviewed; compact environment control width repaired; rotation now awaits explicit reset; missing/expired reads retain target selectors. Focused repairs re-rendered and checked                                          |
| D07 Handoff and delivery       | Verify traceability, patch metadata, docs checks, unit tests and approval provenance                          | All 58 links, U01–U08, CP-01–23 and patch metadata present; eight document assertions, targeted Prettier, whitespace, build and fresh full unit retry passed. Human approval pending                                                    |

Recorded review repairs:

- Create environment no longer claims the record is already saved or offers
  “keep” copy before creation; revoke confirmation names the same `studio-mac`
  target as the underlying inventory.
- Local registration uses positional `gh-symphony agent project add <prepared-folder>` syntax. Filtered fleet rows and pagination agree, and totals
  match the displayed observations. Stale and unmanaged process/work data is
  explicitly historical. The mobile fleet includes Active work and Offline /
  stale metrics.
- Project detail shows a historical succeeded command when lifecycle actions are
  enabled, and stopped detail shows zero active work. This removes a visual
  contradiction between an outstanding command and an enabled Stop action.
- Log rotation indicates reset is pending and exposes an explicit reset action.
  Missing-file and expired-read views retain their run/stream target selectors.
- The compact environment control width and button-wrapper overflow were
  repaired; controls are 44px. Footer/context uses “Private workspace · Single
  operator.”

Final delivery verification record (2026-10-05):

- Structural inspection: 16 new pages, 3,922 nodes, 2,264 text nodes, 1,137
  instances, 56 component definitions, five component sets and 1,636 auto-layout
  nodes inspected. 3,917 nodes have variable bindings and 2,259 text nodes use
  text styles. A small number of local text overrides remain inspectable and
  editable; this is a binding inventory, not a claim of 100% style binding. No broken
  instance references, missing fonts, image fills or visible child containment
  overflow were found (0.75px tolerance; component-set placement excluded).
  Archive structure and source references resolve as recorded above.
- Rendered review: all 58 screens inspected via 15 contact sheets and seven
  original-size renders. Findings repaired live and nine focused renders rechecked: library page
  `23:374`, create `29:466`, revoked `29:1439`, unmanaged `31:2366`, rotation
  `31:3160`, missing/expired reads `31:3244` / `31:3277`, compact environments
  `29:1600` and mobile fleet `31:915`. Transparent library specimens now use a
  dark canvas background. This is model/static review, not human or runtime
  evidence.
- Document checks: eight assertions passed for all 58 screen links, all 23 CP
  rows, all seven design TCs, absence of generation placeholders, source/plan
  existence, explicit pending approval, patch metadata and exact frame count.
  Targeted `pnpm exec prettier --check` and `git diff --check` passed, including
  the final one-file formatting check for this evidence update.
- Build: `pnpm build` passed.
- Mandatory unit tests: the initial full `pnpm test` run hit a timeout in the
  existing `hooks.test.ts` large-stdout test. Its focused retry passed 12/12; a
  fresh full retry passed **2,150 tests across 14 packages**. No runtime code was
  changed to obtain the passing retry.
- `docs/symphony-spec.md` preservation: no upstream-spec edit is part of this
  delivery; `git diff HEAD -- docs/symphony-spec.md` returned no changes.
- Runtime/Docker/OS tests: not needed for this design/documentation-only change
  and not executed. Implementation children own applicable `AGENT_TEST.md` gates
  and all CP runtime/OS evidence.
- Independent final branch review: `ce905860..0ad5358b` was reviewed against the
  approved specification, screen inventory, structural evidence and test logs.
  No Critical or Important findings remain. One minor precision improvement is
  deferred to #1018: narrow each frame's CP references from the current area-level
  set to its exact state-specific subset. The separate CP matrix is the current
  authoritative coverage classification.
- Review limits accepted: prototype/keyboard/clipboard behavior belongs to
  #1018; runtime fencing, durability, logs and OS services belong to implementation
  children. This final branch pass supplements the separate full visual review;
  it does not provide human approval.
- Operator approval: **Pending**; no approver, revision or approval reference yet.

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
