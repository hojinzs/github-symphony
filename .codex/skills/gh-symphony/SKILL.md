---
name: gh-symphony
description: Design, refine, and validate repository WORKFLOW.md files for GitHub Symphony projects.
license: MIT
metadata:
  author: gh-symphony
  version: "1.0"
  generatedBy: "gh-symphony"
---

# /gh-symphony — WORKFLOW.md Design & Refinement

## Trigger

Use this skill when you want to:
- Create a new WORKFLOW.md for a GitHub Symphony project
- Refine or improve an existing WORKFLOW.md
- Validate that a WORKFLOW.md is correctly structured

## Prerequisites

- `.gh-symphony/context.yaml` must exist (contains GitHub Project metadata)
- `.gh-symphony/reference-workflow.md` must exist (annotated reference template)
- `gh` CLI must be authenticated

## Mode Detection

Check if `WORKFLOW.md` exists in the current directory:
- **Not found** → enter **Design Mode** (create from scratch)
- **Found** → ask user: refine existing or validate only?
  - Refine → enter **Refine Mode**
  - Validate → enter **Validate Mode**

## Design Mode

1. Read `.gh-symphony/context.yaml` to understand the project structure
2. Read `.gh-symphony/reference-workflow.md` as the annotated reference
3. Ask the user these key questions:
   - Which status columns should be **active** (agent works)?
   - Which should be **wait** (agent pauses for human)?
   - Which should be **terminal** (agent stops)?
   - What runtime is being used? (codex / claude-code / custom)
   - Any custom hooks needed? (after_create, before_run, etc.)
4. Generate WORKFLOW.md using the reference as a structural guide
5. Validate the generated file (see Validate Mode)

## Refine Mode

1. Read the current `WORKFLOW.md`
2. Read `.gh-symphony/reference-workflow.md` for comparison
3. Identify missing or incomplete sections:
   - Status Map with role annotations
   - Default Posture / Agent Instructions
   - Guardrails section
   - Workpad Template
   - Step 0 routing logic
4. Propose improvements and apply with user confirmation
5. Validate the refined file

## Validate Mode

Check the WORKFLOW.md for:
- Front matter is valid YAML
- Required fields are present (see Supported Front Matter Fields)
- Template variables use only supported names (see Supported Template Variables)
- Status Map matches the lifecycle configuration
- No unsupported double-brace variable patterns (only the 8 listed below are valid)

## Supported Front Matter Fields

```yaml
tracker:
  kind: github-project
  project_id: PVT_xxx
  state_field: Status
  active_states: [Todo, In Progress]
  terminal_states: [Done, Cancelled]
  blocker_check_states: [Blocked]
polling:
  interval_ms: 30000
workspace:
  root: .runtime/symphony-workspaces
hooks:
  after_create: |
    git clone --depth 1 https://github.com/owner/repo .
  before_run: null
  after_run: null
  before_remove: null
  timeout_ms: 60000
agent:
  max_concurrent_agents: 10
  max_retry_backoff_ms: 30000
  retry_base_delay_ms: 1000
  max_turns: 20
codex:
  command: codex app-server
  read_timeout_ms: 5000
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
```

## Supported Template Variables

Use these in the WORKFLOW.md prompt body (double-brace syntax):

| Variable | Description |
|----------|-------------|
| `issue.identifier` | e.g. `acme/platform#42` |
| `issue.title` | Issue title |
| `issue.state` | Current tracker state |
| `issue.description` | Issue body |
| `issue.url` | Issue URL |
| `issue.repository` | `owner/name` |
| `issue.number` | Issue number |
| `attempt` | Retry attempt number (null on first run) |

**Important**: Only these 8 variables are supported. Using any other variable
will cause a runtime error (strict mode validation).

## Related Skills

- `/gh-project` — interact with GitHub Project v2 board (status transitions, workpad comments)
- `/commit` — produce clean, logical commits during implementation
- `/push` — keep remote branch current and publish updates
- `/pull` — sync branch with latest origin/main before handoff
- `/land` — merge approved PR and transition issue to Done