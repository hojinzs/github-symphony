import { githubProjectTrackerAdapter } from "@gh-symphony/tracker-github";
export { findGithubProjectIssue } from "@gh-symphony/tracker-github";
import { fileTrackerAdapter } from "@gh-symphony/tracker-file";
import { linearTrackerAdapter } from "@gh-symphony/tracker-linear";
import type {
  OrchestratorTrackerAdapter,
  OrchestratorTrackerConfig,
} from "@gh-symphony/core";

const trackerAdapters = new Map<string, OrchestratorTrackerAdapter>([
  ["github-project", githubProjectTrackerAdapter],
  ["file", fileTrackerAdapter],
  ["linear", linearTrackerAdapter],
]);

/** Adapter-owned tracker kinds supplied to workflow validation at the boundary. */
export function getSupportedTrackerKinds(): readonly string[] {
  return [...trackerAdapters.keys()];
}

export function resolveTrackerAdapter(
  tracker: OrchestratorTrackerConfig
): OrchestratorTrackerAdapter {
  const adapter = trackerAdapters.get(tracker.adapter);
  if (!adapter) {
    throw new Error(`Unsupported tracker adapter: ${tracker.adapter}`);
  }
  return adapter;
}

/** Resolves adapter-owned workflow parser hooks without requiring a binding. */
export function resolveWorkflowConfigTrackerAdapter(
  kind: string
): OrchestratorTrackerAdapter | undefined {
  return trackerAdapters.get(kind);
}
