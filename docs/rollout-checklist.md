# Rollout checklist

## Internal feature flag

- Gate workspace provisioning behind an internal feature flag before exposing the UI broadly.
- Keep a known-good Symphony image tag available for rollback.

## Operational checks

- Verify `DATABASE_URL`, `SYMPHONY_RUNTIME_DRIVER`, GitHub token scopes, and driver-specific runtime access before enabling provisioning.
- Run `pnpm lint`, `pnpm test`, `pnpm typecheck`, and `pnpm build` on every release candidate.
- Run `DATABASE_URL='postgresql://postgres:postgres@localhost:5432/github_symphony' pnpm prisma:validate` before applying schema changes.

## Runtime health

- Confirm each workspace has a persisted `SymphonyInstance` record with runtime driver, runtime identity, endpoint host/port, and workflow path.
- Poll each worker `/api/v1/state` endpoint after deployment and alert on degraded or missing responses.
- Reconcile failed provisions by removing orphaned containers or terminating orphaned local worker processes before retrying.

## GitHub integration

- Validate the machine-user PAT has `repo`, `read:org`, and `project` scopes plus organization access before creating workspaces or issues.
- Confirm created GitHub issues are attached to the expected Project and begin in a planning-active status.
- Confirm the planning run moves work into the human-review state and the implementation run moves it into the awaiting-merge state.
- Confirm linked pull requests include `Fixes #<issue-number>` and that merging them closes the issue and advances the project item to `Done`.

## Rollback

- Disable the feature flag for new workspace provisioning.
- Stop and remove affected workspace containers.
- Revert the control-plane deployment and investigate any orphaned GitHub Projects or DB records before retrying.
