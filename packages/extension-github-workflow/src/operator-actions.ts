/**
 * Operator intervention points for the GitHub approval-gated workflow.
 *
 * Each action type represents a human decision that the orchestrator
 * cannot make automatically. The orchestrator surfaces the required
 * intervention and waits for the operator to act.
 *
 * Intervention points:
 *
 *   1. **Approval** — Move the tracked item from human-review to
 *      implementation-active to approve the plan.
 *
 *   2. **Suppression** — The orchestrator automatically suppresses
 *      runs when the tracker state is no longer actionable. No
 *      operator action needed unless the suppression was unexpected.
 *
 *   3. **Retry** — The orchestrator handles continuation and failure
 *      retries automatically up to the configured max attempts. After
 *      max attempts, the operator must investigate and either:
 *      - Fix the underlying issue and re-trigger
 *      - Force a retry via the status API
 *
 *   4. **Handoff repair** — After a run completes, the extension
 *      verifies that the expected handoff mutation occurred. If not,
 *      the operator must either force the transition or investigate.
 *
 *   5. **Cleanup retry / force remove** — When `before_remove` hook
 *      fails, the workspace enters `cleanup_blocked`. The operator
 *      must either fix the hook and retry cleanup, or force-remove
 *      the workspace.
 *
 *   6. **Issue-closure completion** — Pull-request merge alone does
 *      not complete work. The issue must be closed (typically by PR
 *      auto-close). If auto-close is not configured, the operator or
 *      GitHub automation must close the issue manually.
 *
 *   7. **Issue transfer rebind** — When the tracker adapter detects a
 *      possible issue transfer, the operator must confirm the rebind
 *      before canonical identity is updated.
 */

export type OperatorInterventionKind =
  | "approval"
  | "retry_exhausted"
  | "handoff_repair"
  | "cleanup_blocked"
  | "cleanup_force_remove"
  | "issue_closure_required"
  | "transfer_rebind";

export type OperatorIntervention = {
  kind: OperatorInterventionKind;
  issueIdentifier: string;
  workspaceId: string;
  description: string;
  suggestedAction: string;
  createdAt: string;
};

/**
 * Build an operator intervention record for a specific situation.
 */
export function createIntervention(
  kind: OperatorInterventionKind,
  context: {
    issueIdentifier: string;
    workspaceId: string;
    now: Date;
  }
): OperatorIntervention {
  const descriptions: Record<
    OperatorInterventionKind,
    { description: string; suggestedAction: string }
  > = {
    approval: {
      description:
        "Plan is ready for human review. Move the tracked item to the implementation-active state to approve.",
      suggestedAction:
        "Review the planning comment and transition the project item to the approved state.",
    },
    retry_exhausted: {
      description:
        "Maximum retry attempts exhausted. The issue run has failed permanently.",
      suggestedAction:
        "Investigate the failure, fix the underlying issue, and re-trigger the run.",
    },
    handoff_repair: {
      description:
        "Handoff verification failed. The expected state transition did not occur after the run completed.",
      suggestedAction:
        "Force the project item state transition or investigate why the runtime tool did not perform the mutation.",
    },
    cleanup_blocked: {
      description:
        "The before_remove hook failed. The issue workspace cannot be cleaned up automatically.",
      suggestedAction:
        "Fix the hook script and retry cleanup, or force-remove the workspace.",
    },
    cleanup_force_remove: {
      description: "Operator requested force removal of a blocked workspace.",
      suggestedAction:
        "Confirm force removal to delete the workspace directory without running the hook.",
    },
    issue_closure_required: {
      description:
        "Pull request was merged but the linked issue remains open. Work is not complete until the issue is closed.",
      suggestedAction:
        "Close the issue manually or enable auto-close on PR merge.",
    },
    transfer_rebind: {
      description:
        "Issue appears to have been transferred. Canonical identity cannot be updated automatically.",
      suggestedAction:
        "Confirm the transfer and rebind the issue to the new repository.",
    },
  };

  const info = descriptions[kind];

  return {
    kind,
    issueIdentifier: context.issueIdentifier,
    workspaceId: context.workspaceId,
    description: info.description,
    suggestedAction: info.suggestedAction,
    createdAt: context.now.toISOString(),
  };
}
