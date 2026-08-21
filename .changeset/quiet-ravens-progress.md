---
"@gh-symphony/cli": patch
---

Preserve successful API-side lifecycle completion when convergence follows unchanged local turns: the worker confirms canonical tracker state, and the orchestrator protects the successful exit from reconciliation suppression (#576). Active-state comments and PR updates remain governed by the local convergence counter.
