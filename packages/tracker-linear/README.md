# @gh-symphony/tracker-linear

Linear tracker adapter for GitHub Symphony.

The MVP is read-side only: it polls Linear issues by `project.slugId` and
workflow state names, normalizes them into `TrackedIssue`, and injects Linear
context into worker environments.

Candidate polling intentionally includes unassigned issues. When
`--assigned-only` is enabled, the adapter derives `dispatchable` from the
returned `assignee.id` instead of adding an `assignee.isMe` GraphQL filter.
This keeps unassigned issues observable while preventing their dispatch. The
same query and pagination request count applies; only the returned candidate
set can grow to include unassigned issues. Pickup-label eligibility is applied
by orchestration after adapter normalization.
