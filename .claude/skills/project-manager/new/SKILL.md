---
name: new
description: Create new GitHub issues following PROJECT_MANAGE.md conventions. Analyzes codebase to estimate size, suggests splitting if needed, sets project fields, and connects blocking relationships. Use when you need to create well-structured issues.
argument-hint: <description of the work>
disable-model-invocation: true
user-invocable: true
---

# /project-manager:new — Create Issues from PROJECT_MANAGE.md Rules

## Purpose

Create one or more GitHub issues that follow the repository's project management conventions defined in `PROJECT_MANAGE.md`. Automatically analyze the codebase to determine scope, estimate size, suggest splitting when appropriate, and connect blocking relationships.

## Pre-flight Checks

Run these checks **in order** before proceeding:

1. **gh CLI authentication**: Run `gh auth status`. If not authenticated, stop and instruct:
   ```
   GitHub CLI is not authenticated. Please run:
   $ gh auth login
   ```

2. **Project scope permission**: Attempt a lightweight project API call using the project info from `PROJECT_MANAGE.md` frontmatter. If permission error, stop and instruct:
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
- **Frontmatter**: project_node_id, owner, field_ids, priority_options, size_options, status_options, backlog_status, backlog_status_id
- **Body**: Issue template format, splitting rules, priority/size definitions

### Step 2: Understand the Request

The user provides a natural-language description of the work as `$ARGUMENTS`. Analyze it to understand:
- What needs to change
- Which packages/files are affected
- The motivation (bug fix, feature, refactoring, spec compliance, etc.)

### Step 3: Explore the Codebase

Based on the description, explore the codebase to:
- Identify affected files and their current state
- Understand package boundaries and dependency relationships
- Assess the scope of changes needed
- Check for related contracts, tests, and consumers

### Step 4: Draft the Issue(s)

Using the issue template from PROJECT_MANAGE.md, draft the issue body with:
- All required template sections filled in
- Concrete file paths and change descriptions (not vague)
- Verification steps that can actually be run

Assign **Priority**, **Size**, and **Estimate** based on:
- The definitions in PROJECT_MANAGE.md
- The actual codebase analysis from Step 3

### Step 5: Evaluate Splitting

Check the estimated Size against the splitting rules in PROJECT_MANAGE.md:

- If the Size is **at or below** the splitting threshold → proceed with a single issue.
- If the Size **exceeds** the threshold → propose a split plan.

When splitting, present a **dependency map**:

```
Proposed split (original estimate: L, 5d → split into 3 issues):

#A refactor(core): introduce BlockerRef type     S  2d
 └── blocks → #B fix(orchestrator): update blocker check  S  1d
#C docs: update ADR for blocker model             XS  0.5d

Proceed? [create all / modify / cancel]
```

Splitting guidelines:
- Each sub-issue should be independently deliverable (single PR)
- Respect package boundaries when possible
- Maintain clear blocking relationships between split issues
- The split should not create circular dependencies

### Step 6: Check Blocking with ALL Open Issues

Fetch **all open (non-Done) issues** from the project board — not just Backlog items. An issue currently In Progress (e.g., a large refactoring) can block the new issue, or the new issue might block existing in-flight work.

Analyze whether the new issue(s):
- **Are blocked by** any existing open issue (e.g., depends on a type change, refactoring, or spec migration that's already planned or in progress)
- **Block** any existing open issue (e.g., the new issue introduces something an existing issue depends on)

Annotate each relationship with the existing issue's **current Status** so the user sees cross-status dependencies:

```
Detected relationships with existing issues:
  - New #A is blocked by #30 [In Progress] (large-scale auth refactor)
  - New #A is blocked by #27 [Backlog] (Issue-Centric State Model)
  - Existing #25 [Backlog] would be blocked by new #B
```

### Step 7: Present and Confirm

Show the user a complete summary:

1. Issue title(s) and body preview
2. Priority / Size / Estimate for each
3. Splitting map (if applicable)
4. Blocking relationships (new-to-new and new-to-existing)

Ask for explicit confirmation before creating anything.

### Step 8: Create and Configure

Upon user approval:

1. **Create issue(s)** via `gh issue create --repo <owner>/<repo> --title "..." --body "..."`.
2. **Add to project board**: Use GraphQL `addProjectV2ItemById` to add each issue to the project.
3. **Set project fields**: Use `gh project item-edit` with the project_node_id and field_ids from frontmatter to set Priority, Size, Estimate, and Status (set to backlog).
4. **Connect blocking relationships**: For split issues and existing backlog relationships, use GraphQL `addBlockedBy` mutation:
   ```graphql
   mutation {
     addBlockedBy(input: {
       issueId: "<blocked issue node ID>",
       blockingIssueId: "<blocking issue node ID>"
     }) {
       issue { number title }
       blockingIssue { number title }
     }
   }
   ```

### Step 9: Report

Show the created issue URLs and a final dependency map.

## Important Rules

- **Never create issues without user confirmation.** Always present the full plan first.
- **Never guess field IDs.** Always read them from PROJECT_MANAGE.md frontmatter.
- **Issue bodies must be concrete.** Include real file paths, real type names, real function signatures — not placeholders.
- **Respect the issue template format** defined in PROJECT_MANAGE.md exactly.
- When determining the repository for issue creation, use the current git remote origin.
- Use `gh api graphql` for operations not supported by `gh` CLI directly (e.g., `addBlockedBy`, `addProjectV2ItemById`).
