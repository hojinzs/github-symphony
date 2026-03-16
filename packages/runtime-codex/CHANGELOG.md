# @gh-symphony/runtime-codex

## 0.0.9

### Patch Changes

- Interactive project selection, project add advanced options, CLI prompt alignment, and cancel exit code preservation

- Updated dependencies []:
  - @gh-symphony/core@0.0.9

## 0.0.8

### Patch Changes

- Issue-centric state model refactor, commander CLI migration, issue status endpoint, blocker normalization, and continuation retry fixes

- Updated dependencies []:
  - @gh-symphony/core@0.0.8

## 0.0.7

### Patch Changes

- feat: add project management skills and restructure initialization; remove control-plane app; harden project list status

- Updated dependencies []:
  - @gh-symphony/core@0.0.7

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

## 0.0.2

### Patch Changes

- 대규모 수정

- Updated dependencies []:
  - @gh-symphony/core@0.0.2
