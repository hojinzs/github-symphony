import { createHash } from "node:crypto";
import type {
  OrchestratorTrackerAdapter,
  OrchestratorTrackerDependencies,
  OrchestratorTrackerConfig,
  TrackedIssue,
  TrackedIssueList,
} from "@gh-symphony/core";
import { resolvePickupLabelDispatchReason } from "@gh-symphony/core";
import {
  fetchGithubIssueStatesByIds,
  fetchGithubProjectIssueByRepositoryAndNumber,
  fetchGithubProjectIssues,
  requestGithubProjectItemState,
  upsertGithubTransitionComment,
  upsertGithubIssueComment,
} from "./adapter.js";

export const githubProjectTrackerAdapter: OrchestratorTrackerAdapter = {
  async listIssues(project, dependencies = {}) {
    const issues = await listProjectIssues(project, dependencies);
    return applyPickupLabelDispatchability(issues, project);
  },

  async listIssuesByStates(project, states, dependencies = {}) {
    if (states.length === 0) {
      return [];
    }

    // Terminal-state exclusion is only safe for candidate listing. State
    // lookups (including startup cleanup for Done items) stay unfiltered.
    const issues = await listProjectIssues(project, dependencies, {
      filterTerminalStates: false,
    });
    const normalizedStates = new Set(
      states.map((state) => state.trim().toLowerCase())
    );
    const filtered = issues.filter((issue) =>
      normalizedStates.has(issue.state.trim().toLowerCase())
    ) as TrackedIssueList;
    filtered.rateLimits = (issues as TrackedIssueList).rateLimits;
    return filtered;
  },

  async fetchIssueStatesByIds(project, issueIds, dependencies = {}) {
    if (issueIds.length === 0) {
      return [];
    }

    return fetchProjectIssueStatesByIds(project, issueIds, dependencies);
  },

  buildWorkerEnvironment(project) {
    const apiUrl = project.tracker.apiUrl?.trim();

    return {
      GITHUB_PROJECT_ID: requireTrackerSetting(project.tracker, "projectId"),
      ...(apiUrl ? { GITHUB_GRAPHQL_API_URL: apiUrl } : {}),
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
      state: run.issueState,
      branchName: null,
      url: null,
      labels: [],
      dispatchable: true,
      assigneeId: null,
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
      repository: run.repository,
      tracker: {
        adapter: "github-project",
        bindingId: project.tracker.bindingId,
        itemId: run.trackerItemId ?? "",
      },
      nativeRef: { itemId: run.trackerItemId ?? "" },
      metadata: {},
    };
  },

  resolveCanonicalIssues(issues) {
    const pullRequestsById = new Map<string, TrackedIssue>();
    const pullRequestsByIdentifier = new Map<string, TrackedIssue>();
    for (const issue of issues) {
      if (githubNative(issue).contentType !== "PullRequest") continue;
      pullRequestsById.set(issue.id, issue);
      pullRequestsByIdentifier.set(issue.identifier, issue);
    }

    const linkedIds = new Set<string>();
    const linkedIdentifiers = new Set<string>();
    const canonical: TrackedIssue[] = [];
    for (const issue of issues) {
      const native = githubNative(issue);
      if (native.contentType === "PullRequest") continue;
      const linked = native.linkedPullRequests ?? [];
      if (linked.length === 0) {
        canonical.push(issue);
        continue;
      }
      let merged = false;
      const resolved = linked.map((pullRequest) => {
        linkedIds.add(pullRequest.id);
        linkedIdentifiers.add(pullRequest.identifier);
        const projectPullRequest =
          pullRequestsById.get(pullRequest.id) ??
          pullRequestsByIdentifier.get(pullRequest.identifier);
        if (!projectPullRequest) return pullRequest;
        merged = true;
        return {
          ...pullRequest,
          projectState: projectPullRequest.state,
          projectItemId: githubNative(projectPullRequest).itemId,
          priority: projectPullRequest.priority,
        };
      });
      canonical.push(
        merged
          ? {
              ...issue,
              nativeRef: {
                ...(issue.nativeRef ?? {}),
                linkedPullRequests: resolved,
              } as TrackedIssue["nativeRef"],
            }
          : issue
      );
    }
    for (const pullRequest of issues) {
      if (githubNative(pullRequest).contentType !== "PullRequest") continue;
      if (
        !linkedIds.has(pullRequest.id) &&
        !linkedIdentifiers.has(pullRequest.identifier)
      ) {
        canonical.push(pullRequest);
      }
    }
    return canonical;
  },

  matchesIssueIdentifier(issue, identifier) {
    return (
      issue.identifier === identifier ||
      githubNative(issue).linkedPullRequests?.some(
        (pullRequest) => pullRequest.identifier === identifier
      ) === true
    );
  },

  getTrackerItemId(issue) {
    return githubNative(issue).itemId ?? null;
  },

  resolveBranchCheckoutTarget(issue) {
    const native = githubNative(issue);
    const pullRequest =
      native.contentType === "PullRequest"
        ? (native.pullRequest ?? native.linkedPullRequests?.[0])
        : (native.linkedPullRequests?.[0] ?? null);
    if (!pullRequest) {
      if (native.contentType === "PullRequest") {
        throw new Error(
          `Cannot checkout pull request branch for ${issue.identifier}: missing pull request reference.`
        );
      }
      return null;
    }
    const headRefName = pullRequest.headRefName?.trim();
    if (!headRefName) {
      throw new Error(
        `Cannot checkout pull request branch for ${pullRequest.identifier}: missing headRefName.`
      );
    }
    const headRepository = pullRequest.headRepository ?? null;
    if (
      !headRepository ||
      headRepository.owner.toLowerCase() !== issue.repository.owner.toLowerCase() ||
      headRepository.name.toLowerCase() !== issue.repository.name.toLowerCase()
    ) {
      const source = headRepository
        ? `${headRepository.owner}/${headRepository.name}`
        : "unknown fork";
      throw new Error(
        `Cannot checkout pull request branch for ${pullRequest.identifier}: fork pull requests are unsupported for automatic checkout/push (${source} -> ${issue.repository.owner}/${issue.repository.name}).`
      );
    }
    return { headRefName };
  },

  findActiveLinkedPullRequest(issue, lifecycle) {
    const activeStates = new Set(
      lifecycle.activeStates.map((state) => state.trim().toLowerCase())
    );
    const pullRequest = githubNative(issue).linkedPullRequests?.find(
      (candidate) =>
        typeof candidate.projectState === "string" &&
        activeStates.has(candidate.projectState.trim().toLowerCase())
    );
    return pullRequest?.projectState
      ? {
          id: pullRequest.id,
          identifier: pullRequest.identifier,
          projectState: pullRequest.projectState,
        }
      : null;
  },

  resolveTerminalFact(issue) {
    const native = githubNative(issue);
    if (native.sourceState?.trim().toLowerCase() === "closed") {
      return {
        kind: "issue_closed",
        reason: "Source issue is closed while its Project status is active.",
        relatedIdentifier: null,
      };
    }

    const mergedPullRequest = native.linkedPullRequests?.find(
      (pullRequest) =>
        pullRequest.merged === true ||
        pullRequest.state?.trim().toLowerCase() === "merged"
    );
    return mergedPullRequest
      ? {
          kind: "linked_pull_request_merged",
          reason: `Linked pull request ${mergedPullRequest.identifier} is merged while the issue Project status is active.`,
          relatedIdentifier: mergedPullRequest.identifier,
        }
      : null;
  },

  async requestState(project, input, dependencies = {}) {
    const trackerConfig = resolveGitHubTrackerConfig(project, dependencies);
    return requestGithubProjectItemState(
      trackerConfig,
      input,
      dependencies.fetchImpl
    );
  },

  async upsertTransitionComment(project, input, dependencies = {}) {
    const trackerConfig = resolveGitHubTrackerConfig(project, dependencies);
    return upsertGithubTransitionComment(
      trackerConfig,
      input,
      dependencies.fetchImpl
    );
  },

  async upsertIssueComment(project, issue, input, dependencies = {}) {
    const trackerConfig = resolveGitHubTrackerConfig(project, dependencies);
    return upsertGithubIssueComment(
      trackerConfig,
      issue,
      input,
      dependencies.fetchImpl,
      dependencies.issueCommentCache
    );
  },
};

