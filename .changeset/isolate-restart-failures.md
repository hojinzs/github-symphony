---
"@gh-symphony/cli": patch
---

Isolate failed orchestrator retry restarts so a poison-pill workspace failure is retried with backoff without aborting reconciliation for other runs (#656).
