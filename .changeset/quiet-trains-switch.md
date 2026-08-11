---
"@gh-symphony/cli": patch
---

Keep tracker-state transitions from blocking reconciliation while GitHub provider I/O waits for rate limits, and apply the transition queue backpressure limit per GitHub token (#504).
