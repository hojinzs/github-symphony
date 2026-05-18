# ADR: Explicit Dispatch Priority Mappings (GitHub Project V2)

- **Date**: 2026-05-18
- **Status**: Proposed
- **Related Issues**: #236 (parent), child issues split per §11
- **Related Spec**: `docs/symphony-spec.md` §11 (Reconciliation → Sort → Dispatch), §5.1 (`WORKFLOW.md` ownership). This ADR does **not** modify the upstream spec.
- **Related ADRs**:
  - `docs/adr/2026-03-19_github-project-v2-state-filtering-cache.md` (GitHub Project V2 adapter constraints)
  - `docs/adr/2026-05-04_single-repo-orchestrator.md` (`tracker.*` config shape direction)
- **Related Analysis**: `docs/spec-gap-analysis.md` lines 19, 133 (priority effectively always `null` on GitHub today)

> **Scope marker.** This is a **repository-local extension / implementation choice** for the GitHub Project V2 tracker adapter. The upstream Symphony specification (`docs/symphony-spec.md`) treats `priority` as a tracker-provided numeric attribute consumed by the dispatch sort; it does not prescribe how a tracker without a native priority concept derives that number. GitHub issues/Projects have no first-class priority. This ADR defines how github-symphony derives `TrackedIssue.priority` from explicitly configured `WORKFLOW.md` mappings. Nothing here edits `docs/symphony-spec.md`; divergence is documented per the repo's Spec Discipline.

---

## 1. Context

`TrackedIssue.priority: number | null` (`packages/core/src/contracts/tracker-adapter.ts`) feeds the dispatch ordering in `sortCandidatesForDispatch` (`packages/orchestrator/src/service.ts:3452`): **priority ascending (null last) → `createdAt` ascending → identifier**. Lower numeric value = higher dispatch precedence.

Today the only GitHub priority source is the flat front-matter key `tracker.priority_field: <name>`:

- Parsed in `packages/core/src/workflow/parser.ts` into `parsed.tracker.priorityFieldName` / `WorkflowConfig.tracker.priorityFieldName`, then forwarded into the GitHub tracker adapter config.
- Resolved in `packages/tracker-github/src/adapter.ts`: `extractPriorityOptionOrder` assigns numeric priority **implicitly from the display order of the Project V2 single-select options** (0, 1, 2, …); `resolvePriority` maps the issue's selected option to that derived number; anything unmatched yields `null`.

This is an **implicit heuristic**: the numeric mapping is never written down, it silently changes if a maintainer reorders Project field options, and there is no label-based path at all (`docs/spec-gap-analysis.md` line 19 records priority as effectively always `null` on GitHub).

Issue #236 originated as a request for **label-based priority fallback**. The product owner has reversed that framing: **no implicit heuristics and no fallback**. Priority must be explicitly declared in `WORKFLOW.md`, from exactly one source, with an explicit value mapping.

## 2. Goals

- **G1** — Priority behavior on the new `tracker.priority` path is **explicit** and fully declared in `WORKFLOW.md`. No order-derived or otherwise inferred numeric mappings at runtime for explicit mappings; the deprecated `tracker.priority_field` path retains legacy behavior per §10.
- **G2** — Priority source is **singular**: exactly one of `project-field`, `labels`, or disabled/omitted. No fallback or merging between sources.
- **G3** — Unknown / unmapped labels or field values resolve to `priority = null`. The runtime never guesses renamed labels, fields, or option values.
- **G4** — When multiple configured labels match one issue, the **lowest numeric value (highest priority)** wins, and the collapse is **observable**.
- **G5** — Configuration drift is surfaced by validation/doctor; the runtime continues with `priority = null` rather than halting orchestration.
- **G6** — The legacy `tracker.priority_field` key remains **backward-compatible** (non-breaking parse), while new `init`/`setup` generation emits the explicit `tracker.priority` shape.
- **G7** — This ADR is precise enough that the three #236 child issues can reference its sections directly (see §11 implementation split).

## 3. Non-Goals

