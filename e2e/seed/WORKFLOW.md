---
tracker:
  kind: file
  state_field: Status
  active_states:
    - Ready
    - In Progress
  terminal_states:
    - Done
    - Cancelled
  blocker_check_states:
    - Ready
polling:
  interval_ms: 5000
agent:
  max_concurrent_agents: 2
  max_turns: 2
codex:
  command: node /app/e2e/stub-worker.js
  approval_policy: on-request
  thread_sandbox: workspace-write
  turn_sandbox_policy: workspace-write
  stall_timeout_ms: 60000
---
You are an AI agent working on issue {{issue.identifier}}.
This is an E2E test environment. Complete the task and report success.
