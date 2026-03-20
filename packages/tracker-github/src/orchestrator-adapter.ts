import { createHash } from "node:crypto";
import type {
  OrchestratorTrackerAdapter,
  OrchestratorTrackerDependencies,
  OrchestratorTrackerConfig,
} from "@gh-symphony/core";
import {
  fetchGithubIssueStatesByIds,
  fetchGithubProjectIssues,
} from "./adapter.js";

export const githubProjectTrackerAdapter: OrchestratorTrackerAdapter = {
  async listIssues(project, dependencies = {}) {
    return listProjectIssues(project, dependencies);
  },

  async listIssuesByStates(project, states, dependencies = {}) {
    if (states.length === 0) {
      return [];
    }

    // GitHub Project V2 cannot filter project items by state at query time,
    // so we reuse the full project fetch and apply state filtering locally.
    const issues = await listProjectIssues(project, dependencies);
    const normalizedStates = new Set(
      states.map((state) => state.trim().toLowerCase())
    );
    return issues.filter((issue) =>
      normalizedStates.has(issue.state.trim().toLowerCase())
    );
  },

  async fetchIssueStatesByIds(project, issueIds, dependencies = {}) {
    if (issueIds.length === 0) {
      return [];
    }

    return fetchProjectIssueStatesByIds(project, issueIds, dependencies);
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
      title: run.issueTitle ?? run.issueIdentifier,
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

async function listProjectIssues(
  project: Parameters<OrchestratorTrackerAdapter["listIssues"]>[0],
  dependencies: Parameters<OrchestratorTrackerAdapter["listIssues"]>[1] = {}
) {
  const trackerConfig = resolveGitHubTrackerConfig(project, dependencies);
  const loadProjectIssues = () =>
    fetchGithubProjectIssues(trackerConfig, dependencies.fetchImpl);

  return (
    dependencies.projectItemsCache?.getOrLoad(
      buildProjectItemsCacheKey(trackerConfig, dependencies),
      loadProjectIssues
    ) ?? loadProjectIssues()
  );
}

async function fetchProjectIssueStatesByIds(
  project: Parameters<OrchestratorTrackerAdapter["fetchIssueStatesByIds"]>[0],
  issueIds: Parameters<OrchestratorTrackerAdapter["fetchIssueStatesByIds"]>[1],
  dependencies: Parameters<OrchestratorTrackerAdapter["fetchIssueStatesByIds"]>[2] = {}
) {
  const trackerConfig = resolveGitHubTrackerConfig(project, dependencies);

  return fetchGithubIssueStatesByIds(
    trackerConfig,
    [...issueIds],
    dependencies.fetchImpl
  );
}

function resolveGitHubTrackerConfig(
  project: Parameters<OrchestratorTrackerAdapter["listIssues"]>[0],
  dependencies: Parameters<OrchestratorTrackerAdapter["listIssues"]>[1] = {}
) {
  const token = dependencies.token ?? process.env.GITHUB_GRAPHQL_TOKEN;

  if (!token) {
    throw new Error(
      "GITHUB_GRAPHQL_TOKEN environment variable is required. Run 'gh auth token' or set the variable."
    );
  }

  const githubProjectId = requireTrackerSetting(project.tracker, "projectId");

  return {
    projectId: githubProjectId,
    token,
    apiUrl: project.tracker.apiUrl,
    assignedOnly: readBooleanTrackerSetting(project.tracker, "assignedOnly"),
    priorityFieldName: readOptionalStringTrackerSetting(
      project.tracker,
      "priorityFieldName"
    ),
    timeoutMs: readNumberTrackerSetting(project.tracker, "timeoutMs"),
  };
}

function buildProjectItemsCacheKey(
  config: ReturnType<typeof resolveGitHubTrackerConfig>,
  _dependencies: OrchestratorTrackerDependencies
): string {
  return JSON.stringify({
    adapter: "github-project",
    apiUrl: config.apiUrl,
    assignedOnly: config.assignedOnly ?? false,
    priorityFieldName: config.priorityFieldName ?? null,
    projectId: config.projectId,
    timeoutMs: config.timeoutMs,
    tokenFingerprint: hashToken(config.token),
  });
}

function hashToken(token: string | null): string | null {
  if (!token) {
    return null;
  }

  return createHash("sha256").update(token).digest("hex");
}

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

function readOptionalStringTrackerSetting(
  tracker: OrchestratorTrackerConfig,
  key: string
): string | undefined {
  const value = tracker.settings?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseIssueNumber(identifier: string): number {
  const match = identifier.match(/#(\d+)$/);
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
}
