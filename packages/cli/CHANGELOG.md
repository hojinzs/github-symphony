# @gh-symphony/cli

## 0.0.19

### Patch Changes

- [`c1e26ab`](https://github.com/hojinzs/github-symphony/commit/c1e26ab6aee442a33e57130f272372eca0ef4f87) Thanks [@hojinzs](https://github.com/hojinzs)! - Add upgrade, setup, repo sync, start --once, and doctor --fix commands with various bug fixes for token auth, assigned-only flags, and orchestrator redispatch

  ### New Commands
  - `upgrade`: self-upgrade CLI
  - `setup`: one-command setup flow
  - `repo sync`: sync repository configurations
  - `start --once`: single-run mode
  - `doctor --fix`: auto-remediation mode
  - `init --dry-run`: preview mode before initialization
  - workflow authoring commands

  ### Bug Fixes
  - Fix token fallback validation and env token priority in interactive auth
  - Fix assigned-only flag preservation in interactive setup
  - Fix repo sync prune order
  - Fix orchestrator redispatch for re-entered active issues
  - Fix doctor to fail fast when git probe breaks

## 0.0.18

### Patch Changes

- [`8bb3618`](https://github.com/hojinzs/github-symphony/commit/8bb361859bbf02e8aa470b4c56188943544ce85a) Thanks [@hojinzs](https://github.com/hojinzs)! - Fix GitHub tracker polling rate-limit backoff and harden orchestrator retry suppression per issue

## 0.0.17

### Patch Changes

- fix(cli): inject version at build time and bundle worker entrypoint

## 0.0.16

### Patch Changes

- fix(release): bundle worker entrypoint for standalone CLI deployment

## 0.0.15

### Patch Changes

- refactor(release): bundle internal packages and publish only cli
  - Switch to tsup bundling with all @gh-symphony/\* packages inlined
  - Mark internal packages as private (no longer published to npm)
  - Add git tag and GitHub Release creation on publish
  - Configure OIDC trusted publisher environment

## 0.0.11

### Patch Changes

- Updated dependencies []:
  - @gh-symphony/core@0.0.11
  - @gh-symphony/orchestrator@0.0.11
  - @gh-symphony/tracker-github@0.0.11
  - @gh-symphony/worker@0.0.11

## 0.0.10

### Patch Changes

- fix(core): remove duplicate "workspaces" segment in issue workspace path resolution — fixes ENOENT when provisioning issue workspaces

- Updated dependencies []:
  - @gh-symphony/core@0.0.10
  - @gh-symphony/orchestrator@0.0.10
  - @gh-symphony/tracker-github@0.0.10
  - @gh-symphony/worker@0.0.10

## 0.0.9

### Patch Changes

- Interactive project selection, project add advanced options, CLI prompt alignment, and cancel exit code preservation

- Updated dependencies []:
  - @gh-symphony/core@0.0.9
  - @gh-symphony/orchestrator@0.0.9
  - @gh-symphony/tracker-github@0.0.9
  - @gh-symphony/worker@0.0.9

## 0.0.8

### Patch Changes

- Issue-centric state model refactor, commander CLI migration, issue status endpoint, blocker normalization, and continuation retry fixes

- Updated dependencies []:
  - @gh-symphony/core@0.0.8
  - @gh-symphony/orchestrator@0.0.8
  - @gh-symphony/tracker-github@0.0.8
  - @gh-symphony/worker@0.0.8

## 0.0.7

### Patch Changes

- feat: add project management skills and restructure initialization; remove control-plane app; harden project list status

- Updated dependencies []:
  - @gh-symphony/core@0.0.7
  - @gh-symphony/orchestrator@0.0.7
  - @gh-symphony/tracker-github@0.0.7
  - @gh-symphony/worker@0.0.7

## 0.0.6

### Patch Changes

- [`3d2cfd7`](https://github.com/hojinzs/github-symphony/commit/3d2cfd781b6581b3071d1ccf26f8c0c7dca37701) Thanks [@hojinzs](https://github.com/hojinzs)! - Fix assigned-only filter, status watch refresh, and dashboard display issues.
  - feat: add `assignedOnly` tracker filter to limit issues to the authenticated user ([#4](https://github.com/hojinzs/github-symphony/issues/4))
  - fix: correct `gh auth status` stdout parsing for assigned-only prompt ([#4](https://github.com/hojinzs/github-symphony/issues/4))
  - fix: validate string settings in tracker-github config ([#5](https://github.com/hojinzs/github-symphony/issues/5))
  - fix: refresh status watch snapshots promptly on tick ([#5](https://github.com/hojinzs/github-symphony/issues/5))
  - fix: fix ID truncation, missing STAGE column, and token tracking in dashboard ([#5](https://github.com/hojinzs/github-symphony/issues/5))

- Fix idempotent workspace bootstrap and simplify tenant configuration.
  - fix(worker): make `after_create` repository bootstrap idempotent — reuse existing checkout via `git pull --ff-only` instead of re-cloning; fail explicitly when the directory exists but is not a git repository ([#9](https://github.com/hojinzs/github-symphony/issues/9))
  - fix(control-plane): update default hook generation to match idempotent bootstrap behaviour ([#9](https://github.com/hojinzs/github-symphony/issues/9))
  - refactor(cli): simplify `project add` by removing status-mapping lookup, runtime selection, and per-project `WORKFLOW.md` / `workflow-mapping.json` generation ([#7](https://github.com/hojinzs/github-symphony/issues/7))
  - refactor(core): remove `runtime` block from `OrchestratorProjectConfig`; orchestrator now resolves runtime exclusively from per-repository `WORKFLOW.md` ([#7](https://github.com/hojinzs/github-symphony/issues/7))

- Updated dependencies [[`3d2cfd7`](https://github.com/hojinzs/github-symphony/commit/3d2cfd781b6581b3071d1ccf26f8c0c7dca37701)]:
  - @gh-symphony/core@0.0.6
  - @gh-symphony/orchestrator@0.0.6
  - @gh-symphony/tracker-github@0.0.6
  - @gh-symphony/worker@0.0.6

## 0.0.2

### Patch Changes

- 대규모 수정

- Updated dependencies []:
  - @gh-symphony/core@0.0.2
  - @gh-symphony/orchestrator@0.0.2
  - @gh-symphony/tracker-github@0.0.2
  - @gh-symphony/worker@0.0.2