type GitHubNativeRef = {
  itemId?: string;
  contentType?: "Issue" | "PullRequest";
  sourceState?: string | null;
  linkedPullRequests?: Array<{
    id: string;
    identifier: string;
    state: string | null;
    merged?: boolean | null;
    projectState?: string | null;
    headRefName?: string | null;
    headRepository?: { owner: string; name: string } | null;
  }>;
  pullRequest?: NonNullable<GitHubNativeRef["linkedPullRequests"]>[number];
};

function githubNative(issue: TrackedIssue): GitHubNativeRef {
  return (issue.nativeRef ?? {}) as unknown as GitHubNativeRef;
}

export async function findGithubProjectIssue(
  project: Parameters<OrchestratorTrackerAdapter["listIssues"]>[0],
  identifier: string,
  dependencies: Parameters<OrchestratorTrackerAdapter["listIssues"]>[1] = {}
) {
  const parsed = parseIssueIdentifier(identifier);
  if (!parsed) {
    return null;
  }

  const trackerConfig = resolveGitHubTrackerConfig(project, dependencies);
  return fetchGithubProjectIssueByRepositoryAndNumber(
    trackerConfig,
    { owner: parsed.owner, name: parsed.name },
    parsed.number,
    dependencies.fetchImpl
  );
}

