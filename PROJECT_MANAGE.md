---
project_url: https://github.com/users/hojinzs/projects/14
project_number: 14
project_node_id: PVT_kwHOAPiKdM4BYPVD
owner: hojinzs
backlog_status: Backlog
backlog_status_id: ecd228db
field_ids:
  status: PVTSSF_lAHOAPiKdM4BYPVDzhTWkPc
  priority: PVTSSF_lAHOAPiKdM4BYPVDzhTWke8
  size: PVTSSF_lAHOAPiKdM4BYPVDzhTWkfA
priority_options:
  P0: "aca19a9a"
  P1: "2c4dc9a5"
  P2: "e7e57239"
  P3: "c242039b"
size_options:
  XS: "32ae82e3"
  S: "7186632c"
  M: "117e0aab"
  L: "4ffb3063"
status_options:
  Backlog: "ecd228db"
  Ready: "f043e389"
  In progress: "b734c33a"
  In review: "ffe0efa5"
  Land: "161b1b30"
  Done: "444fc1b2"
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
