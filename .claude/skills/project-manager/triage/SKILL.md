---
name: triage
description: Analyze backlog issues to set Priority, Size, and Estimate, then identify and connect blocking relationships between issues. Use when backlog items need evaluation or when new items have been added without triage.
disable-model-invocation: true
user-invocable: true
---

# /project-manager:triage — Backlog Triage and Dependency Analysis

## Purpose

Evaluate untriaged backlog items by analyzing their descriptions and the codebase, assign Priority/Size/Estimate, identify blocking relationships between issues, and update the GitHub Project board. This is the equivalent of a backlog grooming session.

## Pre-flight Checks

Run these checks **in order** before proceeding:

1. **gh CLI authentication**: Run `gh auth status`. If not authenticated, stop and instruct:
   ```
   GitHub CLI is not authenticated. Please run:
   $ gh auth login
   ```

2. **Project scope permission**: Attempt a lightweight project API call. If permission error, stop and instruct:
   ```
   The GitHub CLI token lacks the "project" scope. Please run:
   $ gh auth refresh -s project
   ```

3. **PROJECT_MANAGE.md exists**: Read `PROJECT_MANAGE.md` from the repository root. If not found, stop and instruct:
   ```
   PROJECT_MANAGE.md not found. Please run /project-manager:init first.
   ```

## Workflow

### Step 1: Parse Configuration

Read `PROJECT_MANAGE.md` and extract:
- **Frontmatter**: project_number, project_node_id, owner, backlog_status, backlog_status_id, field_ids, priority_options, size_options
- **Body**: Priority definitions, Size definitions, Estimate convention

### Step 2: Fetch Backlog Items

Run `gh project item-list <project_number> --owner <owner> --format json --limit 100`.

Filter to only items where:
- Status matches `backlog_status` (use the name from frontmatter)
- Item type is "Issue" (skip draft items)

### Step 3: Identify Untriaged Items

From the filtered backlog items, identify those **missing any of** Priority, Size, or Estimate.

If all backlog items are already triaged, inform the user:
```
All backlog items are already triaged. Nothing to do.
```
And then skip to Step 6 (blocking analysis) since relationships may still need updating.

### Step 4: Analyze and Evaluate

For each untriaged item:

1. **Read the issue body** — understand the scope, motivation, and affected areas.
2. **Explore the codebase** — check the files and packages mentioned in the issue. Assess:
   - How many files need to change
   - Whether interfaces/contracts are affected
   - Cross-package impact
   - Test coverage implications
3. **Assign Priority** — using the definitions from PROJECT_MANAGE.md:
   - Consider: Is it a bug? Does it block other work? Is it spec compliance? Is it a nice-to-have?
4. **Assign Size** — using the definitions from PROJECT_MANAGE.md:
   - Consider: Number of files, lines of change, package scope, interface changes
5. **Assign Estimate** — using the convention from PROJECT_MANAGE.md:
   - Consider: Size, complexity, risk, testing effort

### Step 5: Present Evaluation Table and Update

Present all evaluations in a table for user review:

```
| #  | Title                              | Priority | Size | Estimate | Rationale                                    |
|----|-------------------------------------|----------|------|----------|----------------------------------------------|
| #26 | blockedBy BlockerRef 변경          | P0       | S    | 2d       | Active bug: cross-project blocker permanent block. Data already fetched in GraphQL. |
| #27 | Issue-Centric State Model          | P1       | XL   | 8d       | Spec 3-section compliance. service.ts 1362-line core refactor. |
```

Ask the user: **"Proceed with these evaluations? [apply / modify / skip]"**

- **apply**: Update all fields on the GitHub Project board using `gh project item-edit`:
  - Use `--project-id <project_node_id>` (the node ID, NOT the number)
  - Use `--id <item_id>` (the project item ID from the item list)
  - Use `--field-id` and `--single-select-option-id` for Priority and Size
  - Use `--field-id` and `--number` for Estimate
- **modify**: Let the user adjust specific items, then re-present.
- **skip**: Move to blocking analysis without updating fields.

### Step 6: Analyze Blocking Relationships

**Scope: ALL open (non-Done) issues — not just Backlog.**

A Backlog item can be blocked by an issue that is currently In Progress (e.g., a large refactoring). Limiting analysis to Backlog-only would miss these critical dependencies.

