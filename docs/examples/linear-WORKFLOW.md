---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: symphony-0c79b11b75ea
  active_states:
    - Todo
    - In Progress
    - Rework
  pickup_labels:
    include:
      - agent
      - dev-ready
    exclude:
      - no-agent
      - needs-spec
  terminal_states:
    - Done
    - Canceled
    - Cancelled
    - Duplicate
polling:
  interval_ms: 30000
workspace:
  root: .runtime/symphony-workspaces
agent:
  max_concurrent_agents: 4
  max_turns: 20
runtime:
  kind: codex-app-server
  command: codex
  args:
    - app-server
  isolation:
    bare: false
    strict_mcp_config: false
  timeouts:
    read_timeout_ms: 5000
    turn_timeout_ms: 3600000
    stall_timeout_ms: 300000
---

## Status Map

- **Todo** [active]: create a workpad comment, move the Linear issue to `In Progress`, and start implementation.
- **In Progress** [active]: continue the current work cycle, updating the existing workpad comment in place.
- **Rework** [active]: inspect PR review feedback first, then update the workpad with the revised plan before editing code.
- **Human Review** [wait]: a PR has been opened and human review is required; do not continue unless review feedback asks for changes.
- **Done**, **Canceled**, **Cancelled**, **Duplicate** [terminal]: exit immediately.

## Linear Tracker Policy

`WORKFLOW.md` is the source of truth for Linear tracker setup. Use `tracker.kind: linear` with `tracker.project_slug`; do not use `tracker.project_id`, `projectId`, `project_id`, `teamId`, or `.gh-symphony/config.json` as Linear configuration inputs.

`LINEAR_API_KEY` must be available when running `gh-symphony repo init`, `gh-symphony repo start`, or `gh-symphony workflow preview ENG-123`. The orchestrator reads Linear by polling the configured project. Linear webhook setup is a non-goal and no webhook command is expected.

`tracker.pickup_labels` only controls whether active-state issues are eligible for new worker pickup. Exclude labels win over include labels. If `include` is omitted or empty, active-state issues remain pickup-eligible unless excluded. Do not use label changes to stop already running workers; move the Linear issue state to control interruption, review, and completion.

## Workpad Policy

1. Read the Linear issue body and comments before making changes.
2. Create exactly one workpad comment per active work cycle.
3. If the issue returns from `Human Review` to `Rework` or another active state, start a new workpad comment and record the review trigger.
4. Within a work cycle, update the existing workpad comment instead of creating duplicates.
5. Do not write secrets, tokens, or raw `LINEAR_API_KEY` values into comments, logs, commits, or PR bodies.

## Execution Policy

1. Create a branch for the Linear issue identifier, for example `eng-123-description`.
2. Implement only the issue scope.
3. Run the repository validation commands required by this repository.
4. Commit logical units of work.
5. Open a GitHub PR against the configured repository.

## PR Handoff Policy

1. Add the GitHub PR URL to the Linear issue comment thread.
2. Move the Linear issue to `Human Review`.
3. Record validation evidence and the PR URL in the workpad.
4. If review changes are requested, move the issue to `Rework`, address the feedback, update the PR, and return the issue to `Human Review`.
5. When the PR is merged and validation is complete, move the Linear issue to `Done`.