- **N1** — No change to the dispatch sort algorithm itself (`sortCandidatesForDispatch`); only its `priority` input becomes explicit.
- **N2** — No native GitHub "priority" feature; this is purely a mapping over existing Project V2 single-select fields and repo labels.
- **N3** — No automatic migration or rewrite of existing `WORKFLOW.md` files. Migration is advisory (doctor surfaces it).
- **N4** — No multi-source merge, weighting, or precedence resolution between labels and project fields.
- **N5** — No edits to `docs/symphony-spec.md`.
- **N6** — No new priority concept for non-GitHub trackers (Linear, file). This ADR is GitHub Project V2-scoped; other adapters keep their existing behavior.
- **N7** — No interactive Project/label *creation*; setup never invents labels or fields that do not exist.

## 4. Affected Symphony Layers

Per the six layers in `AGENTS.md`:

| Layer | Affected? | What changes |
|---|---|---|
| **Policy** | Yes | `WORKFLOW.md` becomes the single explicit source of priority intent; no implicit team heuristics. |
| **Configuration** | Yes | New `tracker.priority` block parsing + validation in `packages/core` (parser, config types). |
| **Coordination** | Indirect | `sortCandidatesForDispatch` is unchanged; it now consumes an explicitly-derived `priority`. |
| **Execution** | No | Worker filesystem/agent lifecycle unaffected. |
| **Integration** | Yes | `packages/tracker-github` adapter gains explicit `project-field` and `labels` resolution; tracker-specific code stays here. |
| **Observability** | Yes | New structured events (label-conflict collapse, unmapped value) + doctor drift checks. |

## 5. Decision

Introduce an explicit, singular `tracker.priority` block in `WORKFLOW.md` front-matter for the GitHub Project V2 adapter.

### 5.1 Schema — `source: project-field`

The runtime uses **only** the configured Project V2 single-select field and the configured value mapping. No option-order derivation.

```yaml
tracker:
  kind: github-project
  project_id: PVT_kwDOxxxxxx
  state_field: Status
  priority:
    source: project-field
    field: Priority            # required; GitHub Project V2 single-select field name (exact)
    values:                    # required; field option value (display name) -> numeric priority
      Urgent: 0
      High: 1
      Medium: 2
      Low: 3
```

- `field` is the exact Project V2 single-select field name. Renames are not inferred.
- `values` keys are the exact option display names. An option present in the Project but absent from `values` yields `priority = null` for issues holding that option (it is **not** auto-assigned).
- A `values` entry referencing an option that does not exist in the Project is configuration drift (§7), not a runtime error.

### 5.2 Schema — `source: labels`

The runtime uses **only** the configured label mapping.

```yaml
tracker:
  kind: github-project
  project_id: PVT_kwDOxxxxxx
  state_field: Status
  priority:
    source: labels
    labels:                    # required; label name -> numeric priority
      P0: 0
      P1: 1
      P2: 2
      P3: 3
```

- `labels` keys are exact GitHub label names. Renamed labels are not inferred.
- An issue label not present in `labels` contributes nothing; it does not yield a guessed value.
- **Multiple match rule (G4):** if an issue carries more than one configured label, the resolved priority is `min(numeric value)` across the matching configured labels (lowest number = highest priority). This collapse MUST emit an observability event (§8).

### 5.3 Disabled / omitted

Both forms mean every issue resolves to `priority = null` (dispatch then falls back to `createdAt` → identifier):

```yaml
tracker:
  priority:
    source: disabled
```

…or omit the `tracker.priority` block entirely.

### 5.4 Numeric convention

Lower number = higher dispatch precedence, consistent with `sortCandidatesForDispatch` (priority ascending, `null` last). `0` is the highest priority. Values need not be contiguous; only relative ordering matters. Negative values are permitted but discouraged (validation MAY warn).

### 5.5 Singular-source validation

`tracker.priority.source` MUST be exactly one of `project-field`, `labels`, `disabled`. Configuration validation (Configuration layer) MUST reject:

- `source: project-field` without `field` or without a non-empty `values` map.
- `source: labels` without a non-empty `labels` map.
- Presence of `labels:` under `source: project-field` (or `field:`/`values:` under `source: labels`) — cross-source keys are a hard config error to prevent accidental fallback expectations.
- An unrecognized `source` value.

These are **load-time configuration errors** (the workflow is invalid), distinct from **runtime drift** (§7), which never stops orchestration.

