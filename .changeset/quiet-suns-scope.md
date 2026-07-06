---
"@gh-symphony/cli": minor
---

Fix #434 by scoping GitHub Project V2 dispatch to the daemon repository by default. GitHub tracker projects now use `project.repository` unless `tracker.settings.repository` overrides it with `owner/name`; set `tracker.settings.repository: "*"` to opt out and dispatch across all linked repositories.
