---
"@gh-symphony/cli": major
---

Remove the `gh-symphony instances` command, the host-global orchestrator instance registry, and the registry-backed `project start --allow-duplicate` option (#906). The removal also drops the cross-runtime-root check that prevented starting the same project twice; project locks continue to prevent duplicate starts within one runtime root.

The `instance` field is no longer present in `project list` JSON output. Use `project status --project-dir <path>` for daemon liveness and runtime status. Existing daemon PID records and project locks continue to support the project lifecycle commands.

After upgrading, `~/.gh-symphony/instances/` is unused and can be deleted manually.