## 6. Runtime Semantics

In `packages/tracker-github/src/adapter.ts`, replace the order-derived path with explicit resolution driven by the parsed `tracker.priority` config:

1. **`source: project-field`** — read the issue's selected option for the configured `field`. If the selected option's display value is a key in `values`, `priority = values[value]`. Otherwise `priority = null`. The Project-V2 option *order* is never consulted.
2. **`source: labels`** — collect the issue's labels, intersect with `labels` keys. If the intersection is non-empty, `priority = min` of the mapped values; emit the label-conflict event when the intersection has size > 1 (§8). If empty, `priority = null`.
3. **`source: disabled` / omitted** — `priority = null` for every issue.
4. **Unmapped / unknown is always `null`.** No renamed-label, fuzzy, or order-based fallback under any source.
5. **PR-type tracked items** retain their existing behavior (`priority: null`) unless they also carry a configured Project field value / label under the active source.

The dispatch sort is unchanged; it simply receives explicit values.

## 7. Drift & Error Handling

"Drift" = the live GitHub Project/repo state diverges from the explicit `WORKFLOW.md` mapping. Drift is **observability and doctor surface**, not a runtime stop. The runtime always continues with `priority = null` for the affected issue (G5).

Doctor / validation MUST surface at least:

| Drift case | Source | Surface |
|---|---|---|
| Configured `field` missing from the Project V2 schema | project-field | doctor warn |
| Configured label names absent from the repository | labels | doctor warn |
| Project field option exists but is unmapped in `values` | project-field | doctor warn |
| `values`/`labels` entry references an option/label that does not exist | both | doctor warn |
| An **active** issue currently holds an unmapped priority value | both | doctor warn + runtime observability event (§8) |

Doctor integration (`packages/cli/src/commands/doctor.ts`) follows the existing `DoctorCheckId` + `passCheck/warnCheck` pattern. This ADR proposes a new check id namespace, e.g. `priority_mapping` (exact id finalized in the child issue), reported as `warn` (never `fail`) so doctor stays green-blocking only on hard config errors from §5.5.

Hard configuration errors (§5.5) are reported by config validation as load-time failures and by doctor as `fail` on the workflow validity check, because the workflow itself is invalid — distinct from drift.

## 8. Observability

New structured events (Observability layer; emitted by the GitHub adapter / orchestrator, surfaced in run events and status snapshots):

- **`priority.label_conflict_resolved`** — emitted when `source: labels` and an issue matched > 1 configured label. Payload: issue identifier, matched `{label: value}` set, chosen value, chosen label(s). Makes G4 auditable.
- **`priority.unmapped`** — emitted when an active issue holds a field value / label that the active source does not map, so `priority` resolved to `null` despite the issue carrying a priority-looking attribute. Payload: issue identifier, source, raw value(s).

Event names above are proposed; the schema/runtime child issue finalizes exact naming and payload typing against the existing event taxonomy. The requirement that both cases be observable is fixed by this ADR.

## 9. Init / Setup UX

`gh-symphony repo init` / `setup` / `packages/cli/src/workflow/generate-workflow-md.ts` (`buildFrontMatter`) stop emitting the flat `priority_field` key and instead emit the explicit `tracker.priority` block.

### 9.1 Interactive story

1. During GitHub Project introspection, setup lists single-select fields. If a field named like a priority field exists (e.g. `Priority`), setup offers `source: project-field` and pre-fills `values` from the **current** option display names, assigning numeric values by the option's current order **as an explicit, editable starting point** (the numbers are written into `WORKFLOW.md`, so they are now explicit policy, not a runtime heuristic).
2. The operator can instead choose `source: labels` and map specific repo labels, or choose to disable priority.
3. Setup never creates fields or labels and never invents mappings for things that do not exist (N7).
4. The generated block is emitted with a short comment pointing to this ADR and noting that the numbers are explicit and editable.

### 9.2 Non-interactive behavior

When run non-interactively (`--non-interactive` / CI):

- If a single-select field plausibly serving as priority is detected → emit `source: project-field` with `values` derived from current option display names (explicit, written out). This preserves today's effective ordering while making it explicit.
- If no such field is detected → emit an active, uncommented `source: disabled` block plus commented-out templates for both `project-field` and `labels`, so runtime `priority = null` and the operator has a copy-paste template. Setup never guesses label names.
- Non-interactive runs never fail solely due to absent priority configuration.

