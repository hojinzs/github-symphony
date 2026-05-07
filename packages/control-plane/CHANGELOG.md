# @gh-symphony/control-plane

## 0.0.15

### Patch Changes

- [#270](https://github.com/hojinzs/github-symphony/pull/270) [`07d60ac`](https://github.com/hojinzs/github-symphony/commit/07d60ac163683ade4e604026e21d62c28e779b23) Thanks [@moncher-dev](https://github.com/moncher-dev)! - Breaking API change: `/api/v1/state` no longer exposes orchestrator-side
  `projectId` or `slug`. Consumers should use the top-level
  `repository: { owner, name }` identifier, while tracker-side GitHub Project
  metadata is exposed under `tracker.settings.projectId` when configured.

- [#274](https://github.com/hojinzs/github-symphony/pull/274) [`6ebe9d5`](https://github.com/hojinzs/github-symphony/commit/6ebe9d550601bd0a2cc6a07f83a05e2a816b2b49) Thanks [@moncher-dev](https://github.com/moncher-dev)! - BREAKING: complete the single-repository orchestrator transition. Runtime
  state is now repo-local, project routing is no longer part of the public status
  surface, project configs use one canonical `repository`, and Docker E2E now
  validates the `git clone -> cd -> repo init -> repo start` golden path.
