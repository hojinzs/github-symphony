---
"@gh-symphony/cli": patch
---

Preserve legacy `codex` timeout declarations when a runtime block omits all or part of `runtime.timeouts`, and report each effective timeout's source through the `runtimeTimeoutSources` validation summary (#888).
