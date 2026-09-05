---
"@gh-symphony/cli": major
---

Remove the `gh-symphony instances` command, the host-global orchestrator instance registry, and the registry-backed `project start --allow-duplicate` option (#906). Project lifecycle commands continue to use project folders, daemon PID records, and project locks.
