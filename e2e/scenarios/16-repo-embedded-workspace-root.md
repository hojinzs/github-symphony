# TC-16: Repo-embedded configured workspace root

## Setup

The Docker seed workflow declares
`workspace.root: .runtime/symphony-workspaces`. Build and start the standard
black-box environment:

```bash
GH_SYMPHONY_HTTP_TOKEN=e2e-http-token ./e2e/run-e2e.sh happy 45
```

## Assertions

1. Repo initialization persists distinct `repositoryDir` and `workspaceDir`
   values in the managed project configuration.
2. Dispatch creates the issue checkout beneath
   `/e2e/work/test-repo/.runtime/symphony-workspaces/<issue-key>`.
3. `workspace.json` remains beneath the orchestrator state directory and its
   `workspacePath` points at the configured root.
4. No issue checkout is populated beside `runs/`, `cache/`, or project state.

## Expected result

The regular happy-path lifecycle passes, and the runner prints
`Configured repo-embedded workspace root: YES`.
