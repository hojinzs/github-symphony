---
"@gh-symphony/cli": patch
---

Stop the orchestrator from authoring tracker comments during state transitions or linked pull request reconciliation (#907). The tracker-state API now rejects the retired `comment_body` field, and worker policy publishes status reports only after confirmed transition readback.
