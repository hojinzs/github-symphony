---
"@gh-symphony/cli": patch
---

Stop a worker before its next turn when a refreshed tracker snapshot shows the issue is no longer dispatchable or no longer satisfies `required_labels` (#722).
