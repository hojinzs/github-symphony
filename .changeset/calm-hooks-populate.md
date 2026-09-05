---
"@gh-symphony/cli": patch
---

Move repository population out of the orchestrator and into the shipped default `after_create` hook, preserving fresh-workspace cleanup and non-destructive reuse (#901).
