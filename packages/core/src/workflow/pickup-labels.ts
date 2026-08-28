import type { OrchestratorProjectConfig } from "../contracts/status-surface.js";
import type { TrackedIssue } from "../contracts/tracker-adapter.js";

/**
 * Workflow policy may narrow candidate listing by `tracker.pickup_labels`, which is how
 * two projects sharing one repository stay disjoint. State lookups and revive
 * paths must stay unfiltered, so this is applied only where candidates are
 * enumerated.
 */
export function filterIssuesByPickupLabels<T extends TrackedIssue>(
  issues: T[],
  project: Pick<OrchestratorProjectConfig, "tracker">
): T[] {
  return issues.filter(
    (issue) => resolvePickupLabelDispatchReason(issue, project) === null
  );
}

/**
 * Resolves the workflow-policy reason an issue cannot be picked up. Tracker
 * adapters may retain such issues for status/explain surfaces without
 * duplicating pickup-label semantics.
 */
export function resolvePickupLabelDispatchReason<T extends TrackedIssue>(
  issue: T,
  project: Pick<OrchestratorProjectConfig, "tracker">
): string | null {
  const pickupLabels = project.tracker.settings?.pickupLabels;
  if (
    !pickupLabels ||
    typeof pickupLabels !== "object" ||
    Array.isArray(pickupLabels)
  ) {
    return null;
  }

  const config = pickupLabels as Record<string, unknown>;
  const include = readLabelList(config.include);
  const exclude = new Set(readLabelList(config.exclude));
  if (include.length === 0 && exclude.size === 0) {
    return null;
  }

  const labels = new Set(issue.labels);
  const excludedLabel = [...exclude].find((label) => labels.has(label));
  if (excludedLabel) {
    return `Issue has excluded pickup label "${excludedLabel}".`;
  }

  return include.length === 0 || include.some((label) => labels.has(label))
    ? null
    : `Issue is missing a required pickup label (${include.join(", ")}).`;
}

function readLabelList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((label): label is string => typeof label === "string")
    : [];
}
