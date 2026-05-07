---
"@gh-symphony/core": minor
"@gh-symphony/dashboard": minor
"@gh-symphony/control-plane": minor
---

Breaking API change: `/api/v1/state` no longer exposes orchestrator-side
`projectId` or `slug`. Consumers should use the top-level
`repository: { owner, name }` identifier, while tracker-side GitHub Project
metadata is exposed under `tracker.settings.projectId` when configured.
