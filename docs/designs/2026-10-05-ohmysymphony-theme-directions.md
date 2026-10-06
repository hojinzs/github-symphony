# OhMySymphony Projects theme directions

- **Date:** 2026-10-05
- **Status:** Selected — A / Graphite; full design-system and 58-screen application approved on 2026-10-06
- **Symphony Layers:** Configuration, Integration, Observability (cross-layer presentation contracts)
- **Tracking:** [C22 #1026](https://github.com/hojinzs/github-symphony/issues/1026), [Epic #983](https://github.com/hojinzs/github-symphony/issues/983)
- **Behavior source:** [Approved management-plane design](2026-10-04-control-plane-management-agents-design.md)
- **Full-system handoff:** [C22 handoff and 58-screen inventory](2026-10-05-ohmysymphony-c22-design-handoff.md)
- **Figma:** [Selected A / Graphite (`53:490`)](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=53-490), [05 Exploration / Theme directions](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=53-368), [comparison introduction](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=58-888)

## Decision and scope

The operator found the previous C22 visual theme insufficiently polished and
requested current design research plus three Projects samples before choosing a
direction. The previous 58 screens remain behavior and state-coverage references;
their visual theme is not approved. Approval of #984's architecture is separate
from the visual-direction selection recorded below.

This exploration contains three editable 1440 × 960 Projects compositions with
the same fictional dataset. It changes presentation, not management semantics.
It records the choice of visual direction. It does not deliver a complete design
library, runtime implementation or redesign of the full file.

**The user selected A — Graphite on 2026-10-05**, referring to
[`Explore/A/Projects/1440`, node `53:490`](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=53-490).
The selection evidence is the user's exact message in the current working
conversation:

> A안으로 가자. 목표 재설정

This establishes A as the direction for the reset goal. It has now been applied across the
full foundations, components, widgets and 58-screen set; the dated
2026-10-06 verification is recorded in the full-system handoff.
The operator separately approved that resulting full-system design on
2026-10-06 with “시안 승인함.” The handoff records the reviewed `df2375cb`
revision and exact 58-screen manifest. The earlier selection by itself did not
approve the result; this later explicit confirmation does.

Configuration, Integration and Observability presentation remains separate from
orchestration authority. The management plane remains the existing
repository-local extension; this exploration adds no upstream divergence and
does not change `docs/symphony-spec.md`.

## Three sample directions

| Direction and frame                                                                                           | Composition                                                                      | Surface, typography and state presentation                                                                                                                                                                               | Evaluation emphasis                                                                            |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| [A — Graphite](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=53-490), `Explore/A/Projects/1440` | Dark sidebar and a continuous project table; compact summary and aligned columns | Warm charcoal canvas `#171819`, subdued navigation `#111213`, restrained lavender accent; Inter labels, JetBrains Mono for operational text; state text and timestamps retain their own columns                          | Fast comparison across many projects and a dense operational scan                              |
| [B — Ivory](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=53-491), `Explore/B/Projects/1440`    | Horizontal primary navigation and project cards grouped by environment           | Warm light canvas `#f4f3ef`, white cards and forest-green action color `#294838`; Inter type and deliberate breathing room; environment grouping carries connection context while process/work/freshness remain explicit | A recognizable product identity and clear ownership of projects by host                        |
| [C — Contrast](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=53-492), `Explore/C/Projects/1440` | Dark sidebar, white workspace, project list and selected-project preview         | Strong monochrome structure, restrained blue selection `#0068d4`, fine separators; Inter labels with JetBrains Mono operational details; preview keeps the selected entity's context visible                             | Inspecting one project while preserving fleet context; preview width trades against list width |

During the comparison, the model recommended **B — Ivory** for visual identity,
identified **A — Graphite** as the strongest option for compact cross-project
scanning, and described C as an inspection workspace. These were earlier review
opinions. The user's subsequent explicit selection of **A — Graphite** is the
decision to carry forward; B and C remain comparison references.

The differences are structural as well as chromatic: continuous table,
environment-grouped cards, and list plus preview. All three retain Projects,
Environments and Commands as primary destinations and the private-network,
single-operator context. They add no project provisioning, bulk lifecycle
control, force kill, login or global scheduling surface.

## Research sources and interpretation

Research was checked on **2026-10-05** using the products' official sources.
Publication dates below are source dates; undated design references are marked
as such. The samples adapt useful visual principles to OhMySymphony. They do not
copy product themes, exact source tokens or layouts, and the references do not
establish a proven market-wide trend.

| Official source                                                                                                                                                                                               | Publication date            | Observed source principle                                                                                                                  | Interpretation in this exploration                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Linear: A calmer interface for a product in motion](https://linear.app/now/behind-the-latest-design-refresh), [UI refresh changelog](https://linear.app/changelog/2026-03-12-ui-refresh)                     | 2026-03-12                  | Lower navigation prominence, consistent location/view controls, fewer separators and warmer gray while preserving information density      | A uses a receding sidebar, continuous table and quiet hierarchy. Its exact colors and row composition are local choices                                                                           |
| [Attio: Record page redesign](https://attio.com/changelog/2026/record-page-redesign)                                                                                                                          | 2026-05-28                  | Keep identity, key information and primary actions together; adjustable detail/list density; reduce activity noise                         | B prioritizes readable identity and grouped context, with lighter surfaces and clear spacing. The ivory/green palette and horizontal navigation are local interpretations                         |
| [Attio: A refreshed sidebar](https://attio.com/changelog/2026/a-refreshed-sidebar)                                                                                                                            | 2026-08-25                  | Give Search and frequent workflows clear, direct places in navigation                                                                      | Supports making high-use navigation immediately identifiable; it does not prescribe B's horizontal layout                                                                                         |
| [Attio: Create and manage table views](https://attio.com/help/reference/managing-your-data/views/create-and-manage-table-views)                                                                               | Undated; checked 2026-10-05 | Organized data columns, filtering/sorting and record preview without losing the table                                                      | Informs clear project attributes and context-preserving inspection; CRM bulk mutation behavior is not adopted                                                                                     |
| [Vercel: New dashboard redesign is now the default](https://vercel.com/changelog/dashboard-navigation-redesign-rollout)                                                                                       | 2026-02-26                  | Consistent team/project navigation and a resizable, hideable sidebar                                                                       | C uses a stable side navigation and explicit workspace/project context; no new runtime navigation behavior is claimed                                                                             |
| [Geist colors](https://vercel.com/geist/colors), [typography](https://vercel.com/geist/typography), [badge](https://vercel.com/geist/badge), [web interface guidelines](https://vercel.com/design/guidelines) | Undated; checked 2026-10-05 | Separate background/border/text roles; compact text hierarchy; aligned numerical comparisons; short status labels with redundant text cues | C uses role-based monochrome surfaces and precise operational typography. All directions keep textual state meanings. Existing Inter/JetBrains Mono are retained rather than adopting Geist fonts |

## Identical comparison fixture

All values are fictional design data. The same six projects and three
environments appear in every sample. A different grouping or preview does not
change their state or include stale observations in current totals.

| Project                | Environment  | Connection | Process            | Work                 | Observation      |
| ---------------------- | ------------ | ---------- | ------------------ | -------------------- | ---------------- |
| `api-platform` (AP)    | `lab-linux`  | Online     | Running            | 2 active; 1 retrying | 12:42:16; 5s ago |
| `github-symphony` (GS) | `studio-mac` | Online     | Running            | 1 active; no retries | 12:42:13; 8s ago |
| `web-console` (WC)     | `studio-mac` | Online     | Stopped            | No active work       | 12:42:13; 8s ago |
| `payments-worker` (PW) | `lab-linux`  | Online     | Running            | 3 active; no retries | 12:42:16; 5s ago |
| `docs-site` (DS)       | `build-host` | Offline    | Last known running | 1 active, historical | 12:34:21; 8m ago |
| `sandbox-tools` (ST)   | `build-host` | Offline    | Last known stopped | No work, historical  | 12:34:21; 8m ago |

The shared summary is **Running 3 · Active runs 6 · Offline projects 2**.
Running means freshly observed running projects. Active runs is `2 + 1 + 3`;
the historical active run on `docs-site` and the separately reported retry are
excluded. Offline projects counts projects, not environments: both belong to
the one offline `build-host`.

Connection, process, work and observation freshness remain distinct. Offline
does not imply stopped, and historical running/work does not become current
because it is visible in a card or preview. Project identity stays paired with
environment identity. This selection exercise preserves the approved lifecycle
and enrollment contracts, including accepted versus verified command outcome,
no blind Retry for unknown commands, and registration versus first-signal
connection. Those flows are not implemented or revalidated by these three
Projects samples.

## Editable construction and isolation

The exploration uses new C22 exploration token collections
`VariableCollectionId:53:369` and `VariableCollectionId:53:370`, plus controls
and compositions isolated to the exploration page. Shared Inter and JetBrains
Mono text styles and compatible geometry definitions are reused. Exact design
names are not claims of generated code, Code Connect mappings or a published
library.

| Sample       | Isolated exploration asset group                                             | Final screen-root audit (including root)                      |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| A — Graphite | [54:368](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=54-368) | 275 nodes; 106 text nodes; 29 instances; Inter/JetBrains Mono |
| B — Ivory    | [55:555](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=55-555) | 262 nodes; 92 text nodes; 28 instances; Inter                 |
| C — Contrast | [56:733](https://www.figma.com/design/vUCdtVjmYMNWv7YYLRdo3e?node-id=56-733) | 280 nodes; 105 text nodes; 26 instances; Inter/JetBrains Mono |

The final structure inspection found zero missing fonts, broken instance
references, image fills or visible child containment overflow in all three
screens and their comparison annotations. All 83 screen instances resolved to
main components. The samples contain real editable text and vector icons;
they are not whole-screen image imports. Each final 1440 × 960 render was then
visually inspected for hierarchy, required labels, clipping and overlap.

## Acceptance test cases and evidence

| ID                           | Test case and passing condition                                                                                                                   | Evidence / status                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| T01 Editable comparison set  | Three distinct, editable 1440 × 960 frames exist on the exploration page, with actual text and reusable instances                                 | Passed: exact roots, dimensions, text and instance counts verified                                                                   |
| T02 Identical fixture        | Each frame presents all six identical projects across the same three environments; summary is 3 running, 6 active runs and 2 offline projects     | Passed: extracted text and final renders match the fixture and arithmetic above                                                      |
| T03 State integrity          | Connection/process/work/freshness are distinguishable; offline rows retain last-known/historical labels and are excluded from running/work totals | Passed: per-project state labels, B's environment connection headers and all summary qualifiers checked                              |
| T04 Rendering and references | No overflow, clipping, missing fonts, broken instances or image fallback obscures required content                                                | Passed: zero structural failures; all three post-fix renders reviewed                                                                |
| T05 Source traceability      | Directions identify direct official sources, exact known publication dates and local adaptations                                                  | Source inventory completed; undated references marked with check date                                                                |
| T06 Selection boundary       | No whole-file theme propagation occurs before explicit user selection; prior visual candidate is not treated as approved                          | Selection received on 2026-10-05 for A (`53:490`); full-system/58-screen application and explicit final approval recorded 2026-10-06 |

Final verification record:

- Initial authoring structure: three 1440 × 960 editable samples; zero detected
  overflow and missing fonts in each recorded authoring result.
- Final post-fix rendered review and T01–T04 verification: **Passed** on
  2026-10-05. B's environment filter and singular run label, freshness
  qualifiers and internal navigation chevrons were corrected before final
  render review. Static checks do not prove runtime or keyboard behavior.
- Independent visual review confirmed the three distinct compositions; the
  final Ivory summary caption was shortened to restore spacing between metrics.
- Document formatting, local link/metadata assertions and whitespace checks:
  passed for this revision.
- Repository regression: fresh `pnpm test` passed, **2,150 tests across 14
  packages**, with no retry needed. This exploration introduces no runtime code;
  unit tests do not validate Figma interactions. No new Docker, OS-service or
  accessibility behavior verification is claimed.
- User direction selection: **A — Graphite selected** on 2026-10-05, node
  `53:490`; exact user message: “A안으로 가자. 목표 재설정”.
- Full design-system and 58-screen application: **Complete**, 2026-10-06; see the updated handoff for verification.
- Final redesign approval: **Approved**, separately confirmed by the operator
  with “시안 승인함.” on 2026-10-06; reviewed revision `df2375cb` and the
  58-screen manifest are recorded in the handoff.

The selected A direction is now applied across the full visual system and
58-screen coverage under the reset Goal. The [full-system handoff](2026-10-05-ohmysymphony-c22-design-handoff.md)
records the resulting 2026-10-06 design, verification and actual final operator
approval. This exploration record preserves the earlier choice independently
of that later full-system approval.
