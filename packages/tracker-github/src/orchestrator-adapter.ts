import type {
  OrchestratorTrackerAdapter,
  OrchestratorTrackerConfig,
} from "@github-symphony/core";
import { fetchProjectIssues } from "./adapter.js";

export const githubProjectAdapter: OrchestratorTrackerAdapter = {
  async listIssues(workspace, dependencies = {}) {
    const token = dependencies.token ?? process.env.GITHUB_GRAPHQL_TOKEN;

    if (!token) {
      throw new Error(
        "GITHUB_GRAPHQL_TOKEN is required for orchestrator polling."
      );
    }

    const projectId = requireTrackerSetting(workspace.tracker, "projectId");

    return fetchProjectIssues(
      {
        projectId,
        token,
        apiUrl: workspace.tracker.apiUrl,
      },
      dependencies.fetchImpl
    );
  },

  buildWorkerEnvironment(workspace) {
    return {
      GITHUB_PROJECT_ID: requireTrackerSetting(workspace.tracker, "projectId"),
    };
  },

  reviveIssue(workspace, run) {
    return {
      id: run.issueId,
      identifier: run.issueIdentifier,
      number: parseIssueNumber(run.issueIdentifier),
      title: run.issueIdentifier,
      description: null,
      priority: null,
      state: "",
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
      repository: run.repository,
      tracker: {
        adapter: "github-project",
        bindingId: workspace.tracker.bindingId,
        itemId: run.issueId,
      },
      phase: run.phase,
      metadata: {},
    };
  },
};

const trackerAdapters: Record<string, OrchestratorTrackerAdapter> = {
  "github-project": githubProjectAdapter,
};

export function resolveTrackerAdapter(
  tracker: OrchestratorTrackerConfig
): OrchestratorTrackerAdapter {
  const adapter = trackerAdapters[tracker.adapter];

  if (!adapter) {
    throw new Error(`Unsupported tracker adapter: ${tracker.adapter}`);
  }

  return adapter;
}

function requireTrackerSetting(
  tracker: OrchestratorTrackerConfig,
  key: string
): string {
  const value = tracker.settings?.[key];

  if (!value) {
    throw new Error(
      `Tracker adapter "${tracker.adapter}" requires the "${key}" setting.`
    );
  }

  return value;
}

function parseIssueNumber(identifier: string): number {
  const match = identifier.match(/#(\d+)$/);
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
}
