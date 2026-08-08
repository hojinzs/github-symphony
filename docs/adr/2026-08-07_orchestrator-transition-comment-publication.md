# ADR: Publish confirmed transition comments from the orchestrator

- **Date**: 2026-08-07
- **Status**: Accepted
- **Related Issue**: #541
- **Related Spec**: `docs/symphony-spec.md` §11.5, §18.2, §2.2

## Context

The worker previously posted the standard `🔁 Status: FROM → TO` comment as a separate tracker operation before asking `/gh-project` to mutate the Project status. That ordering was vulnerable in both directions: a worker could be terminated after the confirmed state mutation but before its deferred bookkeeping, and a failed mutation could leave a misleading audit comment.

The orchestrator already owns the run-scoped canonical item, expected state, target state, reason, exact-item readback, GraphQL quota, and serialized transition queue. The worker can therefore supply the policy-authored comment body as transition intent and let the orchestrator publish it only after the exact transition is confirmed.

## Decision

`transition-request` accepts an optional `comment_body` containing the complete agent-authored comment. The orchestrator does not parse, prepend, or otherwise rewrite that body. When the tracker result is `ok: true`, `outcome: confirmed`, and its state equals the requested target, the orchestrator invokes the optional `upsertTransitionComment` method on `OrchestratorTrackerAdapter`.

The adapter owns provider-specific comment semantics. The GitHub adapter keeps the write on its transition serialization queue, uses the existing GraphQL rate-limit accounting and retry path, and returns the finalized comment-write budget in its provider-neutral result. It treats an exact existing body as idempotently unchanged. A failed comment write is represented by a `tracker.transition-comment` event and the run snapshot's `transitionComment`/diagnostic fields. Diagnostic persistence is best effort after provider confirmation; a storage failure is emitted as a structured stderr diagnostic and never changes the confirmed transition result. The original confirmed transition result is returned unchanged and is never rolled back.

The comment operation is optional for adapters that do not support tracker writes. If a worker requests a comment from such an adapter, the orchestrator records `tracker_transition_comments_unsupported` as a comment failure while preserving the confirmed transition result.

## Layer impact

| Layer         | Impact        | Decision                                                                                            |
| ------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| Policy        | Yes           | `WORKFLOW.md` supplies the body and no longer posts a duplicate status comment.                     |
| Coordination  | Yes           | Confirmed transition handling invokes comment publication before returning the worker API response. |
| Integration   | Yes           | The adapter contract and GitHub GraphQL implementation provide idempotent comment writes.           |
| Observability | Yes           | Comment outcomes are durable structured events and run-snapshot diagnostics.                        |
| Core          | Contract only | Core defines provider-neutral request/result contracts; it contains no GitHub mutation logic.       |

## Upstream conformance and divergence

This is an intentional repository-local divergence from the upstream §11.5 default description that tracker writes are typically agent-tool owned. It is explicitly allowed by §18.2's recommended first-class tracker write extension and preserves §2.2's boundary: policy decides **what** to write, while the orchestrator and tracker adapter perform transport, readback, retry, serialization, and provider mutation. `docs/symphony-spec.md` is unchanged.

## Consequences

- A confirmed Project state transition remains durable even when the comment provider call fails.
- The standard status comment cannot be lost to worker SIGTERM after readback confirmation.
- Existing adapters without comment support remain valid, but their requested transition comments are observable as failed publication attempts.
- Exact-body idempotency also recognizes a comment that the old worker policy posted before upgrading to this behavior.
- `In review` → `Land` remains a human-owned project transition. The Land worker records that state as its trigger and does not replay it through `/gh-project`; only worker-requested transitions can carry an orchestrator-published `comment_body`.
