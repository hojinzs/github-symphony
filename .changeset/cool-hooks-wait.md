---
"@gh-symphony/cli": patch
---

Validate project-root and absolute workflow hook scripts before dispatch when hook execution is trusted, surface workspace-relative hooks as deferred until reconciliation, and report invalid hook paths in the default doctor diagnostics for #929. Disabled hooks remain non-blocking, while doctor still diagnoses their paths. Bare command names are script paths relative to the hook's execution directory, so missing bare-name scripts now fail validation instead of being treated as inline commands.
