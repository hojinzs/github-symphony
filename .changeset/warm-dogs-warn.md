---
"@gh-symphony/cli": patch
---

Keep dirty recovery workspaces in place and continue with an observable warning instead of quarantining or attributing their changes. Recovery from a workspace on another issue's branch now starts from a stable fresh path while reporting the retained path and branch (#905).
