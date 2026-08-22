# @gh-symphony/cli

## 0.10.0

### Minor Changes

- [#616](https://github.com/hojinzs/github-symphony/pull/616) [`d09e94d`](https://github.com/hojinzs/github-symphony/commit/d09e94d8aab97c432a8f096f4802274fedb00713) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Add resilient global bare-cache fallback, heartbeat protection, and cache status/prune diagnostics for [#588](https://github.com/hojinzs/github-symphony/issues/588).

- [#610](https://github.com/hojinzs/github-symphony/pull/610) [`4840d02`](https://github.com/hojinzs/github-symphony/commit/4840d02a8d3f206c0040525e626f9cef8313c4a8) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Document the completed standalone project lifecycle and folder-addressed CLI delivered for [#561](https://github.com/hojinzs/github-symphony/issues/561).

### Patch Changes

- [#605](https://github.com/hojinzs/github-symphony/pull/605) [`be9e533`](https://github.com/hojinzs/github-symphony/commit/be9e5338df2050f0066767d3ce01a3c42c735f5f) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Preserve successful API-side lifecycle completion when convergence follows unchanged local turns: the worker confirms canonical tracker state at turn boundaries and the convergence threshold, while the orchestrator protects only confirmed non-active completion that remains non-active at finalization and defers classification when that final read is unavailable ([#576](https://github.com/hojinzs/github-symphony/issues/576)). Canonical reads may consume live provider requests; active-state comments and PR updates remain governed by the local convergence counter.

- [#609](https://github.com/hojinzs/github-symphony/pull/609) [`f2a8a4f`](https://github.com/hojinzs/github-symphony/commit/f2a8a4f0734d28d0a2a43e912e1d5c6977d37bf0) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Prevent issue [#578](https://github.com/hojinzs/github-symphony/issues/578)'s stale active Project items from repeatedly dispatching after the source issue closes or a linked pull request merges by reconciling them to the workflow terminal state.

- [#618](https://github.com/hojinzs/github-symphony/pull/618) [`c5e8195`](https://github.com/hojinzs/github-symphony/commit/c5e8195ad78360bb21d76b42612a19bbd71ca065) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Fix [#589](https://github.com/hojinzs/github-symphony/issues/589) by resolving the active standalone project for multi-project `doctor` and `workflow preview` diagnostics, with standalone-specific selection guidance.

- [#608](https://github.com/hojinzs/github-symphony/pull/608) [`b4c5aae`](https://github.com/hojinzs/github-symphony/commit/b4c5aae97627ad9f68f10a2c0b0017c393227615) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Install a Land skill that completes already-merged pull requests before pre-flight or failure classification, preventing their issues from returning to Ready ([#577](https://github.com/hojinzs/github-symphony/issues/577)).

## 0.9.0

### Minor Changes

- [#601](https://github.com/hojinzs/github-symphony/pull/601) [`d84ab00`](https://github.com/hojinzs/github-symphony/commit/d84ab00ebd0397726f6cfc04d229789e3b3021b0) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Fix defects found while validating the standalone project model end to end:
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

### Patch Changes

- [#603](https://github.com/hojinzs/github-symphony/pull/603) [`43aa6dc`](https://github.com/hojinzs/github-symphony/commit/43aa6dc09e3b5ce8bbbb0854825bd800854d48e0) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Prevent a failed issue checkout from aborting the remaining dispatch candidates in the same orchestrator tick, and retain retry diagnostics for the failed issue ([#579](https://github.com/hojinzs/github-symphony/issues/579)).

- [#597](https://github.com/hojinzs/github-symphony/pull/597) [`c5493f7`](https://github.com/hojinzs/github-symphony/commit/c5493f7668cb9ee9f2c14b72d13a1d6c9ad9dff7) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Map GitHub Enterprise Server GraphQL endpoints to the correct REST API base for authenticated-user and issue-comment requests ([#497](https://github.com/hojinzs/github-symphony/issues/497)).

## 0.8.0

### Minor Changes

- [#595](https://github.com/hojinzs/github-symphony/pull/595) [`3fa7733`](https://github.com/hojinzs/github-symphony/commit/3fa773369fddceb025f8dfb3c8338fad7fdb9607) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Add standalone project lifecycle coverage, including project-scoped `.env`,
  MCP, worktree, and branch isolation for CLI users. ([#570](https://github.com/hojinzs/github-symphony/issues/570))

### Patch Changes

- [#590](https://github.com/hojinzs/github-symphony/pull/590) [`665039d`](https://github.com/hojinzs/github-symphony/commit/665039dd8d4a3484d9c69f9fb5a7fb52d4bc7659) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Populate `worktree-cache` project workspaces from the shared clone cache with project-scoped branches, including safe worktree cleanup. ([#565](https://github.com/hojinzs/github-symphony/issues/565))

- [#594](https://github.com/hojinzs/github-symphony/pull/594) [`77b52f9`](https://github.com/hojinzs/github-symphony/commit/77b52f9a82b28d6448b435c838b3dcbaa8cab4c8) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Inject layered global and project skills into each worker worktree attempt ([#567](https://github.com/hojinzs/github-symphony/issues/567)).

- [#587](https://github.com/hojinzs/github-symphony/pull/587) [`f34a881`](https://github.com/hojinzs/github-symphony/commit/f34a881a512535f1081e874b25c2b76d9cc589b4) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Add standalone project registration and project-directory daemon startup for [#569](https://github.com/hojinzs/github-symphony/issues/569).

## 0.7.14

### Patch Changes

- [#584](https://github.com/hojinzs/github-symphony/pull/584) [`2d8ed18`](https://github.com/hojinzs/github-symphony/commit/2d8ed183d910d4371dbf502f022b0624c71ab7f5) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Reuse a locked global bare repository cache for new issue workspaces, with 60-second fetch freshness and missing-ref refreshes. ([#564](https://github.com/hojinzs/github-symphony/issues/564))

- [#581](https://github.com/hojinzs/github-symphony/pull/581) [`262b8bf`](https://github.com/hojinzs/github-symphony/commit/262b8bfeaf33afd10556c4b51aa805287441e35c) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Validate standalone project configuration consistently when CLI-managed projects are loaded or saved, including [#562](https://github.com/hojinzs/github-symphony/issues/562) workflow-source defaults.

- [#586](https://github.com/hojinzs/github-symphony/pull/586) [`358c5d4`](https://github.com/hojinzs/github-symphony/commit/358c5d42388e2e5f60c209bf078f057f9204b8e9) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Compose layered MCP sidecars safely for Claude and Codex runtimes ([#568](https://github.com/hojinzs/github-symphony/issues/568)).

  When `runtime.isolation.trust_repo_config` is `false` (the default), Claude
  disables MCP auto-discovery to prevent untrusted repository commands from
  running. Move trusted user-wide servers to `~/.gh-symphony/mcp.json`, or set
  `runtime.isolation.trust_repo_config: true` to explicitly load a repository
  sidecar.

- [#583](https://github.com/hojinzs/github-symphony/pull/583) [`751212c`](https://github.com/hojinzs/github-symphony/commit/751212c0b2f2c3fce8c5f494137d77441ffdb501) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Resolve declared external workflow sources without loading repository policy, and surface a warning when an external workflow shadows the checkout `WORKFLOW.md` ([#563](https://github.com/hojinzs/github-symphony/issues/563)).

- [#585](https://github.com/hojinzs/github-symphony/pull/585) [`ca9eff2`](https://github.com/hojinzs/github-symphony/commit/ca9eff20cf0d47daebe14bf91d2f6a1f4a01d9b8) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Resolve standalone project workflow environment variables from the project's `.env` file ([#566](https://github.com/hojinzs/github-symphony/issues/566)).

## 0.7.13

### Patch Changes

- [#548](https://github.com/hojinzs/github-symphony/pull/548) [`1064dbe`](https://github.com/hojinzs/github-symphony/commit/1064dbe89a31e2ec3a43d01ab2e19992501fde06) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Recover advisory comment reconciliation safely from corrupt cache files and preserve entries without ETags ([#496](https://github.com/hojinzs/github-symphony/issues/496)).

- [#555](https://github.com/hojinzs/github-symphony/pull/555) [`8f59a9e`](https://github.com/hojinzs/github-symphony/commit/8f59a9e191e223e7c73ad4da20876aeb3a22d853) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Validate issue orchestration lifecycle transitions to expose invalid runtime state changes immediately ([#553](https://github.com/hojinzs/github-symphony/issues/553)).

- [#572](https://github.com/hojinzs/github-symphony/pull/572) [`9917f96`](https://github.com/hojinzs/github-symphony/commit/9917f96fcddf9cbef72b87b9f3bbd3a3dab5c5ba) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Use Claude stream-json results instead of stderr regex matching when a resumed session is rejected ([#554](https://github.com/hojinzs/github-symphony/issues/554)).

## 0.7.12

### Patch Changes

- [#573](https://github.com/hojinzs/github-symphony/pull/573) [`422c84a`](https://github.com/hojinzs/github-symphony/commit/422c84a1094ff4fe51b29f7d528f1159cd04e73c) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Use blobless worker checkouts and migrate legacy shallow workspaces so Land rebases retain a merge base ([#559](https://github.com/hojinzs/github-symphony/issues/559)).

## 0.7.11

### Patch Changes

- [#551](https://github.com/hojinzs/github-symphony/pull/551) [`e0c45e2`](https://github.com/hojinzs/github-symphony/commit/e0c45e2fac9bc398e537ae5fcbd0270f81e5f5d2) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Record GitHub comment mutation GraphQL costs in poll-cycle observability aggregates ([#492](https://github.com/hojinzs/github-symphony/issues/492)).

- [#550](https://github.com/hojinzs/github-symphony/pull/550) [`902ae09`](https://github.com/hojinzs/github-symphony/commit/902ae091204ff9ee22030507ab884b2b1d8f9f5b) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Safely refresh cached GitHub Project Status metadata after stale field or option IDs, and support Projects whose Status field falls beyond the first 20 fields ([#505](https://github.com/hojinzs/github-symphony/issues/505)).

- [#552](https://github.com/hojinzs/github-symphony/pull/552) [`396bacb`](https://github.com/hojinzs/github-symphony/commit/396bacbbbe61fe547356565936c56cfadff879dc) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Keep dispatching when a GitHub Project item is missing its configured Status, and report skipped tracker items without degrading the project tick. ([#549](https://github.com/hojinzs/github-symphony/issues/549))

- [#557](https://github.com/hojinzs/github-symphony/pull/557) [`303e4be`](https://github.com/hojinzs/github-symphony/commit/303e4be80a5588c3a5a6f8bb9de4d0d7d41cbf03) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Keep tracker-state transitions from blocking reconciliation while GitHub provider I/O waits for rate limits, and apply the transition queue backpressure limit per GitHub token ([#504](https://github.com/hojinzs/github-symphony/issues/504)).

- [#547](https://github.com/hojinzs/github-symphony/pull/547) [`bd5efd0`](https://github.com/hojinzs/github-symphony/commit/bd5efd0098e0e18a61c2c86cd46c4c9954a3a8f6) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Report daemon liveness accurately in `repo status`, including stale snapshot and adaptive polling status ([#546](https://github.com/hojinzs/github-symphony/issues/546)).

## 0.7.10

### Patch Changes

- [#542](https://github.com/hojinzs/github-symphony/pull/542) [`0b8482e`](https://github.com/hojinzs/github-symphony/commit/0b8482ec65abf77d5a0a16e75893b7ad101d346c) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Publish agent-authored status-transition comments from the orchestrator after confirmed tracker readback, with idempotent GitHub writes and durable failure diagnostics. ([#541](https://github.com/hojinzs/github-symphony/issues/541))

## 0.7.9

### Patch Changes

- [#533](https://github.com/hojinzs/github-symphony/pull/533) [`06c67cf`](https://github.com/hojinzs/github-symphony/commit/06c67cf9e4a008aaeb8c257a06506f377592c9c5) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Validate Codex approval and sandbox policy environment values and fail loudly on unknown values ([#530](https://github.com/hojinzs/github-symphony/issues/530)).

  For the current string-based `turn_sandbox_policy` setting, use the Codex app-server's `dangerFullAccess` value. The other app-server turn variants (`readOnly`, `externalSandbox`, and `workspaceWrite`) require structured fields that this setting cannot provide and are rejected rather than sent as incomplete payloads. The thread-level `thread_sandbox` values remain kebab-case (`read-only`, `workspace-write`, or `danger-full-access`).

## 0.7.8

### Patch Changes

- [#538](https://github.com/hojinzs/github-symphony/pull/538) [`401d44e`](https://github.com/hojinzs/github-symphony/commit/401d44ea1fd6e1e9fe6fce2d09f4fd465efe28e5) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Harden control-plane and dashboard HTTP responses with security headers, consistent UTF-8 content types, and sanitized request error logs ([#469](https://github.com/hojinzs/github-symphony/issues/469)).

- [`88578f2`](https://github.com/hojinzs/github-symphony/commit/88578f2e72f1c8835b975f62026239da1b541d78) - Post status transition comments before requesting the tracker transition so the reason survives reconciliation worker termination ([#530](https://github.com/hojinzs/github-symphony/issues/530)).

## 0.7.7

### Patch Changes

- [#535](https://github.com/hojinzs/github-symphony/pull/535) [`4ddcc26`](https://github.com/hojinzs/github-symphony/commit/4ddcc265d76e1947661525e8d839af03f623b9f1) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Bound convergence locks with a configurable TTL and record an expiration event so stale locks cannot permanently suppress an issue. ( hojinzs/github-symphony#529 )

- [#536](https://github.com/hojinzs/github-symphony/pull/536) [`39ea369`](https://github.com/hojinzs/github-symphony/commit/39ea369b0b5b42c7f633e4e3ffe689259405a51a) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Harden HTTP refresh input and Linear pagination for issue [#468](https://github.com/hojinzs/github-symphony/issues/468). As an explicit
  repository policy that diverges from the upstream configured-cadence behavior,
  workflow polling inputs are clamped to 1 second–5 minutes: smaller values run
  every second and larger values run every 5 minutes, while adaptive rate-limit
  backoff may still schedule a longer delay.

## 0.7.6

### Patch Changes

- [#532](https://github.com/hojinzs/github-symphony/pull/532) [`52e51cf`](https://github.com/hojinzs/github-symphony/commit/52e51cfbdb736b40f565b2293885fba3009214a8) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Classify reconciliation-canceled sessions separately from errors ([#452](https://github.com/hojinzs/github-symphony/issues/452)).

## 0.7.5

### Patch Changes

- [#534](https://github.com/hojinzs/github-symphony/pull/534) [`8a1285e`](https://github.com/hojinzs/github-symphony/commit/8a1285e5530bec8fd4212f42fba343100e1b0a5c) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Harden workspace path validation against traversal and symlink escapes across platforms (hojinzs/github-symphony#528).

- [#527](https://github.com/hojinzs/github-symphony/pull/527) [`2b1421a`](https://github.com/hojinzs/github-symphony/commit/2b1421a801e7fa73118bbcc617ff72b38134c2ff) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Protect `github_graphql` agent calls with shared GitHub GraphQL rate-limit guards and record measured request cost for issue [#481](https://github.com/hojinzs/github-symphony/issues/481).

- [#524](https://github.com/hojinzs/github-symphony/pull/524) [`fba1616`](https://github.com/hojinzs/github-symphony/commit/fba1616ec28cca69f40b0b3cb08e2cf3ff5fbf5b) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Serialize GitHub GraphQL rate-limit checks and recover from rate-limited responses with bounded retries for [#450](https://github.com/hojinzs/github-symphony/issues/450).

- [#525](https://github.com/hojinzs/github-symphony/pull/525) [`b5a417e`](https://github.com/hojinzs/github-symphony/commit/b5a417e0caed751fc02bfd4a52207671c5e610c9) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Bound Liquid prompt rendering resources and isolate untrusted issue bodies in worker prompts for [#449](https://github.com/hojinzs/github-symphony/issues/449).

- [#520](https://github.com/hojinzs/github-symphony/pull/520) [`ea5309a`](https://github.com/hojinzs/github-symphony/commit/ea5309a7967dfa897150d3616b932e5bd2319c11) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Redact free-form observability and doctor output secrets, including fine-grained GitHub PATs and URL-embedded credentials, for [#442](https://github.com/hojinzs/github-symphony/issues/442).

- [#531](https://github.com/hojinzs/github-symphony/pull/531) [`1cebb68`](https://github.com/hojinzs/github-symphony/commit/1cebb682f803c5dbf8f18e65468c6017fc325977) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Surface orchestrator hook and workspace cleanup failures, preserve cleanup-pending state when deletion fails, and guarantee project lock release during shutdown for [#451](https://github.com/hojinzs/github-symphony/issues/451).

## 0.7.4

### Patch Changes

- [#498](https://github.com/hojinzs/github-symphony/pull/498) [`e8bd944`](https://github.com/hojinzs/github-symphony/commit/e8bd944ddd9eb92ffbd8381679c336913460f29e) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Cache GitHub Project priority field definitions for the process lifetime to avoid repeated GraphQL requests on each listing cycle ([#479](https://github.com/hojinzs/github-symphony/issues/479)).

- [#518](https://github.com/hojinzs/github-symphony/pull/518) [`ea6d78a`](https://github.com/hojinzs/github-symphony/commit/ea6d78a6f921b4e42144786408f9399e57f111a0) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Prevent stale-run recovery from creating duplicate workers or leaving issue [#517](https://github.com/hojinzs/github-symphony/issues/517) runs falsely active, and make daemon/status process reconciliation safe across PID reuse and stale PID files.

- [#470](https://github.com/hojinzs/github-symphony/pull/470) [`252da2e`](https://github.com/hojinzs/github-symphony/commit/252da2e1bd69a3079318e899fd56bceba0b9cdfc) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Default HTTP servers to localhost, require bearer authentication for runtime APIs, and redact sensitive state fields for [#467](https://github.com/hojinzs/github-symphony/issues/467).

## 0.7.3

### Patch Changes

- [#515](https://github.com/hojinzs/github-symphony/pull/515) [`6e53e2a`](https://github.com/hojinzs/github-symphony/commit/6e53e2ad0fd77825f4029c98d6f0f2ed0f328f18) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Use GitHub Project V2 server-side terminal-state filtering while preserving exact unfiltered state lookups for custom workflow fields in [#475](https://github.com/hojinzs/github-symphony/issues/475).

- [#519](https://github.com/hojinzs/github-symphony/pull/519) [`1d0005b`](https://github.com/hojinzs/github-symphony/commit/1d0005b30e0ce1ab0f3be5f31c42c0a0ca099e38) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Report the GitHub authentication source used by CLI operations, aggregate failures across environment and `gh` credentials, and classify runtime authentication failures with typed errors for [#448](https://github.com/hojinzs/github-symphony/issues/448).

- [#514](https://github.com/hojinzs/github-symphony/pull/514) [`4034df7`](https://github.com/hojinzs/github-symphony/commit/4034df753eeac369515838a7e38946facc107b70) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Reuse each reconciliation cycle's project item snapshot for active-run state synchronization, removing the duplicate by-ID tracker lookup for [#478](https://github.com/hojinzs/github-symphony/issues/478).

## 0.7.2

### Patch Changes

- [#490](https://github.com/hojinzs/github-symphony/pull/490) [`97d0bcd`](https://github.com/hojinzs/github-symphony/commit/97d0bcdf4f29c9c69940141fc3987e84221ed33d) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Keep unrelated active workers running when targeted reconciliation narrows dispatch candidates for [#477](https://github.com/hojinzs/github-symphony/issues/477).

- [#500](https://github.com/hojinzs/github-symphony/pull/500) [`df99231`](https://github.com/hojinzs/github-symphony/commit/df9923171cf617c48863080fedb612a806fcf614) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Filter terminal GitHub Project items server-side during candidate polling to reduce pagination work.

## 0.7.1

### Patch Changes

- [#511](https://github.com/hojinzs/github-symphony/pull/511) [`3847eb9`](https://github.com/hojinzs/github-symphony/commit/3847eb98b4b349cd88cc4c273ec5cd237c976edf) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Remove the invalid `rateLimit` selection from GitHub GraphQL mutation documents (project item state transition, add/update issue comment). GitHub only defines `rateLimit` on the Query type, so every orchestrator-owned `Ready → In progress` transition failed schema validation with `Field 'rateLimit' doesn't exist on type 'Mutation'`. Mutation rate-limit telemetry now relies on the `x-ratelimit-*` response headers instead of an in-body field, and per-cycle GraphQL cost no longer counts a field-reported mutation cost.

## 0.7.0

### Minor Changes

- [#509](https://github.com/hojinzs/github-symphony/pull/509) [`49aa79f`](https://github.com/hojinzs/github-symphony/commit/49aa79faab85faf52360cc3ba83a7f1b6581e633) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Enforce issue identity at runtime ([#507](https://github.com/hojinzs/github-symphony/issues/507)). The engine now prepends an identity header binding every initial, continuation, and recovery turn to the run's issue regardless of the WORKFLOW.md template; workers fail closed at startup when the workspace origin, workspace key, or checked-out branch does not belong to the run's issue; codex events whose command cwd escapes the workspace boundary terminate the turn; dirty recovery workspaces whose branch or workpads belong to a different issue are quarantined (preserved under a `.quarantine-*` directory with a `recovery-quarantined` event) instead of being committed and pushed; and worker event logs append the untruncated event cwd so truncation can no longer fake a project-root working directory.

### Patch Changes

- [#509](https://github.com/hojinzs/github-symphony/pull/509) [`3d85cca`](https://github.com/hojinzs/github-symphony/commit/3d85ccadf81134f5a4b98048d9b9a657b6d4ffcf) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Forward run-scoped orchestrator context (`SYMPHONY_ORCHESTRATOR_URL`, `SYMPHONY_RUN_ID`, `SYMPHONY_ORCHESTRATOR_TOKEN`) through the Codex runtime plan so the agent-side `/gh-project` skill can authenticate tracker state reads and transition requests. The orchestrator injected these into the worker process since [#502](https://github.com/hojinzs/github-symphony/issues/502), but the codex app-server environment allowlist stripped them, so every run fail-closed on its first Project transition.

## 0.6.5

### Patch Changes

- [#502](https://github.com/hojinzs/github-symphony/pull/502) [`83ed23f`](https://github.com/hojinzs/github-symphony/commit/83ed23f97a30bf6ae42bcc92b23ba00bb08fc8f0) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Route GitHub Project state reads and transitions through a run-scoped orchestrator API with canonical-item readback, shared quota serialization, and transition telemetry ([#501](https://github.com/hojinzs/github-symphony/issues/501)).

## 0.6.4

### Patch Changes

- [#489](https://github.com/hojinzs/github-symphony/pull/489) [`b6e9a6d`](https://github.com/hojinzs/github-symphony/commit/b6e9a6d03ff6fdc33eacd9fe5dc6185fab6f7542) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Persist advisory comment identifiers and ETags for [#476](https://github.com/hojinzs/github-symphony/issues/476) so steady-state GitHub polling uses conditional REST requests instead of repeatedly paging issue comments.

## 0.6.3

### Patch Changes

- [#493](https://github.com/hojinzs/github-symphony/pull/493) [`5ffa19b`](https://github.com/hojinzs/github-symphony/commit/5ffa19b70d8c8ad89500f3c2b1db5ecad43124cc) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Reduce GitHub Project polling cost for [#473](https://github.com/hojinzs/github-symphony/issues/473) by omitting unused nested pull request label and assignee connections while retaining linked pull request identity and branch metadata.

## 0.6.2

### Patch Changes

- [#464](https://github.com/hojinzs/github-symphony/pull/464) [`41155b1`](https://github.com/hojinzs/github-symphony/commit/41155b19049a7da54f8b508fc37e6371dc17d6ec) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Surface corrupt file-tracker data, missing GitHub Project state metadata, and repeated invalid WORKFLOW.md reloads as observable errors instead of silent fallbacks for [#441](https://github.com/hojinzs/github-symphony/issues/441).

- [#466](https://github.com/hojinzs/github-symphony/pull/466) [`54709b7`](https://github.com/hojinzs/github-symphony/commit/54709b7f7908f60ddc2a98351d604d9c3bdf0e28) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Fence every worker turn with a short-lived orchestrator lease and fail closed when refresh availability is repeatedly lost for [#447](https://github.com/hojinzs/github-symphony/issues/447).

- [#488](https://github.com/hojinzs/github-symphony/pull/488) [`cd9e7ad`](https://github.com/hojinzs/github-symphony/commit/cd9e7ad78bd8b348ed7d5ea2d44f5d3541e66148) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Record GitHub GraphQL cost, remaining points, per-query breakdowns, and per-cycle totals in runtime tracker events for [#472](https://github.com/hojinzs/github-symphony/issues/472).

- [#462](https://github.com/hojinzs/github-symphony/pull/462) [`825c517`](https://github.com/hojinzs/github-symphony/commit/825c517355ce4dca8104580385859437671b84c7) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Reject non-HTTPS and private-network runtime fetch URLs, and restrict Linear GraphQL hosts, before sending credentials for [#444](https://github.com/hojinzs/github-symphony/issues/444).

- [#465](https://github.com/hojinzs/github-symphony/pull/465) [`d165c2a`](https://github.com/hojinzs/github-symphony/commit/d165c2a58c557d7969b4c181eb9ebe19d7bbcd8a) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Prevent duplicate orchestration and state loss with durable atomic writes, process-verified leases, and serialized CLI configuration updates for [#440](https://github.com/hojinzs/github-symphony/issues/440).

## 0.6.1

### Patch Changes

- [#460](https://github.com/hojinzs/github-symphony/pull/460) [`85ec441`](https://github.com/hojinzs/github-symphony/commit/85ec44100c2928822e11b9d1df5269eb50aeabef) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Generate WORKFLOW.md front matter through a YAML-safe serializer path so Linear tracker endpoint, project slug, and label input cannot inject sibling runtime configuration (fixes [#445](https://github.com/hojinzs/github-symphony/issues/445)).

- [#459](https://github.com/hojinzs/github-symphony/pull/459) [`e962d62`](https://github.com/hojinzs/github-symphony/commit/e962d62002b77dc7f9f2823c39e44ff8f9ea679f) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Harden token cache and Claude MCP runtime config writes for [#443](https://github.com/hojinzs/github-symphony/issues/443) by forcing secret files to `0600` and dedicated parent directories to `0700`.

## 0.6.0

### Minor Changes

- [#456](https://github.com/hojinzs/github-symphony/pull/456) [`b5492ef`](https://github.com/hojinzs/github-symphony/commit/b5492efb21ca8d3d126bd70977f86e48a8cf54a0) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Recover dirty issue workspaces after worker crashes by preserving git-status-based recovery context across retry restarts, fixing [#446](https://github.com/hojinzs/github-symphony/issues/446).

- [#455](https://github.com/hojinzs/github-symphony/pull/455) [`f8e78ef`](https://github.com/hojinzs/github-symphony/commit/f8e78ef4ad6687344c05a99b12707e71141a7a1b) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Scope orchestrator runtime state and inherited worker environments per project.
  Project runtime files now live under project-specific `.runtime` directories
  with owner-only permissions, and worker/hook processes no longer inherit
  unscoped host secrets such as `GITHUB_GRAPHQL_TOKEN` by default. Fixes [#439](https://github.com/hojinzs/github-symphony/issues/439).

### Patch Changes

- [#458](https://github.com/hojinzs/github-symphony/pull/458) [`cf7d19f`](https://github.com/hojinzs/github-symphony/commit/cf7d19f47ab6d7a8caf830ca8956a443e91e87ff) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Harden WORKFLOW.md execution for [#437](https://github.com/hojinzs/github-symphony/issues/437): repo hooks now require explicit trust approval, hook environments are allowlisted to strip secrets, and Codex agent commands launch as argv without `bash -lc`.

## 0.5.0

### Minor Changes

- [#435](https://github.com/hojinzs/github-symphony/pull/435) [`4499b07`](https://github.com/hojinzs/github-symphony/commit/4499b076f4fe3f828b12b8f76bcc8867bacc779f) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Fix [#434](https://github.com/hojinzs/github-symphony/issues/434) by scoping GitHub Project V2 dispatch to the daemon repository by default. GitHub tracker projects now use `project.repository` unless `tracker.settings.repository` overrides it with `owner/name`; set `tracker.settings.repository: "*"` to opt out and dispatch across all linked repositories.

## 0.4.11

### Patch Changes

- [#431](https://github.com/hojinzs/github-symphony/pull/431) [`1a6bef4`](https://github.com/hojinzs/github-symphony/commit/1a6bef4c2f5194b11a7bc6d6e04cf405d42482f5) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Reduce GitHub GraphQL rate-limit dispatch dead zones by allowing positive
  remaining budget to continue polling while scaling the orchestrator poll
  interval continuously as token headroom drops. Documents token separation for
  co-hosted repository orchestrators. Refs [#427](https://github.com/hojinzs/github-symphony/issues/427).

## 0.4.10

### Patch Changes

- [#426](https://github.com/hojinzs/github-symphony/pull/426) [`d524bda`](https://github.com/hojinzs/github-symphony/commit/d524bdaefc6ac2acf8f6b8d78739f405a14be070) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Hide stale incomplete-turn recovery from repo status and repo explain after issue workspace cleanup removes the backing workspace for [#421](https://github.com/hojinzs/github-symphony/issues/421).

## 0.4.9

### Patch Changes

- [#419](https://github.com/hojinzs/github-symphony/pull/419) [`6f42e48`](https://github.com/hojinzs/github-symphony/commit/6f42e484c1c41a42c68a000a0c8c0c1ca3d9b33f) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Improve repository CLI error/help UX for [#399](https://github.com/hojinzs/github-symphony/issues/399): missing `WORKFLOW.md` now points to `workflow init`, repo error paths honor `--json`, repo run/explain help shows the `<issue>` format, unknown repo/workflow subcommands are clearer, and removed repo commands are hidden from help.

- [#420](https://github.com/hojinzs/github-symphony/pull/420) [`022c158`](https://github.com/hojinzs/github-symphony/commit/022c158a357a32a401a835c69dde512534b0a06e) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Add runtime selection to `gh-symphony setup` so issue [#390](https://github.com/hojinzs/github-symphony/issues/390) users can choose Codex or Claude Code during onboarding, pass `--runtime` in non-interactive setup, and receive a clear install hint when the selected runtime command is missing from `PATH`.

## 0.4.8

### Patch Changes

- [#417](https://github.com/hojinzs/github-symphony/pull/417) [`2e23d6d`](https://github.com/hojinzs/github-symphony/commit/2e23d6d224a9b293ede3c1d8bc50ab97f3bdcd25) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Use the shared English GitHub auth remediation in interactive `gh-symphony setup` failures, covering missing `gh`, unauthenticated, missing-scope, and token validation errors. Fixes [#397](https://github.com/hojinzs/github-symphony/issues/397).

- [#416](https://github.com/hojinzs/github-symphony/pull/416) [`6b1b389`](https://github.com/hojinzs/github-symphony/commit/6b1b389291c6d8dd93e9cd73e5440c9036ed9e0d) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Fix issue [#396](https://github.com/hojinzs/github-symphony/issues/396) so `-v` / `--verbose` surfaces stack traces and error cause chains for top-level CLI and orchestrator failures, including daemon startup diagnostics.

## 0.4.7

### Patch Changes

- [#411](https://github.com/hojinzs/github-symphony/pull/411) [`c7c8e2d`](https://github.com/hojinzs/github-symphony/commit/c7c8e2da90765b512851127c4f96921134ce4760) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Fix issue [#389](https://github.com/hojinzs/github-symphony/issues/389) so `gh-symphony repo` subcommands honor the documented global `--config` / `GH_SYMPHONY_CONFIG_DIR` runtime override instead of silently falling back to the cwd repo runtime.

- [#405](https://github.com/hojinzs/github-symphony/pull/405) [`0c1b0b8`](https://github.com/hojinzs/github-symphony/commit/0c1b0b8ec53e250e5485417b4d22f0733544140e) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Propagate configured GitHub Enterprise GraphQL endpoints into worker environments, validate `doctor` against the resolved GHES host, and surface endpoint diagnostics for [#388](https://github.com/hojinzs/github-symphony/issues/388).

- [#407](https://github.com/hojinzs/github-symphony/pull/407) [`b4dda49`](https://github.com/hojinzs/github-symphony/commit/b4dda49ff556f7ec745107525baa4714c1614801) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Fix `gh-symphony repo logs --level` to derive levels from structured event types, include turn failures in error results, validate unsupported level values, and report empty filtered results clearly for issue [#386](https://github.com/hojinzs/github-symphony/issues/386).

## 0.4.6

### Patch Changes

- [#404](https://github.com/hojinzs/github-symphony/pull/404) [`2c856dc`](https://github.com/hojinzs/github-symphony/commit/2c856dc64c324fe09ce97035e57156453702f557) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Fix `gh-symphony repo logs` to show structured event reasons and print scanned run events in chronological order across runs.

## 0.4.5

### Patch Changes

- [#380](https://github.com/hojinzs/github-symphony/pull/380) [`71180cf`](https://github.com/hojinzs/github-symphony/commit/71180cf7980ba9f5567821c7f00112f202bf1167) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Stop forcing Codex app-server workers for [#378](https://github.com/hojinzs/github-symphony/issues/378) into a staged `.codex-agent` home by default, so local runs consistently use the caller's normal Codex home unless `CODEX_HOME` is explicitly provided.

## 0.4.4

### Patch Changes

- [#379](https://github.com/hojinzs/github-symphony/pull/379) [`aa1cc8c`](https://github.com/hojinzs/github-symphony/commit/aa1cc8c43ce8652d789360fca9a9fc2f6adb9843) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Add `gh-symphony workflow init --tracker linear --linear-project-slug <slug>` so Linear-backed repositories can generate `WORKFLOW.md` without GitHub Project selection or GitHub tracker auth.

## 0.4.3

### Patch Changes

- [#376](https://github.com/hojinzs/github-symphony/pull/376) [`3d7e87b`](https://github.com/hojinzs/github-symphony/commit/3d7e87bc1e43d58d8eab3894343cab4024f5b578) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Fix `gh-symphony doctor` so Linear tracker runtime configs validate Linear project access instead of resolving the Linear project slug as a GitHub Project node ID.

## 0.4.2

### Patch Changes

- [#372](https://github.com/hojinzs/github-symphony/pull/372) [`248e1cc`](https://github.com/hojinzs/github-symphony/commit/248e1cc97020f1f1b620d453e5f1ccf15fa908ea) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Fix [#363](https://github.com/hojinzs/github-symphony/issues/363) by parsing YAML inline comments out of WORKFLOW frontmatter scalar values before repo init persists GitHub Project bindings.

## 0.4.1

### Patch Changes

- [#368](https://github.com/hojinzs/github-symphony/pull/368) [`b6d7600`](https://github.com/hojinzs/github-symphony/commit/b6d7600ec84b34f005b4626912448a36d5219b0c) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Stop generating repo-local `.gh-symphony/` ecosystem files for [#360](https://github.com/hojinzs/github-symphony/issues/360), keep
  `--skip-context` as a deprecated no-op, and offer interactive cleanup for legacy
  context/reference files.

## Unreleased

- The `.gh-symphony/` directory is no longer generated. Existing files are safe
  to delete; the legacy-directory prompt during `setup` / `workflow init` will
  offer to clean up for you.

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

- Large-scale changes

- Updated dependencies []:
  - @gh-symphony/core@0.0.2
  - @gh-symphony/orchestrator@0.0.2
  - @gh-symphony/tracker-github@0.0.2
  - @gh-symphony/worker@0.0.2
