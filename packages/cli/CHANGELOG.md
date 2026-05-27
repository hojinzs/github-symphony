# @gh-symphony/cli

## 0.4.0

### Minor Changes

- [#364](https://github.com/hojinzs/github-symphony/pull/364) [`3a88c2e`](https://github.com/hojinzs/github-symphony/commit/3a88c2e562871bb19ac4b5f3f5f6d18bbc5a6d9f) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Add composable `/gh-symphony` workflow reference files for schema and prompt-body postures, and generate multi-file skill directories for issue [#359](https://github.com/hojinzs/github-symphony/issues/359).

### Patch Changes

- [#367](https://github.com/hojinzs/github-symphony/pull/367) [`5b67c78`](https://github.com/hojinzs/github-symphony/commit/5b67c780151f34eee0869d4d008b69158f36c701) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Recover incomplete Codex turns that leave dirty issue workspaces by surfacing recovery diagnostics and redispatching with explicit dirty-workspace recovery context for [#365](https://github.com/hojinzs/github-symphony/issues/365).

## 0.3.0

### Minor Changes

- [#358](https://github.com/hojinzs/github-symphony/pull/358) [`1e828e1`](https://github.com/hojinzs/github-symphony/commit/1e828e1b4ef61a32798c5386127fdd5ea42b7645) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Make `blocker_check_states` an explicit setup/workflow init choice for [#357](https://github.com/hojinzs/github-symphony/issues/357), always serialize empty blocker selections, add independent `planning_states` for worker phase classification, and default missing blocker config to disabled instead of implicit `Todo`.

## 0.2.5

### Patch Changes

- [#353](https://github.com/hojinzs/github-symphony/pull/353) [`b983699`](https://github.com/hojinzs/github-symphony/commit/b983699c997295e62e61e847db2b6f23a137ba8b) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Fail fast during `gh-symphony repo start` when GitHub tracker authentication is missing, invalid, or lacks required scopes, with guided `gh auth` remediation for issue [#350](https://github.com/hojinzs/github-symphony/issues/350). Linear tracker starts now also require `LINEAR_API_KEY` to be present before orchestration begins.

## 0.2.4

### Patch Changes

- [#354](https://github.com/hojinzs/github-symphony/pull/354) [`40bb6ea`](https://github.com/hojinzs/github-symphony/commit/40bb6ea3033e2bd182c2ea8b74a866ea81906e18) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Add Linear tracker support for the runtime `--assigned-only` filter so issue polling can be scoped to Linear issues assigned to the API key identity. References [#349](https://github.com/hojinzs/github-symphony/issues/349).

## 0.2.3

### Patch Changes

- [#351](https://github.com/hojinzs/github-symphony/pull/351) [`87a42e6`](https://github.com/hojinzs/github-symphony/commit/87a42e6b6808fff8a88b8c9c9f3147f0ba9de750) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Move the GitHub assignee filter to `gh-symphony repo start --assigned-only`, stop persisting new setup/repo init state for it, and keep legacy `tracker.settings.assignedOnly` configs working with a deprecation warning for [#348](https://github.com/hojinzs/github-symphony/issues/348).

## 0.2.2

### Patch Changes

- [#346](https://github.com/hojinzs/github-symphony/pull/346) [`f6f6b40`](https://github.com/hojinzs/github-symphony/commit/f6f6b40a3a8d69c5be31b9d5f174ff6dee01a8b1) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Add explicit dispatch priority mappings for GitHub Project V2 workflows from issue [#236](https://github.com/hojinzs/github-symphony/issues/236), including `tracker.priority` configuration, generated setup/init mappings, drift diagnostics, and no-fallback runtime behavior while preserving legacy `tracker.priority_field` compatibility.

## 0.2.1

### Patch Changes

- [#344](https://github.com/hojinzs/github-symphony/pull/344) [`3d4fecc`](https://github.com/hojinzs/github-symphony/commit/3d4fecc8b446b44dc386e3584839c7ac6767e086) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Fix worker convergence detection so clean workspaces after successful commits are treated as productive when Git HEAD advances, preventing false `convergence_detected: workspace unchanged` failures for issue [#343](https://github.com/hojinzs/github-symphony/issues/343).

## 0.2.0

### Minor Changes

- [#333](https://github.com/hojinzs/github-symphony/pull/333) [`364e090`](https://github.com/hojinzs/github-symphony/commit/364e09051762bcb5a5da0ba0ac6d222a76d82c54) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Add Linear tracker support for issue [#312](https://github.com/hojinzs/github-symphony/issues/312), including WORKFLOW.md validation for `tracker.kind: linear` and `tracker.project_slug`, orchestrator polling through the Linear adapter, and runtime-managed `linear_graphql` worker access.

## 0.1.4

### Patch Changes

- [#330](https://github.com/hojinzs/github-symphony/pull/330) [`330a625`](https://github.com/hojinzs/github-symphony/commit/330a625c6fa7902379c4c3af1de3f9c1cd665e28) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Fix claude-print worker turns for issue [#329](https://github.com/hojinzs/github-symphony/issues/329) by sending Claude Code 2.1.x-compatible stream-json user messages and surfacing Claude stderr in runtime failure reports.

## 0.1.3

### Patch Changes

- [#326](https://github.com/hojinzs/github-symphony/pull/326) [`66686f4`](https://github.com/hojinzs/github-symphony/commit/66686f4a3b3a2034c551d9218cedaebf5d871f7e) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Keep Symphony-managed Claude MCP config in the issue runtime directory so retries do not fail on a generated workspace `.mcp.json` dirty status. Fixes [#325](https://github.com/hojinzs/github-symphony/issues/325).

## 0.1.2

### Patch Changes

- [#304](https://github.com/hojinzs/github-symphony/pull/304) [`826c6ae`](https://github.com/hojinzs/github-symphony/commit/826c6ae1e9e5e379f9c620595a9e837af2021aaa) Thanks [@hojinzs](https://github.com/hojinzs)! - Expose normalized linked pull request prompt variables, including top-level `issue.linked_pull_requests` entries with missing optional PR fields represented as `null`.

## 0.1.1

### Patch Changes

- [#319](https://github.com/hojinzs/github-symphony/pull/319) [`d82f0da`](https://github.com/hojinzs/github-symphony/commit/d82f0da65dcac3ec136c9f7c4d8c726489415673) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Allow `gh-symphony init` Claude runtime preflight to pass with Claude Code local authentication instead of requiring `ANTHROPIC_API_KEY`.

## 0.1.0

### Minor Changes

- [#306](https://github.com/hojinzs/github-symphony/pull/306) [`d5fbb53`](https://github.com/hojinzs/github-symphony/commit/d5fbb5350ce5ea89484cf46dbf0699e48859984b) Thanks [@moncher-dev](https://github.com/moncher-dev)! - @gh-symphony/cli: BREAKING — restructure CLI to repo-centric model
  - Removed: top-level `start`, `stop`, `status`, `run`, `recover`, `logs`, `init`
  - Removed: `project` namespace (add/list/remove/switch/start/stop/status/explain)
  - Removed: `repo add`, `repo remove`, `repo sync`, `repo list`
  - Added: `repo run`, `repo recover`, `repo logs`, `repo explain`
  - The orchestrator now binds strictly to the cwd repository via `repo init`.
    Per-repo runtime: `<repo>/.runtime/orchestrator/`.
  - Migrate by running `gh-symphony repo init` in each target repository.

## 0.0.22

### Patch Changes

- [#269](https://github.com/hojinzs/github-symphony/pull/269) [`adbdd07`](https://github.com/hojinzs/github-symphony/commit/adbdd07acf5da01494789036ef125af361392700) Thanks [@moncher-dev](https://github.com/moncher-dev)! - BREAKING: switch repository orchestration commands to the cwd-based single-repo workflow. `gh-symphony repo init/start/status/stop` now use repo-local `.runtime/orchestrator` state, `--project-id` is rejected with a removal error, and `repo init` migrates a single legacy `.runtime/orchestrator/projects/<projectId>` directory while failing with manual cleanup guidance for multiple legacy project directories.

- [#274](https://github.com/hojinzs/github-symphony/pull/274) [`6ebe9d5`](https://github.com/hojinzs/github-symphony/commit/6ebe9d550601bd0a2cc6a07f83a05e2a816b2b49) Thanks [@moncher-dev](https://github.com/moncher-dev)! - BREAKING: complete the single-repository orchestrator transition. Runtime
  state is now repo-local, project routing is no longer part of the public status
  surface, project configs use one canonical `repository`, and Docker E2E now
  validates the `git clone -> cd -> repo init -> repo start` golden path.

## Unreleased

### Minor Changes

- BREAKING: switch repository orchestration commands to the cwd-based single-repo workflow. `gh-symphony repo init/start/status/stop` now use repo-local `.runtime/orchestrator` state, `--project-id` is rejected with a removal error, and `repo init` migrates a single legacy `.runtime/orchestrator/projects/<projectId>` directory while failing with manual cleanup guidance for multiple legacy project directories.

## 0.0.21

### Patch Changes

- [#259](https://github.com/hojinzs/github-symphony/pull/259) [`9caeded`](https://github.com/hojinzs/github-symphony/commit/9caededa6e979eee71efc64a565f36953c55556b) Thanks [@hojinzs](https://github.com/hojinzs)! - Add Claude as a first-class agent runtime alongside Codex. The CLI now lets you pick a runtime during `init`, runs Claude preflight checks (auth, broker probe), and ships a `claude -p` spawn-loop adapter with session-id persistence, stream-json event mapping, prompt constraints, and a composed GitHub GraphQL MCP config. Worker agent events are normalized to runtime-neutral names and the workflow `runtime` block is parsed in core.

## 0.0.20

### Patch Changes

- [#196](https://github.com/hojinzs/github-symphony/pull/196) [`9a5dcca`](https://github.com/hojinzs/github-symphony/commit/9a5dcca7dc5549091b3f4e2c9f99a828f6d1b5a4) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Align worker session restarts with the Symphony spec so active issues are not suppressed after legacy issue-level budget totals are exceeded.

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