### 9.3 Generated example (non-interactive, field detected)

```yaml
tracker:
  kind: github-project
  project_id: PVT_kwDOxxxxxx
  state_field: Status
  # Priority is explicit. Numbers below are editable policy (lower = higher priority).
  # See docs/adr/2026-05-18_explicit-dispatch-priority-mappings.md
  priority:
    source: project-field
    field: Priority
    values:
      Urgent: 0
      High: 1
      Medium: 2
      Low: 3
```

### 9.4 Generated example (non-interactive, no field detected)

```yaml
tracker:
  kind: github-project
  project_id: PVT_kwDOxxxxxx
  state_field: Status
  # Priority dispatch is disabled until an operator chooses one explicit source.
  priority:
    source: disabled

  # Optional template: project-field priority source.
  # priority:
  #   source: project-field
  #   field: Priority
  #   values:
  #     Urgent: 0
  #     High: 1

  # Optional template: labels priority source.
  # priority:
  #   source: labels
  #   labels:
  #     P0: 0
  #     P1: 1
```

## 10. Backward Compatibility for `priority_field`

- **Parse compatibility (G6).** `tracker.priority_field: <name>` continues to parse without error and behaves exactly as today (Project V2 single-select, **legacy order-derived** numeric mapping). It is documented as **deprecated** in favor of `tracker.priority`.
- **Precedence.** If both `tracker.priority` and the legacy `tracker.priority_field` are present, `tracker.priority` (explicit) wins. The parser does not error (non-breaking); doctor emits a deprecation/conflict `warn`.
- **No silent migration (N3).** Existing files are not rewritten. Doctor recommends migrating `priority_field` → explicit `tracker.priority`, including a generated suggested `values` block from the live Project options.
- **New generation.** `generate-workflow-md` / `init` / `setup` no longer emit `priority_field`; they emit `tracker.priority`.
- **Removal.** Legacy `priority_field` removal is out of scope here and gated on a future deprecation-window ADR.

## 11. Implementation Split (#236 children)

This ADR is the shared reference for three independent child issues. Each child cites sections by anchor.

| Child | Title | Scope | Primary sections | Packages |
|---|---|---|---|---|
| **C1** | Schema & runtime | `tracker.priority` parsing/validation; GitHub adapter explicit resolution; legacy precedence; observability events | §5, §5.5, §6, §8, §10 | `packages/core`, `packages/tracker-github` |
| **C2** | Init / setup generation UX | `generate-workflow-md`, `setup`, `init` emit explicit block; interactive + non-interactive; stop emitting `priority_field` | §9, §10 | `packages/cli` |
| **C3** | Drift validation & docs | doctor `priority_mapping` checks; deprecation/conflict warn; user docs + example WORKFLOW.md | §7, §8, §10 | `packages/cli` (doctor), `docs/` |

Suggested order: **C1 → (C2 ∥ C3)**. C1 establishes the parsed shape that C2 generates and C3 validates. C2 and C3 are independent once C1's config type lands. Each child ships its own tests (§13) and changeset.

## 12. Acceptance Criteria

- **AC1** — A `WORKFLOW.md` with `source: project-field` resolves `priority` solely from the configured `field`+`values`; reordering Project options does not change resolved priorities.
- **AC2** — A `WORKFLOW.md` with `source: labels` resolves `priority` solely from `labels`; unmapped labels contribute nothing.
- **AC3** — An issue with multiple configured labels resolves to the minimum mapped value and emits `priority.label_conflict_resolved`.
- **AC4** — Any unknown/unmapped field value or label resolves to `priority = null`; no guessing of renamed labels/fields/values.
- **AC5** — Cross-source keys, missing required keys, or an unrecognized `source` are load-time configuration errors (§5.5); doctor reports the workflow as invalid (`fail`).
- **AC6** — Each drift case in §7 produces a doctor `warn` (not `fail`) and the orchestrator continues with `priority = null` (no halt).
- **AC7** — An active issue holding an unmapped priority value emits `priority.unmapped` and appears in doctor output.
- **AC8** — Legacy `tracker.priority_field` still parses and behaves as before; with both present, explicit `tracker.priority` wins and doctor emits a deprecation `warn`.
- **AC9** — `init`/`setup`/`generate-workflow-md` emit `tracker.priority` and never emit `priority_field`; non-interactive runs never fail solely due to missing priority config and never invent labels/fields.
- **AC10** — Dispatch ordering for explicitly-mapped issues matches `sortCandidatesForDispatch` semantics (priority asc, null last).

