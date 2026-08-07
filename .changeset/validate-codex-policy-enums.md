---
"@gh-symphony/cli": patch
---

Validate Codex approval and sandbox policy environment values and fail loudly on unknown values (#530).

For the current string-based `turn_sandbox_policy` setting, use the Codex app-server's `dangerFullAccess` value. The other app-server turn variants (`readOnly`, `externalSandbox`, and `workspaceWrite`) require structured fields that this setting cannot provide and are rejected rather than sent as incomplete payloads. The thread-level `thread_sandbox` values remain kebab-case (`read-only`, `workspace-write`, or `danger-full-access`).
