import type { OrchestratorProjectConfig } from "../contracts/status-surface.js";
import type { TrackedIssue } from "../contracts/tracker-adapter.js";

/**
 * Candidate listing may be narrowed by `tracker.pickup_labels`, which is how
 * two projects sharing one repository stay disjoint. State lookups and revive
 * paths must stay unfiltered, so this is applied only where candidates are
 * enumerated.
 */
export function filterIssuesByPickupLabels<T extends TrackedIssue>(
  issues: T[],
  project: Pick<OrchestratorProjectConfig, "tracker">
): T[] {
  const pickupLabels = project.tracker.settings?.pickupLabels;
  if (
    !pickupLabels ||
    typeof pickupLabels !== "object" ||
    Array.isArray(pickupLabels)
  ) {
    return issues;
  }

  const config = pickupLabels as Record<string, unknown>;
  const include = readLabelList(config.include);
  const exclude = new Set(readLabelList(config.exclude));
  if (include.length === 0 && exclude.size === 0) {
    return issues;
  }

  return issues.filter((issue) => {
    const labels = new Set(issue.labels);
    return (
      ![...exclude].some((label) => labels.has(label)) &&
      (include.length === 0 || include.some((label) => labels.has(label)))
    );
  });
}

function readLabelList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((label): label is string => typeof label === "string")
    : [];
}