function applyPickupLabelDispatchability(
  issues: TrackedIssueList,
  project: Parameters<OrchestratorTrackerAdapter["listIssues"]>[0]
): TrackedIssueList {
  const result = issues.map((issue) => {
    const dispatchReason = resolvePickupLabelDispatchReason(issue, project);
    if (!issue.dispatchable || !dispatchReason) {
      return issue;
    }

    return { ...issue, dispatchable: false, dispatchReason };
  }) as TrackedIssueList;
  result.rateLimits = issues.rateLimits;
  result.skippedItems = issues.skippedItems;
  return result;
}

async function listProjectIssues(
  project: Parameters<OrchestratorTrackerAdapter["listIssues"]>[0],
  dependencies: Parameters<OrchestratorTrackerAdapter["listIssues"]>[1] = {},
  options: { filterTerminalStates?: boolean } = {}
) {
  const trackerConfig = {
    ...resolveGitHubTrackerConfig(project, dependencies),
    filterTerminalStates: options.filterTerminalStates ?? true,
  };
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
  dependencies: Parameters<
    OrchestratorTrackerAdapter["fetchIssueStatesByIds"]
  >[2] = {}
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
  const assignedOnly = resolveAssignedOnly(project.tracker, dependencies);
  const repositoryFilter = resolveRepositoryFilter(project);

  return {
    projectId: githubProjectId,
    token,
    apiUrl: project.tracker.apiUrl,
    assignedOnly,
    repositoryFilter,
    priority: project.tracker.priority ?? null,
    priorityFieldName: readOptionalStringTrackerSetting(
      project.tracker,
      "priorityFieldName"
    ),
    timeoutMs: readNumberTrackerSetting(project.tracker, "timeoutMs"),
    lifecycle: dependencies.workflowLifecycle,
  };
}

const warnedLegacyAssignedOnlyProjectIds = new Set<string>();

