---
"@gh-symphony/cli": patch
---

Fix #784 by routing `doctor --smoke` through the configured Linear tracker adapter without requiring a GitHub Project binding, including support for explicit identifiers such as `DEV-54`.
