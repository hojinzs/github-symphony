---
"@gh-symphony/cli": patch
---

Harden WORKFLOW.md execution for #437: repo hooks now require explicit trust approval, hook environments are allowlisted to strip secrets, and Codex agent commands launch as argv without `bash -lc`.