function resolveAssignedOnly(
  tracker: OrchestratorTrackerConfig,
  dependencies: OrchestratorTrackerDependencies
): boolean {
  if (dependencies.assignedOnly !== undefined) {
    return dependencies.assignedOnly;
  }

  const legacyAssignedOnly = readBooleanTrackerSetting(tracker, "assignedOnly");
  if (legacyAssignedOnly) {
    const warningKey = `${tracker.adapter}:${tracker.bindingId}`;
    if (!warnedLegacyAssignedOnlyProjectIds.has(warningKey)) {
      warnedLegacyAssignedOnlyProjectIds.add(warningKey);
      console.warn(
        "[gh-symphony] Deprecated tracker.settings.assignedOnly detected. Use 'gh-symphony repo start --assigned-only' or 'gh-symphony project start --assigned-only' instead; persisted assignedOnly support will be removed in the next major release."
      );
    }
  }

  return legacyAssignedOnly;
}

const warnedRepositoryScopeDisabledProjectIds = new Set<string>();

function resolveRepositoryFilter(
  project: Parameters<OrchestratorTrackerAdapter["listIssues"]>[0]
): { owner: string; name: string } | null {
  const repositorySetting = readOptionalStringTrackerSetting(
    project.tracker,
    "repository"
  )?.trim();

  if (!repositorySetting) {
    return {
      owner: project.repository.owner,
      name: project.repository.name,
    };
  }

  if (repositorySetting === "*") {
    const warningKey = `${project.tracker.adapter}:${project.tracker.bindingId}`;
    if (!warnedRepositoryScopeDisabledProjectIds.has(warningKey)) {
      warnedRepositoryScopeDisabledProjectIds.add(warningKey);
      console.warn(
        "[gh-symphony] GitHub tracker repository scoping is disabled by tracker.settings.repository='*'. Multiple daemons watching the same Project V2 may dispatch the same issue."
      );
    }
    return null;
  }

  const segments = repositorySetting.split("/");
  const owner = segments[0]?.trim();
  const name = segments[1]?.trim();

  if (segments.length !== 2 || !owner || !name) {
    throw new Error(
      `Tracker adapter "${project.tracker.adapter}" requires the "repository" setting to be "*" or "owner/name" when provided.`
    );
  }

  return { owner, name };
}

function buildProjectItemsCacheKey(
  config: ReturnType<typeof resolveGitHubTrackerConfig>,
  _dependencies: OrchestratorTrackerDependencies
): string {
  return JSON.stringify({
    adapter: "github-project",
    apiUrl: config.apiUrl,
    assignedOnly: config.assignedOnly ?? false,
    priority: config.priority ?? null,
    priorityFieldName: config.priorityFieldName ?? null,
    projectId: config.projectId,
    workflowLifecycle: config.lifecycle ?? null,
    terminalStateFilterEnabled: isTerminalStateFilterEnabled(config),
    repositoryFilter: config.repositoryFilter
      ? `${config.repositoryFilter.owner}/${config.repositoryFilter.name}`
      : null,
    timeoutMs: config.timeoutMs,
    tokenFingerprint: hashToken(config.token),
  });
}

function isTerminalStateFilterEnabled(
  config: ReturnType<typeof resolveGitHubTrackerConfig> & {
    filterTerminalStates?: boolean;
  }
): boolean {
  if (config.filterTerminalStates === false || !config.lifecycle) {
    return false;
  }

  return (
    config.lifecycle.stateFieldName.trim().toLowerCase() === "status" &&
    config.lifecycle.terminalStates.some((state) => state.trim().length > 0)
  );
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

function parseIssueIdentifier(
  identifier: string
): { owner: string; name: string; number: number } | null {
  const match = identifier.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/);
  if (!match) {
    return null;
  }

  return {
    owner: match[1]!,
    name: match[2]!,
    number: Number.parseInt(match[3]!, 10),
  };
}
