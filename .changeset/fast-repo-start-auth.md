---
"@gh-symphony/cli": minor
---

Fail fast during `gh-symphony repo start` when GitHub tracker authentication is missing, invalid, or lacks required scopes, with guided `gh auth` remediation for issue #350. Linear tracker starts now also require `LINEAR_API_KEY` to be present before orchestration begins.
