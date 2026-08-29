---
tracker:
  kind: file
  project_id: e2e-test
  state_field: Status
  active_states:
    - Ready
    - In Progress
  terminal_states:
    - Done
    - Cancelled
  blocker_check_states:
    - Ready
  planning_states:
    - " ready "
polling:
  interval_ms: 5000
workspace:
  root: .runtime/symphony-workspaces
agent:
  max_concurrent_agents: 2
  max_turns: 2
codex:
  command: node /app/e2e/stub-worker.js
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy: dangerFullAccess
  stall_timeout_ms: 60000
---

You are an AI agent working on issue {{issue.identifier}}; phase={{execution_phase}}; retry_attempt={{attempt}}.
This is an E2E test environment. Complete the task and report success.
