# Rollout checklist

## Internal feature flag

- Gate workspace provisioning behind an internal feature flag before exposing the UI broadly.
- Keep a known-good Symphony image tag available for rollback.

## Operational checks

- Verify `DATABASE_URL`, GitHub token scopes, and Docker socket access before enabling provisioning.
- Run `pnpm lint`, `pnpm test`, `pnpm typecheck`, and `pnpm build` on every release candidate.
- Run `DATABASE_URL='postgresql://postgres:postgres@localhost:5432/github_symphony' pnpm prisma:validate` before applying schema changes.

## Runtime health

- Confirm each workspace has a persisted `SymphonyInstance` record with container ID, port, and workflow path.
- Poll each worker `/api/v1/state` endpoint after deployment and alert on degraded or missing responses.
- Reconcile failed provisions by removing orphaned containers and marking the instance `failed` before retrying.

## GitHub integration

- Validate the GitHub App installation has write access for repository contents, issues, pull requests, and the relevant GitHub Project scope before creating workspaces or issues.
- Confirm created GitHub issues are attached to the expected Project and begin in a planning-active status.
- Confirm the planning run moves work into the human-review state and the implementation run moves it into the awaiting-merge state.
- Confirm linked pull requests include `Fixes #<issue-number>` and that merging them closes the issue and advances the project item to `Done`.

## Rollback

- Disable the feature flag for new workspace provisioning.
- Stop and remove affected workspace containers.
- Revert the control-plane deployment and investigate any orphaned GitHub Projects or DB records before retrying.
