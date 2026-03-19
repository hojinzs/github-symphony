import type {
  OrchestratorTrackerAdapter,
  OrchestratorTrackerConfig,
} from "@gh-symphony/core";
import { fetchGithubProjectIssues } from "./adapter.js";

export const githubProjectTrackerAdapter: OrchestratorTrackerAdapter = {
  async listIssues(project, dependencies = {}) {
    const token = dependencies.token ?? process.env.GITHUB_GRAPHQL_TOKEN;

    if (!token) {
      throw new Error(
        "GITHUB_GRAPHQL_TOKEN environment variable is required. Run 'gh auth token' or set the variable."
      );
    }

    const githubProjectId = requireTrackerSetting(project.tracker, "projectId");

    return fetchGithubProjectIssues(
      {
        projectId: githubProjectId,
        token,
        apiUrl: project.tracker.apiUrl,
        assignedOnly: readBooleanTrackerSetting(project.tracker, "assignedOnly"),
        timeoutMs: readNumberTrackerSetting(project.tracker, "timeoutMs"),
      },
      dependencies.fetchImpl
    );
  },

  buildWorkerEnvironment(project) {
    return {
      GITHUB_PROJECT_ID: requireTrackerSetting(project.tracker, "projectId"),
    };
  },

  reviveIssue(project, run) {
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
        bindingId: project.tracker.bindingId,
        itemId: run.issueId,
      },
      metadata: {},
    };
  },
};

const trackerAdapters: Record<string, OrchestratorTrackerAdapter> = {
  "github-project": githubProjectTrackerAdapter,
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

  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Tracker adapter "${tracker.adapter}" requires the "${key}" setting.`
    );
  }

  return value;
}

function readBooleanTrackerSetting(
  tracker: OrchestratorTrackerConfig,
  key: string
): boolean {
  const value = tracker.settings?.[key];
  return value === true || value === "true";
}

function readNumberTrackerSetting(
  tracker: OrchestratorTrackerConfig,
  key: string
): number | undefined {
  const value = tracker.settings?.[key];

  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);

    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  throw new Error(
    `Tracker adapter "${tracker.adapter}" requires the "${key}" setting to be a positive integer when provided.`
  );
}

function parseIssueNumber(identifier: string): number {
  const match = identifier.match(/#(\d+)$/);
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
}
