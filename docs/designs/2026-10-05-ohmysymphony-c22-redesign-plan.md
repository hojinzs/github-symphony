# OhMySymphony C22 redesign implementation plan

- **Status:** In progress — visual direction reopened; three Projects samples ready for selection
- **Symphony Layers:** Configuration, Integration, Observability (cross-layer presentation contracts)
- **Tracking:** [#1026](https://github.com/hojinzs/github-symphony/issues/1026), [Epic #983](https://github.com/hojinzs/github-symphony/issues/983)

> For agentic workers: use superpowers:executing-plans to execute this plan task by task after the user initiates execution.

**Active Goal:** Deliver a reusable, editable OhMySymphony visual system and redesigned operator screens in the existing Figma file, with scenario traceability, verification evidence and operator approval, ready for #1018 and subsequent UI implementation.

**Architecture:** This is the presentation design of the repository-local management plane above Symphony. Preserve the approved Control Plane → Management Agent → per-project orchestrator boundaries; introduce no scheduling or execution behavior. Build screens from widgets, widgets from component instances, and components from shared foundations.

**Tech stack:** Figma variables, styles, components, variants and auto-layout; Markdown handoff; CLI patch changeset; pnpm repository checks. No frontend implementation in C22.

**Spec:** [Approved delivery through #984 / PR #982](https://github.com/hojinzs/github-symphony/issues/984), [management-plane design](https://github.com/hojinzs/github-symphony/blob/main/docs/designs/2026-10-04-control-plane-management-agents-design.md), and read-only [upstream spec](../symphony-spec.md), especially sections 2 and 3.

## Findings and evidence limits

Inspection on 2026-10-05 established:

- #1026 is open. Its native blocked-by relationship points to closed #984; its native blocking relationships point to #1018–#1022. Backend dependencies remain separately binding.
- The planning checkout was `dcfcaffc` (PR #981) and lacked the management-plane design document. Its contents were read from GitHub main for this analysis. Start execution from a revision containing merged #982; do not reconstruct an old copy or overwrite the checkout during planning.
- The remote design header still says Draft, whereas #984's latest completion section explicitly records operator approval and merge. Preserve that provenance and reconcile status/link metadata during delivery without rewriting approved behavior.
- [OhMySymphony](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e) currently exposes one page, `0:1`, named `01 · Spec validation samples`. Board `13:154` contains six 1440px views: environment list, create, Linux waiting, macOS waiting, connected, and expired/reopened. Metadata confirms editable text and instances, but does not prove rendering, variables, accessibility or complete state coverage.
- The copied [Tailwind library](https://www.figma.com/design/Bg9Hb0nSo97A4eNHqeApwk) currently exposes only `Welcome` (`1:1180`) through metadata. The earlier design document reports eight pages and hundreds of styles. This discrepancy needs asset/access inspection; it does not prove the assets were deleted.
- Existing runtime references include `packages/control-plane/client/src/index.css`, `components/Button.tsx`, `components/Badge.tsx`, and `pages/FoundationsPage.tsx`. They use Inter, JetBrains Mono, dark surfaces and semantic colors. They are a reuse/alignment reference, not authorization to turn the existing per-project server into the fleet service.

## Global constraints

- Keep the existing Figma file and Dani Works / OhMySymphony folder. Archive decision samples with their links intact.
- One operator, private network, Linux/macOS, already prepared projects. No available Docker deployment, login/OIDC, public deployment, provisioning, bulk lifecycle or global scheduler controls.
- Keep Projects as the landing area and Projects / Environments / Commands as primary navigation. Runs/logs have a dedicated design page but need not become a new primary navigation item.
- Preserve 1440px desktop, Inter UI and monospaced operational text. The operator's theme-change request reopens the earlier dark-only constraint for the three candidate directions; apply the selected palette only after explicit selection. Use synthetic credentials only.
- C22 defines visual states and accessibility contracts; #1018 validates detailed prototype transitions, focus/keyboard behavior and walkthroughs. Runtime and OS validation belongs to implementation children.
- Preserve `docs/symphony-spec.md`. The management plane is an explicit repository extension; no new upstream divergence is proposed.
- Delivery requires a CLI patch changeset even though this is design/documentation work. Do not add that release claim for the planning artifact alone.

## Review focus

1. Enrollment without first signal must not look connected; connected with zero projects must look successful (T4, D03).
2. Lost freshness must not imply stopped, nor contribute to fresh running totals (T4, D04).
3. Accepted commands and unknown outcomes must not imply success or invite blind replay (T4, D05).
4. Long paths, diagnostics, commands and timestamps must remain usable at reduced width (T3/T4, D06).
5. Library reuse and archive preservation must not leave broken instances or invisible token dependencies (T1/T3, D01/D02).

## Deliverable files

| Artifact                                                                            | Responsibility                                                                                      |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Existing Figma file                                                                 | Archive, foundations, components, widgets, screens and review index                                 |
| `docs/designs/2026-10-05-ohmysymphony-c22-design-handoff.md` (new during execution) | Inventory, node links, token/component naming, contracts, scenario matrix, evidence and C14 backlog |
| `docs/designs/2026-10-04-control-plane-management-agents-design.md`                 | Minimal design links, status provenance and scenario references                                     |
| `docs/README.md`                                                                    | Index the plan and handoff as appropriate                                                           |
| `.changeset/ohmysymphony-c22-redesign.md`                                           | `@gh-symphony/cli: patch` for completed design delivery                                             |

No runtime package changes are planned. Update README/configuration/architecture living docs only if their described behavior or ownership actually changes; such expansion requires revisiting C22 scope.

## T1 — Baseline inventory and archive

Consumes the approved scenario inventory U01–U08 and CP-01–CP-23. Produces stable source-node and reuse inventories for T2–T4.

- [x] Use a checkout containing #982; confirm clean starting state and current native dependencies.
- [x] Inspect local and subscribed components, styles, variables, fonts and the copied Tailwind assets; resolve the Welcome-only discrepancy before choosing reuse versus local definitions.
- [x] Record source IDs and rename the existing sample page `90 Archive / Decision prototypes`, preserving its nodes and links.
- [x] Create a `00 Overview / Handoff` page with source references, page inventory and evidence status.
- [x] Run D01. Record asset reuse decisions and missing access explicitly. Reassess the P2/M boundary after counting the actual variants; split proposed excess scope before expanding it.

## T2 — Foundations

Consumes T1 asset inventory and existing runtime CSS. Produces shared token/style names, values and visual rules.

- [x] Create separate pages: `10 Foundation / Color and state`, `11 Foundation / Typography`, `12 Foundation / Geometry and elevation`, `13 Foundation / Layout and responsive`.
- [x] Map palette values to semantic roles for surfaces, text, borders, focus, connection, process, health and command outcome. Document intentional differences from runtime CSS and avoid equating distinct state axes.
- [x] Define Inter/monospace styles, spacing, sizing, radius, elevation and layout rules; bind supported properties to variables and use styles for unsupported bindings.
- [x] Specify readable labels alongside color, focus appearance, disabled reasons and contrast targets. Proposed review widths are 1440, 1024 and 390px; document reflow, table overflow and modal scrolling rather than silently dropping essential data.
- [x] Run D02 and review a representative environment row and recovery panel using the foundations before broad screen composition.

## T3 — Components and widgets

Consumes T2 foundations. Produces reusable instance-based building blocks and inspectable contracts.

- [x] Create `20 Components / Controls`, `21 Components / Navigation and data`, `22 Components / Dialogs and feedback`.
- [x] Inventory buttons, fields, search/select, tabs, badges, navigation, cells/rows, dialogs and feedback. Record supported properties and applicable default/hover/focus/disabled/loading/error variants; avoid an unnecessary Cartesian product.
- [x] Create `30 Widgets / Environment and project`, `31 Widgets / Setup and commands`, `32 Widgets / Runtime and logs`.
- [x] Compose environment/project rows, connection/status cards, command/token panels, progress/recovery, metrics, history and log panels from component instances.
- [x] Name assets consistently, e.g. `Component/Button`, `Widget/EnvironmentRow`, and map proposed code names separately from existing code exports.
- [x] For every widget document inputs, state axes, data owner, timestamps/freshness, emitted operator intent, disabled reasons and the consuming implementation issue. Do not invent new API contracts.
- [x] Run D02 and D06 with long operational text and disabled/error cases.

## T4 — Screen redesign and scenario coverage

Consumes T3 widgets and approved operator contracts. Produces the complete static design baseline for C14.

| Figma page                           | Owned screens and required states                                                                                                                                                     | Contract references                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `40 Screens / Environments`          | U08/U02/U03; empty/loading/error, create, Linux/macOS waiting, enrolled without signal, connected with zero projects, expired, reopened, offline/revoked, invalid/unmanaged inventory | CP-03/05/11/14/20/21; setup guidance CP-22/23 |
| `41 Screens / Projects`              | U01; populated/empty/loading/error, filters/paging, fresh versus stale totals, separate connection/process/work                                                                       | CP-01/03/05/10/17                             |
| `42 Screens / Project detail`        | U04; connection/process/health/observation, start/stop availability, missing workflow, active/retry/recent work, diagnostics and command history                                      | CP-03/05/08/13/17                             |
| `43 Screens / Commands and recovery` | U05/U06 plus command list; cancel/stop confirmation, accepted/executing/terminal/expired, unknown, required reason, second confirmation, closed-unresolved audit                      | CP-04/06/07/08/09; claim constraints CP-18/19 |
| `44 Screens / Runs and logs`         | U07; run/stream selection, loading/empty, bounded follow, rotation/truncation, offline historical content, missing-file/expired-read unavailable                                      | CP-12                                         |

- [x] Name frames `Screen/<area>/<scenario>/<width>`; compose all owning desktop states from instances.
- [x] Add representative narrow compositions for each area and annotate behavior for remaining state variants.
- [x] Build a traceability row for every frame: source scenario → screen node → widget → component → foundation → downstream owner.
- [x] Record each CP scenario as visual coverage, backend-only or deferred runtime evidence; never claim CP-01–CP-23 passed from Figma.
- [x] Run D03–D06. Keep prototype navigation, keyboard/focus and clipboard verification in the explicit #1018 handoff list.

## T5 — Verification, handoff and operator review

Consumes complete designs. Produces a reviewable delivery and actual approval evidence.

- [x] Inspect editability, instance references, variable/style bindings, auto-layout and missing fonts; render all required states and inspect overflow, overlap and hierarchy.
- [x] Write the handoff file and targeted source/index updates. Separate structural evidence, rendered/model review, human approval and future runtime checks.
- [x] Add the CLI patch changeset. Run document link/format/whitespace checks and mandatory `pnpm test` on the delivery revision. If runtime code is added, revisit scope and run all AGENT_TEST.md gates plus applicable Docker E2E.
- [ ] Present the exact reviewed Figma nodes/revision and remaining C14 checks to the operator. Record actual approval with date/reference; do not infer it from automated checks or earlier #984 approval.
- [ ] Mark delivery complete only after all acceptance criteria, including operator approval, pass. Preserve backend blockers when handing off to #1018–#1022.

## Design test cases

| ID  | Check                      | Passing result                                                                                                                                                      |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01 | Archive and reuse          | Old sample IDs/links resolve; archive is distinguished; library provenance and reusable assets are inventoried                                                      |
| D02 | Foundation/component graph | Required visual properties use documented variables/styles; instances resolve; variants/fonts and text-plus-color semantics are inspectable                         |
| D03 | Enrollment matrix          | Waiting differs from enrolled-without-signal; authenticated first signal with zero projects is success; reopen exposes no old token; regeneration and resume differ |
| D04 | Freshness matrix           | Offline last-known running is historical and excluded from current running totals; actions explain why unavailable                                                  |
| D05 | Lifecycle/recovery         | Stop names target and interruption; acceptance is not verified exit; unknown has no Retry; reason plus confirmation and unresolved audit are present                |
| D06 | Layout/log edge cases      | At review widths, long text and required controls remain reachable; rotation/offline/unavailable logs are distinct from empty success                               |
| D07 | Handoff and delivery       | All U01–U08 map to owned pages; all issue acceptance criteria have evidence/owner; C14 work is explicit; patch metadata and repository checks are recorded          |

## Planning verification

The planning pass verifies scope, dependencies, source traceability and testability. D01–D07 above are future execution checks, not passed design tests. Figma was inspected read-only; no screenshots or runtime validation are claimed. This paragraph records the earlier planning phase; the execution record below supersedes its pending status.

Planning verification completed: scope/header, five task boundaries, seven design TCs, U01–U08 coverage, approval/release/upstream constraints and whitespace checks passed. Prettier passed. The fresh checkout initially lacked dependencies and internal package build outputs; after `pnpm install --frozen-lockfile` and successful `pnpm build`, mandatory `pnpm test` passed. The lockfile and upstream specification remain unchanged. These existing unit tests do not validate the future redesign.

## Execution record — 2026-10-05

The operator authorized Goal activation and execution in this Codex task. Work
uses `codex/ohmysymphony-c22-redesign`, based on `ce905860` with merged #982.
T1–T4 and the artifact/repository portion of T5 were completed for the first
candidate. The operator subsequently reopened its visual direction. These
checks preserve a useful state-coverage baseline but do not complete the revised
delivery; the revision work below and final operator approval remain required.

- T1: eight original archive top-level nodes preserved; the copied Tailwind
  file exposes all eight pages through the plugin API. Compatible styles,
  geometry variables and the shadcn button are reused.
- T2–T3: 16 new pages, semantic variables and styles, component variants and
  11 composed widgets define the presentation contract. No runtime behavior
  or upstream-spec edits were introduced.
- T4: 58 editable frames across five areas, including five 1024px and five
  390px compositions, map to U01–U08 and the CP evidence boundary.
- T5: structural and rendered checks, repair reinspection, handoff, CLI patch
  metadata, build and 2,150 unit tests passed. See the handoff for counts,
  the initial transient test timeout, repairs and limitations.

Execution rulings:

- Ruling: keep one C22 delivery — the 58 frames are state variants within the
  five approved screen areas, with no new product workflows or runtime code —
  expanding to interaction implementation would require a separate scope.
- Ruling: use static design TCs, structural inspection and rendered review for
  Figma changes, with mandatory repository unit tests — code TDD cannot prove
  a design artifact — actual interactions and runtime safety remain downstream.
- Earlier ruling: retain dark treatment for the first candidate. Superseded by
  the operator's request for three new visual directions; light candidates are
  now within exploration scope. The selected system needs fresh contrast checks.
- Ruling: change filled-primary contrast and use 44px button wrappers — the
  reused button exceeded the initial 40px wrapper — frontend implementation
  must adopt the documented token/geometry changes.
- Ruling: make Figma mutations sequential — shared variables and component
  references create dependencies — independent source and visual review were
  delegated without parallel writes to the design file.
- Ruling: keep approval explicitly pending — #1026 requires actual operator
  review — neither test results nor authorization to start closes this gate.

## Visual revision — 2026-10-05

The operator requested current research and three Projects samples because the
first visual theme did not meet their quality expectations. See the
[theme research, exact samples and verification](2026-10-05-ohmysymphony-theme-directions.md).

- [x] R1: Research recent official Linear, Attio and Vercel/Geist design changes;
      create three editable 1440 × 960 Projects samples with the same six-project
      fixture, isolated tokens/components and preserved state semantics.
- [ ] R2: Record the operator's explicit choice of A — Graphite, B — Ivory or
      C — Contrast, including any requested adjustments. Do not propagate a theme
      before this choice.
- [ ] R3: Apply the chosen direction consistently to shared foundations,
      components, widgets and all 58 required screen/state compositions, preserving
      approved behavior, responsive coverage and the original archive.
- [ ] R4: Repeat applicable D01–D07 structural/rendered checks and repository
      checks; update the dated handoff and obtain approval of the resulting full
      redesign. A sample selection alone does not complete C22.
