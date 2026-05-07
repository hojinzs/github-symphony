---
"@gh-symphony/cli": patch
---

BREAKING: switch repository orchestration commands to the cwd-based single-repo workflow. `gh-symphony repo init/start/status/stop` now use repo-local `.runtime/orchestrator` state, `--project-id` is rejected with a removal error, and `repo init` migrates a single legacy `.runtime/orchestrator/projects/<projectId>` directory while failing with manual cleanup guidance for multiple legacy project directories.
