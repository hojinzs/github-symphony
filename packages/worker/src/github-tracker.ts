export {
  GitHubTrackerError,
  GitHubTrackerHttpError,
  GitHubTrackerQueryError,
  fetchActionableIssues,
  fetchProjectIssues,
  normalizeProjectItem,
  type GitHubRepositoryRef,
  type GitHubTrackedIssue,
  type GitHubTrackerConfig
} from "@gh-symphony/tracker-github";

import { isWorkflowPhaseActionable } from "@gh-symphony/core";
import type {
  GitHubTrackedIssue,
  GitHubTrackerConfig
} from "@gh-symphony/tracker-github";

export function normalizeStateName(state: string): string {
  return state.trim().toLowerCase();
}

export function isActionableState(state: string, activeStates: string[]): boolean {
  return activeStates.map(normalizeStateName).includes(normalizeStateName(state));
}

export function isTrackedIssueActionable(
  issue: Pick<GitHubTrackedIssue, "state" | "phase">,
  config: Pick<GitHubTrackerConfig, "lifecycle"> & {
    activeStates?: string[];
  }
): boolean {
  if (config.lifecycle) {
    return isWorkflowPhaseActionable(issue.phase);
  }

  return isActionableState(issue.state, config.activeStates ?? []);
}