## 13. Testing Strategy

Per `AGENTS.md` ("작업 완료 후 반드시 TC를 작성하고 테스트를 실행") and `AGENT_TEST.md`: each child lands unit tests; integration behavior not covered by unit tests is verified via the Docker E2E black-box environment.

- **C1 unit** — `packages/core` parser/config: valid `project-field`/`labels`/`disabled`, all §5.5 rejection cases, legacy precedence. `packages/tracker-github`: `resolvePriority` for project-field and labels including the multi-label `min` rule, unmapped → `null`, event emission. Add cases to `core-conformance.test.ts` where appropriate.
- **C2 unit** — `generate-workflow-md.test.ts`, `setup.test.ts`, `workflow-init.test.ts`: emitted front-matter is the explicit block; no `priority_field`; non-interactive scaffold/disabled behavior; no invented labels.
- **C3 unit** — `doctor.test.ts`: each §7 drift case → `warn`; deprecation/conflict `warn`; hard config error → `fail`; runtime-continues assertion.
- **E2E (black-box)** — a seeded GitHub Project + repo: project-field path, labels path with conflicting labels, drifted field/label, legacy `priority_field` still ordering correctly. Assert dispatch order and emitted observability events.
- **Regression** — full gate before shipping each child: `pnpm lint && pnpm test && pnpm typecheck && pnpm build`.

## 14. Alternatives Considered

- **A. Keep label fallback as #236 originally framed** (project field, then labels). Rejected by product owner: introduces an implicit precedence heuristic and ambiguous resolution; violates G2.
- **B. Keep order-derived project-field mapping, add labels separately.** Rejected: order-derivation is the implicit heuristic this ADR removes (violates G1); silent breakage on option reorder persists.
- **C. Auto-migrate `priority_field` → `tracker.priority` on load.** Rejected: silent rewrite of operator policy; surprising and hard to audit. Migration stays advisory via doctor (N3).
- **D. Make drift a hard stop.** Rejected: a renamed label/field would halt all orchestration; G5 requires continuing with `priority = null`.
- **E (chosen)** — Explicit, singular-source mapping with no fallback; drift surfaced not fatal; legacy key preserved non-breaking.

## 15. Open Questions

- **OQ1** — Exact doctor `DoctorCheckId` value(s): one aggregate `priority_mapping` check vs. per-case ids. Deferred to C3; does not affect C1/C2 contracts.
- **OQ2** — Final event names/payload schema for §8 against the existing event taxonomy. Deferred to C1; the *observability requirement* is fixed here.
- **OQ3** — Whether `source: disabled` is the canonical keyword or an alias (`none`) is also accepted. C1 picks one; omission semantics are fixed (= `null` everywhere).
- **OQ4** — Deprecation window/removal timeline for `priority_field` (separate future ADR; out of scope, N3).

## 16. References

- Upstream spec (read-only): `docs/symphony-spec.md` §11, §5.1
- Gap analysis: `docs/spec-gap-analysis.md` lines 19, 133
- Dispatch sort: `packages/orchestrator/src/service.ts:3452` (`sortCandidatesForDispatch`)
- Current GitHub priority resolution: `packages/tracker-github/src/adapter.ts` (`extractPriorityOptionOrder`, `resolvePriority`)
- Current parser key: `packages/core/src/workflow/parser.ts` (`priority_field` → `priorityFieldName`)
- Current generation: `packages/cli/src/workflow/generate-workflow-md.ts` (`buildFrontMatter`)
- Doctor pattern: `packages/cli/src/commands/doctor.ts` (`DoctorCheckId`)
- Related ADRs: `docs/adr/2026-03-19_github-project-v2-state-filtering-cache.md`, `docs/adr/2026-05-04_single-repo-orchestrator.md`
