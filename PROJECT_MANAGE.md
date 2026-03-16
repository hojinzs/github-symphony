---
project_url: https://github.com/users/hojinzs/projects/4
project_number: 4
project_node_id: PVT_kwHOAPiKdM4BRs_j
owner: hojinzs
backlog_status: Backlog
backlog_status_id: f75ad846
field_ids:
  status: PVTSSF_lAHOAPiKdM4BRs_jzg_dCKk
  priority: PVTSSF_lAHOAPiKdM4BRs_jzg_dCO4
  size: PVTSSF_lAHOAPiKdM4BRs_jzg_dCO8
  estimate: PVTF_lAHOAPiKdM4BRs_jzg_dCPA
priority_options:
  P0: "79628723"
  P1: "0a877460"
  P2: "da944a9c"
size_options:
  XS: "6c6483d2"
  S: "f784b110"
  M: "7515a9f1"
  L: "817d0097"
  XL: "db339eb2"
status_options:
  Backlog: "f75ad846"
  Ready: "61e4505c"
  In progress: "47fc9ee4"
  In review: "df73e18b"
  Done: "98236657"
---

# Project Management Conventions

## Issue Template

### Required Sections

1. **Background** — Why this change is needed; motivation and context
2. **Proposed Changes** — What will be changed and how
3. **Affected Files** — Table: File | Change | Scope

### Optional Sections (include as applicable)

- **Spec Reference** — Relevant Symphony spec section numbers and quotes (for spec conformance issues)
- **Current Implementation vs Spec** — Side-by-side comparison (table format recommended)
- **Migration Notes** — Impact on existing data or API compatibility
- **Symptoms / Reproduction Steps** — For bug reports
- **References** — Spec sections, ADRs, related issue links

## Splitting Rules

Issues sized **L or above** should be reviewed for splitting.
Each sub-issue must be independently deployable.
Link the original issue as the parent.

## Priority Definitions

| Priority | Definition | Examples |
|----------|------------|----------|
| **P0** | Active bugs, blocks other work | Runtime crash, data loss |
| **P1** | Spec compliance, core architecture | Spec deviation fix, contract change |
| **P2** | DX/UX improvements, non-critical refactoring | CLI UX polish, code cleanup |

## Size Definitions

| Size | Scope | Criteria |
|------|-------|----------|
| **XS** | Single file | < 50 lines changed |
| **S** | 2–3 files | < 200 lines |
| **M** | Multiple files | Single package scope |
| **L** | Multiple packages | Includes interface changes |
| **XL** | Architecture-level | Large-scale refactoring |

## Estimate Convention

- Unit: **hours**
- Based on a single full-time developer's net working time
- Excludes code review, testing, and CI wait time