1. **Fetch all open issues** from the project board — every item whose Status is NOT the terminal/Done status.
2. **For each pair of open issues**, consider:
   - **Data dependency**: Does issue A change a type/interface that issue B consumes?
   - **Structural dependency**: Does issue A restructure code that issue B would modify?
   - **Logical dependency**: Does issue A's completion enable issue B's approach?
   - **Rework avoidance**: Would doing B before A cause significant rework?
3. **Fetch existing blocking relationships** to avoid duplicates:

```graphql
query {
  repository(owner: "<owner>", name: "<repo>") {
    issueA: issue(number: N) {
      blockedBy(first: 20) { nodes { number state } }
    }
    ...
  }
}
```

### Step 7: Present Blocking Map

Present the dependency map. Annotate each issue with its **current Status** so the user can see cross-status blocking at a glance:

```
Blocking Dependency Map:

#30 [In Progress] large-scale auth refactor (P1, XL)
 └── blocks → #26 [Backlog] blockedBy BlockerRef 변경 (P0, S)

#22 [Backlog] Commander.js 마이그레이션 (P2, L)
 ├── blocks → #23 [Backlog] interactive project selection (P2, S)
 └── blocks → #24 [Backlog] project add 간소화 (P2, S)

#27 [Backlog] Issue-Centric State Model (P1, XL)
 └── blocks → #25 [Backlog] GET /api/v1/<issue_identifier> (P1, M)

New relationships to create: 4
Already connected: 0
```

Ask the user: **"Connect these blocking relationships? [apply / modify / skip]"**

- **apply**: For each new relationship, call GraphQL `addBlockedBy`:
  - First fetch issue node IDs via `gh api graphql` query on the repository
  - Then call `addBlockedBy(input: { issueId: "<blocked>", blockingIssueId: "<blocker>" })`
- **modify**: Let the user add/remove relationships, then re-present.
- **skip**: Finish without connecting.

### Step 8: Recommend Execution Order

Based on priority and blocking relationships, suggest an execution order.

**If any In Progress / In Review issues are blockers for Backlog items**, show them as Phase 0 — work that is already in-flight and must complete before dependent Backlog items can start. This prevents the illusion that a high-priority Backlog item is immediately actionable when it's actually waiting on in-flight work.

```
Recommended execution order:

Phase 0 (in-flight, awaiting completion):
  #30 [In Progress] large-scale auth refactor  XL  ← must complete first

Phase 1 (unblocked after Phase 0):
  #26 [P0] blockedBy BlockerRef 변경  S  2d

Phase 2 (no blockers, can start now):
  Track A: #27 [P1] Issue-Centric State Model  XL  8d
  Track B: #22 [P2] Commander.js 마이그레이션  L   5d

Phase 3 (unblocked after Phase 2):
  Track A: #25 [P1] GET /api/v1/<issue_identifier>  M  3d
  Track B: #23 [P2] interactive project selection  S  2d
           #24 [P2] project add 간소화  S  1d

Total backlog: 6 issues, 21d estimated
Critical path: #30 (in-flight) → #26 → ...
Parallel track critical path: #27 → #25 (11d)
```

If no in-flight issues are blockers, omit Phase 0 entirely.

## Important Rules

- **Triage scope (Priority/Size/Estimate)**: Only evaluate and update fields for items in the Backlog status. Do NOT modify fields on items in other statuses (In Progress, In Review, Done, etc.).
- **Blocking scope**: Analyze ALL open (non-Done) issues for blocking relationships. An In Progress item can block a Backlog item — these cross-status dependencies are critical and must not be missed.
- **Never auto-apply**: Always present evaluation and blocking proposals to the user for approval before making any changes.
- **Use real codebase data**: When assessing Size and Estimate, actually explore the files mentioned in the issue. Don't rely solely on the issue description.
- **Avoid duplicate relationships**: Always check existing blocking relationships before proposing new ones.
- **Field ID precision**: Always use field IDs and option IDs from PROJECT_MANAGE.md frontmatter. Never hardcode.
- **Batch API calls**: When fetching issue node IDs or blocking relationships, combine into a single GraphQL query with aliases to minimize API calls.
- **Be conservative with Priority**: Only assign P0 to actual bugs or items that block other work. P1 for architectural/spec items. P2 for everything else.
