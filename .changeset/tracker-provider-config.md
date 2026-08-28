---
"@gh-symphony/cli": minor
---

Normalize deprecated flat tracker settings into adapter-owned provider configuration while preserving compatibility lifecycle defaults until tracker adapters implement `defaultLifecycle()`. `active_states` and `terminal_states` must be YAML lists; comma-separated strings are rejected. Linear-specific provider validation now belongs to adapters and is not implemented in this release (#707).
