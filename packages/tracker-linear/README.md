# @gh-symphony/tracker-linear

Linear tracker adapter for GitHub Symphony.

The MVP is read-side only: it polls Linear issues by `project.slugId` and
workflow state names, normalizes them into `TrackedIssue`, and injects Linear
context into worker environments.

Candidate polling intentionally includes unassigned issues. `--assigned-only`
is an input to this adapter's local `dispatchable` derivation: it compares the
returned `assignee.id` with the authenticated Linear viewer instead of adding
an `assignee.isMe` GraphQL filter. This keeps unassigned and other-user issues
observable while preventing their dispatch. The scheduler consumes only the
normalized eligibility result; it does not interpret Linear identities.
Pickup-label eligibility is also derived here before candidate dispatch.
