import { resolveTrackerAdapter as resolveGitHubAdapter } from "@gh-symphony/tracker-github";
import { fileTrackerAdapter } from "@gh-symphony/tracker-file";
import type {
  OrchestratorTrackerAdapter,
  OrchestratorTrackerConfig,
} from "@gh-symphony/core";

const localAdapters = new Map<string, OrchestratorTrackerAdapter>([
  ["file", fileTrackerAdapter],
]);

export function resolveTrackerAdapter(
  tracker: OrchestratorTrackerConfig,
): OrchestratorTrackerAdapter {
  const local = localAdapters.get(tracker.adapter);
  if (local) return local;
  return resolveGitHubAdapter(tracker);
}
