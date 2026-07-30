---
"@gh-symphony/cli": patch
---

Reduce GitHub Project polling cost for #473 by omitting unused nested pull request label and assignee connections while retaining linked pull request identity and branch metadata.
