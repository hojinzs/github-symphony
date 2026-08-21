---
"@gh-symphony/cli": patch
---

Preserve successful API-side lifecycle completion when convergence follows unchanged local turns: the worker confirms canonical tracker state at turn boundaries and the convergence threshold, and the orchestrator protects only confirmed non-active completion from reconciliation suppression (#576). Canonical reads may consume live provider requests; active-state comments and PR updates remain governed by the local convergence counter.
