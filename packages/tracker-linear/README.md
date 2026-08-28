# @gh-symphony/tracker-linear

Linear tracker adapter for GitHub Symphony.

The MVP is read-side only: it polls Linear issues by `project.slugId` and
workflow state names, normalizes them into `TrackedIssue`, and injects Linear
context into worker environments.

Blocker eligibility is derived by this adapter. When an issue is in a
workflow-selected `blocker_check_states` state, unresolved `blockedBy` Linear
issues (those outside the workflow terminal states) produce
`dispatchable: false` with a provider-specific `dispatchReason`. The
`blockedBy` field remains best-effort metadata rather than an orchestration
core gate.

Candidate polling intentionally includes unassigned issues. When
`--assigned-only` is enabled, the adapter derives `dispatchable` from the
returned `assignee.id` compared with the authenticated Linear viewer instead
of adding an `assignee.isMe` GraphQL filter. This keeps unassigned and
other-user issues observable while preventing their dispatch. The same query
and pagination request count applies; only the returned candidate set can grow
to include unassigned issues. Pickup labels are applied by this adapter as a
candidate-listing filter rather than retained `dispatchable: false` records, so
label-ineligible Linear issues are not available to explain surfaces. This
repository-level adapter behavior diverges from the upstream scheduler-owned
label boundary and from GitHub's retained, reason-bearing pickup-label records.
