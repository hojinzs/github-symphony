---
"@gh-symphony/cli": minor
---

@gh-symphony/cli: BREAKING — restructure CLI to repo-centric model

- Removed: top-level `start`, `stop`, `status`, `run`, `recover`, `logs`, `init`
- Removed: `project` namespace (add/list/remove/switch/start/stop/status/explain)
- Removed: `repo add`, `repo remove`, `repo sync`, `repo list`
- Added: `repo run`, `repo recover`, `repo logs`, `repo explain`
- The orchestrator now binds strictly to the cwd repository via `repo init`.
  Per-repo runtime: `<repo>/.runtime/orchestrator/`.
- Migrate by running `gh-symphony repo init` in each target repository.
