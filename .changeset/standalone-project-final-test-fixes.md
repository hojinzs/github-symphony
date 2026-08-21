---
"@gh-symphony/cli": minor
---

Fix defects found while validating the standalone project model end to end:

- GitHub Project tracker now honors `tracker.pickup_labels`. Label-disjoint projects that
  share one repository previously dispatched each other's issues despite those labels being
  intended to keep project mappings disjoint.
- The shared bare-clone cache re-points `origin` and refetches when a project's clone URL
  changes, instead of serving the previously cached remote forever.
- An explicit `--config <dir>` is exported to the environment so the bare-clone cache and
  spawned workers use the same directory as the rest of the CLI state.
- The standalone shadow warning reads the shared bare cache instead of the process working
  directory, so it names the repository that actually commits a `WORKFLOW.md` rather than
  whichever directory the CLI was started from.
- `gh-symphony doctor` validates the folder-addressed project `WORKFLOW.md` for standalone
  projects instead of reporting the repository root file as missing.
- Standalone projects create issue workspaces under their `workspace.root` (spec 9.1), resolved
  relative to the project folder and defaulting to `<project-dir>/.runtime/workspaces`, instead of
  inside the runtime state directory. Repo-embedded projects are unchanged.
- **Breaking (unreleased standalone surface):** `gh-symphony project add` is removed. `project
start|status|stop` now address the project folder itself — the working directory by default, or
  `--project-dir <path>` — and derive the runtime configuration from its `WORKFLOW.md` on every
  start, so an edited workflow no longer needs re-registration and no active-project state decides
  which project runs. Tracker-mapping overlap is validated at start instead of at registration, and
  an overlap with an already running project is refused outright.
- `WORKFLOW.md` accepts `repository.clone_url` to override the derived clone URL for mirrors,
  Enterprise hosts, or local paths.
