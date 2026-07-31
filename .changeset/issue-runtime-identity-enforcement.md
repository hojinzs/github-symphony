---
"@gh-symphony/cli": minor
---

Enforce issue identity at runtime (#507). The engine now prepends an identity header binding every initial, continuation, and recovery turn to the run's issue regardless of the WORKFLOW.md template; workers fail closed at startup when the workspace origin, workspace key, or checked-out branch does not belong to the run's issue; codex events whose command cwd escapes the workspace boundary terminate the turn; dirty recovery workspaces whose branch or workpads belong to a different issue are quarantined (preserved under a `.quarantine-*` directory with a `recovery-quarantined` event) instead of being committed and pushed; and worker event logs append the untruncated event cwd so truncation can no longer fake a project-root working directory.
