---
"@gh-symphony/cli": patch
---

Move the GitHub assignee filter to `gh-symphony repo start --assigned-only`, stop persisting new setup/repo init state for it, and keep legacy `tracker.settings.assignedOnly` configs working with a deprecation warning for #348.
