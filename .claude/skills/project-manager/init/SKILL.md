---
name: init
description: Initialize PROJECT_MANAGE.md with repository-specific project management rules, GitHub Project board binding, and field mappings. Use when setting up project management for a repository for the first time.
argument-hint: "github-project-url"
disable-model-invocation: true
user-invocable: true
---

# /project-manager:init — Initialize Project Management Configuration

## Purpose

Create a `PROJECT_MANAGE.md` file in the repository root that stores project management conventions, GitHub Project board binding, and field ID mappings. This file is the single source of truth for all other `project-manager:*` commands.

## Pre-flight Checks

Before doing anything else, run these checks **in order**:

1. **gh CLI authentication**: Run `gh auth status`. If not authenticated, stop and tell the user:
   ```
   GitHub CLI is not authenticated. Please run:
   $ gh auth login
   ```

2. **Project scope permission**: Attempt `gh project list --owner <owner> --limit 1`. If it fails with a 403 or permission error, stop and tell the user:
   ```
   The GitHub CLI token lacks the "project" scope. Please run:
   $ gh auth refresh -s project
   ```

3. **Existing PROJECT_MANAGE.md**: If `PROJECT_MANAGE.md` already exists in the repo root, warn the user and ask whether to overwrite or abort.

## Workflow

### Step 1: Identify the GitHub Project Board

- If the user provided a project URL as argument (`$ARGUMENTS`), parse the owner and project number from it.
- Otherwise, run `gh project list --owner <owner> --format json` and let the user pick interactively.
- Fetch the project's node ID: `gh project view <number> --owner <owner> --format json` → extract `id`.

### Step 2: Detect Project Fields

Run `gh project field-list <number> --owner <owner> --format json` and automatically detect:

- **Status field**: Find the SingleSelect field named "Status". Extract all option names and IDs.
- **Priority field**: Find the SingleSelect field named "Priority". Extract option names and IDs.
- **Size field**: Find the SingleSelect field named "Size". Extract option names and IDs.
- **Estimate field**: Find the number field named "Estimate". Extract field ID.

If any of Priority, Size, or Estimate fields are missing, inform the user and ask if they want to create them manually on the project board first, or proceed without them.

### Step 3: Detect Backlog Status

From the Status field options detected in Step 2:

- If an option named "Backlog" exists, propose it as the backlog status and ask for confirmation.
- If not found, present all Status options and ask the user to select which one represents the backlog.
- Store both the name and option ID.

### Step 4: Discuss Issue Conventions with the User

Have a brief interactive discussion to establish:

1. **Issue body template** — Ask: "What sections should every issue body contain?" Suggest a default based on existing issues in the repo (read a few recent issues via `gh issue list --json number,title,body --limit 5`). A good default:
   - Overview / Background
   - Scope of Changes (table format: file | change)
   - Verification steps
   - Affected layers / packages

2. **Splitting rules** — Ask: "What's the maximum Size before an issue should be split?" Suggest default: "L or above should be reviewed for splitting."

3. **Priority definitions** — Propose defaults based on the detected Priority options and ask for confirmation:
   - P0: Active bugs, blocks other work
   - P1: Spec compliance, core architecture
   - P2: DX/UX improvements, non-critical refactoring

4. **Size definitions** — Propose defaults and ask for confirmation:
   - XS: Single file, < 50 line changes
   - S: 2-3 files, < 200 lines
   - M: Multiple files, single package scope
   - L: Multiple packages, interface changes
   - XL: Architecture-level, large-scale refactoring

5. **Estimate unit** — Ask: "What unit for estimates?" Default: days (full-time single developer).

### Step 5: Generate PROJECT_MANAGE.md

Write the file with YAML frontmatter containing all machine-readable IDs, followed by human-readable convention rules in markdown.

**Frontmatter** must include:
```yaml
---
project_url: <full URL>
project_number: <number>
project_node_id: <node ID>
owner: <owner>
backlog_status: <name>
backlog_status_id: <option ID>
field_ids:
  status: <field ID>
  priority: <field ID>
  size: <field ID>
  estimate: <field ID>
priority_options:
  <name>: "<option ID>"
  ...
size_options:
  <name>: "<option ID>"
  ...
status_options:
  <name>: "<option ID>"
  ...
---
```

**Body** must include the agreed-upon conventions in clear markdown sections:
- Issue Template
- Splitting Rules
- Priority Definitions
- Size Definitions
- Estimate Convention

### Step 6: Confirm

Show the user the generated file content and ask for final confirmation before writing.

## Important Rules

- All field IDs and option IDs must be real values fetched from the GitHub API — never hardcode or guess.
- The frontmatter is machine-readable and consumed by other `project-manager:*` skills. Keep it precise.
- The body is human-readable guidance. Keep it concise but actionable.
- Write the file in the repository root as `PROJECT_MANAGE.md`.
