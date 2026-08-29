import type { TrackedIssue } from "../contracts/tracker-adapter.js";
import type { WorkflowLifecycleConfig } from "./lifecycle.js";
import { normalizeLabels } from "./normalization.js";

/** Resolves whether an issue is eligible for workflow routing. */
export function issueRoutable(
  issue: Pick<TrackedIssue, "dispatchable" | "dispatchReason" | "labels">,
  lifecycle: Pick<WorkflowLifecycleConfig, "requiredLabels">
): { routable: boolean; reason?: string } {
  if (!issue.dispatchable) {
    return {
      routable: false,
      reason: issue.dispatchReason ?? "Issue is not dispatchable.",
    };
  }

  const labels = new Set(normalizeLabels(issue.labels));
  const missingLabels = (lifecycle.requiredLabels ?? []).filter((label) => {
    const normalized = label.trim().toLowerCase();
    // Preserve the config-side blank invariant from §5.3.1 even though issue
    // labels are normalized with the shared helper, which drops blanks.
    return normalized === "" || !labels.has(normalized);
  });
  if (missingLabels.length > 0) {
    return {
      routable: false,
      reason: `Issue is missing required labels (${missingLabels
        .map((label) => JSON.stringify(label))
        .join(", ")}).`,
    };
  }

  return { routable: true };
}
