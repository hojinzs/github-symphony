# @gh-symphony/tracker-github

GitHub Project polling, issue normalization, and tracker-facing configuration validation that stay behind the core tracker adapter contract.

## Adapter profile

- Candidate polling returns every active, in-scope Project item, including items
  that cannot be dispatched. GitHub-specific eligibility is expressed through
  `dispatchable: false` and `dispatchReason`, so `repo explain` can report it.
- `assigneeId` is the login of the first GitHub issue assignee, or `null` when
  an issue has no assignee. It is a provider-native identity and is not a
  cross-tracker identifier.
- With `--assigned-only`, items assigned to another user stay visible but are
  non-dispatchable. Repository scope and fork PR heads are handled the same
  way.
- Blocker eligibility is derived here, not by orchestration core. For states
  selected by the workflow's `blocker_check_states`, unresolved GitHub
  `blockedBy` issues produce `dispatchable: false` and a `dispatchReason`.
  `blockedBy` remains best-effort provider metadata; closed blockers do not
  prevent dispatch.
