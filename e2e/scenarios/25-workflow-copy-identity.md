# Workflow copy identity

## Purpose

Verify the packaged standalone runtime detects a project-directory
`WORKFLOW.md` that is a stale regular-file copy of committed repository policy,
without fetching from the network.

## Steps

1. Run `./e2e/run-standalone-project-e2e.sh`.
2. The runner copies the seed repository's committed `WORKFLOW.md` into a
   standalone project directory as a regular file.
3. It advances and commits the seed repository policy while leaving the project
   copy unchanged, then runs one orchestration tick.
4. It reads packaged `project status --json` and `doctor --json` output.

## Expected results

- The status snapshot reports `workflow.source.relationship` as `stale-copy`.
- Both project-source and current committed repository revisions use the
  non-secret `sha256:<12 hex characters>` form and differ.
- The snapshot warning and doctor diagnostic name the condition as a diverged
  copy; doctor includes both revisions.
- Unit tests separately cover symlink, synchronized-copy (including normalized
  line endings), stale-copy, deliberately independent policy, and a repository
  with no committed policy.
