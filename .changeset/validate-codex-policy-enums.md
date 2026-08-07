---
"@gh-symphony/cli": patch
---

Validate Codex approval and sandbox policy environment values and fail loudly on unknown values (#530).

When configuring `turn_sandbox_policy`, use the Codex app-server's camelCase values (`dangerFullAccess`, `readOnly`, `externalSandbox`, or `workspaceWrite`). The thread-level `thread_sandbox` values remain kebab-case (`read-only`, `workspace-write`, or `danger-full-access`).
