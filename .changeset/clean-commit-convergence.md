---
"@gh-symphony/cli": patch
---

Fix worker convergence detection so clean workspaces after successful commits are treated as productive when Git HEAD advances, preventing false `convergence_detected: workspace unchanged` failures for issue #343.
