---
"@gh-symphony/cli": minor
---

Scope orchestrator runtime state and inherited worker environments per project.
Project runtime files now live under project-specific `.runtime` directories
with owner-only permissions, and worker/hook processes no longer inherit
unscoped host secrets such as `GITHUB_GRAPHQL_TOKEN` by default. Fixes #439.
