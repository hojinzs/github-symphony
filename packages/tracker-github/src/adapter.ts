import { createHash } from "node:crypto";
import {
  DEFAULT_WORKFLOW_LIFECYCLE,
  type IssueCommentCache,
  type IssueCommentCacheEntry,
  type TrackedIssue,
  type TrackedIssueList,
  type TrackerStateRequest,
  type TrackerStateResult,
  type WorkflowPriorityConfig,
  type WorkflowLifecycleConfig,
} from "@gh-symphony/core";

const DEFAULT_API_URL = "https://api.github.com/graphql";
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_NETWORK_TIMEOUT_MS = 30_000;
const RATE_LIMIT_SOFT_THRESHOLD = 100;
const RATE_LIMIT_HARD_THRESHOLD = 0;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const MAX_TRANSITION_QUEUE_DEPTH = 100;
const TRANSITION_RETRY_ATTEMPTS = 3;
const TRANSITION_RETRY_BASE_MS = 25;

export type GitHubTrackerConfig = {
  projectId: string;
  token: string;
  apiUrl?: string;
  lifecycle?: WorkflowLifecycleConfig;
  pageSize?: number;
  assignedOnly?: boolean;
  repositoryFilter?: { owner: string; name: string } | null;
  timeoutMs?: number;
  priority?: WorkflowPriorityConfig | null;
  priorityFieldName?: string;
  /** @internal Collects per-operation GraphQL cost within one tracker call. */
  rateLimitCollector?: GitHubRateLimitCollector;
};

export type GitHubRepositoryRef = {
  owner: string;
  name: string;
  url: string;
  cloneUrl: string;
};

export type GitHubPullRequestMetadata = {
  id: string;
  number: number;
  identifier: string;
  title: string;
  body: string | null;
  url: string | null;
  state: string | null;
  isDraft: boolean | null;
  merged: boolean | null;
  headRefName: string | null;
  baseRefName: string | null;
  headRepository: GitHubRepositoryRef | null;
  repository: GitHubRepositoryRef;
  createdAt: string | null;
  updatedAt: string | null;
};

export type GitHubTrackedIssue = TrackedIssue & {
  repository: GitHubRepositoryRef;
  tracker: TrackedIssue["tracker"] & {
    adapter: "github-project";
  };
  rateLimits?: Record<string, unknown> | null;
};

type FetchLike = typeof fetch;

type GraphQLFieldValue =
  | {
      __typename: "ProjectV2ItemFieldSingleSelectValue";
      name: string | null;
      optionId?: string | null;
      field: { name: string | null } | null;
    }
  | {
      __typename: "ProjectV2ItemFieldTextValue";
      text: string | null;
      field: { name: string | null } | null;
    };

type GraphQLProjectFieldConfiguration =
  | {
      __typename: "ProjectV2SingleSelectField";
      id?: string | null;
      name: string | null;
      options: Array<{
        id: string;
        name: string;
      } | null> | null;
    }
  | {
      __typename: string;
      name?: string | null;
    };

type GraphQLIssueNode = {
  __typename: "Issue";
  id: string;
  number: number;
  title: string;
  body: string | null;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  labels: { nodes: Array<{ name: string | null } | null> | null } | null;
  assignees: { nodes: Array<{ login: string | null } | null> | null } | null;
  repository: {
    name: string;
    url: string;
    owner: { login: string };
  };
  closedByPullRequestsReferences?: {
    nodes: Array<GraphQLPullRequestNode | null> | null;
    pageInfo?: {
      hasNextPage: boolean;
    } | null;
  } | null;
  blockedBy: {
    nodes: Array<{
      id: string;
      number: number;
      state: string | null;
      repository: {
        name: string;
        owner: { login: string };
      };
    } | null> | null;
  } | null;
};

type GraphQLPullRequestNode = {
  __typename: "PullRequest";
  id: string;
  number: number;
  title: string;
  body: string | null;
  url: string | null;
  state: string | null;
  isDraft: boolean | null;
  merged: boolean | null;
  headRefName: string | null;
  baseRefName: string | null;
  headRepository: {
    name: string;
    url: string;
    owner: { login: string };
  } | null;
  repository: {
    name: string;
    url: string;
    owner: { login: string };
  };
  createdAt: string | null;
  updatedAt: string | null;
};

type GraphQLProjectItem = {
  id: string;
  isArchived?: boolean;
  updatedAt: string | null;
  fieldValues: { nodes: Array<GraphQLFieldValue | null> | null } | null;
  content: GraphQLIssueNode | GraphQLPullRequestNode | null;
};

type GraphQLIssueProjectItemNode = {
  id: string;
  isArchived?: boolean;
  updatedAt: string | null;
  project: { id: string } | null;
  fieldValues: { nodes: Array<GraphQLFieldValue | null> | null } | null;
};

type GraphQLIssueProjectItemsConnection = {
  nodes: Array<GraphQLIssueProjectItemNode | null> | null;
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
};

type GraphQLIssueCommentNode = {
  id: string;
  databaseId: number;
  body: string;
};

type GraphQLIssueCommentsConnection = {
  nodes: Array<GraphQLIssueCommentNode | null> | null;
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
};

type GraphQLIssueCommentsByIdResponse = {
  node:
    | {
        __typename: "Issue";
        comments: GraphQLIssueCommentsConnection;
      }
    | { __typename: string }
    | null;
};

type GraphQLAddIssueCommentResponse = {
  addComment: {
    commentEdge: {
      node: GraphQLIssueCommentNode | null;
    } | null;
  } | null;
};

type GraphQLUpdateIssueCommentResponse = {
  updateIssueComment: {
    issueComment: GraphQLIssueCommentNode | null;
  } | null;
};

type GraphQLProjectItemsPage = {
  nodes: Array<GraphQLProjectItem | null> | null;
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
};

type GraphQLProjectItemsResponse = {
  node?: {
    __typename?: string;
    items?: GraphQLProjectItemsPage;
  } | null;
};

type GraphQLProjectFieldsResponse = {
  node?: {
    __typename?: string;
    fields?: {
      nodes: Array<GraphQLProjectFieldConfiguration | null> | null;
    };
  } | null;
};

type GraphQLIssueStateLookupNode = {
  __typename: "Issue" | "PullRequest";
  id: string;
  number: number;
  url?: string | null;
  updatedAt: string | null;
  headRefName?: string | null;
  repository: {
    name: string;
    url: string;
    owner: { login: string };
  };
  projectItems: GraphQLIssueProjectItemsConnection | null;
};

type GraphQLIssueStatesByIdsResponse = {
  nodes?: Array<GraphQLIssueStateLookupNode | null> | null;
};

type GraphQLIssueProjectItemsByIdResponse = {
  node?: GraphQLIssueStateLookupNode | null;
};

type GraphQLExactProjectItemNode = {
  __typename: "ProjectV2Item";
  id: string;
  project: { id: string } | null;
  content: { id: string } | null;
  fieldValues: { nodes: Array<GraphQLFieldValue | null> | null } | null;
};

type GraphQLExactProjectItemResponse = {
  node?: GraphQLExactProjectItemNode | { __typename: string } | null;
};

type GraphQLUpdateProjectItemResponse = {
  updateProjectV2ItemFieldValue?: {
    projectV2Item?: { id: string } | null;
  } | null;
};

type GraphQLRepositoryIssueLookupNode = GraphQLIssueNode & {
  projectItems: GraphQLIssueProjectItemsConnection | null;
};

type GraphQLRepositoryIssueLookupResponse = {
  repository?: {
    issue?: GraphQLRepositoryIssueLookupNode | null;
  } | null;
};

type GraphQLResponse<TData> = {
  data?: TData & {
    rateLimit?: GraphQLRateLimitField | null;
  };
  errors?: Array<{ message: string }>;
};

type PriorityMap = Record<string, number>;

type PriorityResolutionConfig = {
  explicit?: WorkflowPriorityConfig | null;
  legacy?: {
    fieldName?: string;
    optionIds?: PriorityMap;
  };
};

type LegacyPriorityResolutionConfig = {
  fieldName?: string;
  optionIds?: PriorityMap;
};

type PriorityResolutionInput =
  | PriorityResolutionConfig
  | LegacyPriorityResolutionConfig;

export class GitHubTrackerError extends Error {
  constructor(
    message: string,
    readonly rateLimits: Record<string, unknown> | null = null
  ) {
    super(message);
  }
}

export class GitHubTrackerHttpError extends GitHubTrackerError {
  constructor(
    message: string,
    readonly status: number,
    readonly details: string,
    rateLimits: Record<string, unknown> | null = null,
    readonly retryAfterMs: number | null = null
  ) {
    super(message, rateLimits);
  }
}

export class GitHubTrackerQueryError extends GitHubTrackerError {}

type GitHubRateLimitPayload = {
  source: "github";
  limit: number | null;
  remaining: number | null;
  used: number | null;
  reset: number | null;
  resetAt: string | null;
  resource: string | null;
  cost?: number;
  cycleCost?: number;
  queryCosts?: Record<
    string,
    {
      requestCount: number;
      cost: number;
    }
  >;
  fieldRateLimits?: GraphQLRateLimitField;
  headerRateLimits?: GitHubRateLimitHeaderPayload | null;
};

type GitHubRateLimitHeaderPayload = Omit<
  GitHubRateLimitPayload,
  "cost" | "cycleCost" | "queryCosts" | "fieldRateLimits" | "headerRateLimits"
>;

type GraphQLRateLimitField = {
  cost: number;
  remaining: number;
  resetAt: string;
};

type GitHubRateLimitObservation = {
  operationName: string;
  rateLimit: GraphQLRateLimitField;
  payload: GitHubRateLimitPayload;
};

type GitHubRateLimitCollector = {
  observations: GitHubRateLimitObservation[];
};

const cachedGitHubGraphQLRateLimits = new Map<
  string,
  GitHubRateLimitPayload | null
>();
const ARCHIVED_PROJECT_ITEM_STATE = "Archived";
const transitionQueueTails = new Map<string, Promise<void>>();
const transitionQueueDepths = new Map<string, number>();

export function normalizeProjectItem(
  projectId: string,
  item: GraphQLProjectItem,
  lifecycle: WorkflowLifecycleConfig = DEFAULT_WORKFLOW_LIFECYCLE,
  priority: PriorityResolutionInput = {},
  rateLimits: Record<string, unknown> | null = null
): GitHubTrackedIssue | null {
  if (
    item.content?.__typename !== "Issue" &&
    item.content?.__typename !== "PullRequest"
  ) {
    return null;
  }

  const fieldValues = extractFieldValues(item.fieldValues?.nodes ?? []);
  const isArchived = item.isArchived === true;
  const state = isArchived
    ? ARCHIVED_PROJECT_ITEM_STATE
    : requireProjectItemState(fieldValues, lifecycle, item.id);

  if (item.content.__typename === "PullRequest") {
    return normalizePullRequestProjectItem(
      projectId,
      item,
      item.content,
      fieldValues,
      state,
      priority,
      rateLimits
    );
  }

  const repository = item.content.repository;
  const blockedBy = (item.content.blockedBy?.nodes ?? []).flatMap((node) =>
    node
      ? [
          {
            id: node.id,
            identifier: `${node.repository.owner.login}/${node.repository.name}#${node.number}`,
            state: normalizeBlockerState(node.state, lifecycle),
          },
        ]
      : []
  );
  const issueUpdatedAtMs = parseTimestampMs(item.content.updatedAt);
  const itemUpdatedAtMs = parseTimestampMs(item.updatedAt);
  const trackedUpdatedAt =
    itemUpdatedAtMs !== null &&
    (issueUpdatedAtMs === null || itemUpdatedAtMs > issueUpdatedAtMs)
      ? item.updatedAt
      : (item.content.updatedAt ?? item.updatedAt);
  const linkedPullRequests = normalizePullRequestNodes(
    item.content.closedByPullRequestsReferences?.nodes ?? []
  );
  const linkedPullRequestsTruncated =
    item.content.closedByPullRequestsReferences?.pageInfo?.hasNextPage ?? false;

  return {
    id: item.content.id,
    identifier: `${repository.owner.login}/${repository.name}#${item.content.number}`,
    number: item.content.number,
    title: item.content.title,
    description: item.content.body,
    priority: resolvePriority(item, priority),
    state,
    branchName: null,
    url: item.content.url,
    labels: normalizeLabelNames(item.content.labels?.nodes ?? []),
    blockedBy,
    createdAt: item.content.createdAt,
    updatedAt: trackedUpdatedAt,
    repository: {
      owner: repository.owner.login,
      name: repository.name,
      url: repository.url,
      cloneUrl: deriveCloneUrl(repository.url),
    },
    tracker: {
      adapter: "github-project",
      bindingId: projectId,
      itemId: item.id,
    },
    metadata: withIssueMetadata(
      fieldValues,
      linkedPullRequests,
      linkedPullRequestsTruncated,
      isArchived
    ),
    rateLimits,
  };
}

function normalizePullRequestProjectItem(
  projectId: string,
  item: GraphQLProjectItem,
  content: GraphQLPullRequestNode,
  fieldValues: Record<string, string>,
  state: string,
  priority: PriorityResolutionInput,
  rateLimits: Record<string, unknown> | null
): GitHubTrackedIssue {
  const pullRequest = normalizePullRequestNode(content);
  const itemUpdatedAtMs = parseTimestampMs(item.updatedAt);
  const pullRequestUpdatedAtMs = parseTimestampMs(content.updatedAt);
  const trackedUpdatedAt =
    itemUpdatedAtMs !== null &&
    (pullRequestUpdatedAtMs === null ||
      itemUpdatedAtMs > pullRequestUpdatedAtMs)
      ? item.updatedAt
      : (content.updatedAt ?? item.updatedAt);

  return {
    id: content.id,
    identifier: pullRequest.identifier,
    number: content.number,
    title: content.title,
    description: content.body,
    priority: resolvePriority(item, priority),
    state,
    branchName: content.headRefName,
    url: content.url,
    labels: [],
    blockedBy: [],
    createdAt: content.createdAt,
    updatedAt: trackedUpdatedAt,
    repository: pullRequest.repository,
    tracker: {
      adapter: "github-project",
      bindingId: projectId,
      itemId: item.id,
    },
    metadata: withGitHubMetadata(fieldValues, {
      contentType: "PullRequest",
      pullRequest,
      linkedPullRequests: [],
      isArchived: item.isArchived === true,
    }),
    rateLimits,
  };
}

export async function fetchProjectIssues(
  config: GitHubTrackerConfig,
  fetchImpl: FetchLike = fetch
): Promise<GitHubTrackedIssue[] & TrackedIssueList> {
  const cycleConfig = beginGraphQLRateLimitCycle(config);
  // GitHub Project V2 does not expose query-time item filtering by workflow
  // state, so callers must fetch the project items and filter in memory.
  const issues: GitHubTrackedIssue[] = [];
  let cursor: string | null = null;
  const priorityOptionIds =
    !config.priority && config.priorityFieldName
      ? await fetchPriorityOptionOrder(
          cycleConfig,
          config.priorityFieldName,
          fetchImpl
        )
      : undefined;
  const currentUserLogin = config.assignedOnly
    ? await fetchCurrentUserLogin(config, fetchImpl)
    : null;
  let excludedCount = 0;
  let repositoryExcludedCount = 0;
  let latestRateLimits: GitHubRateLimitPayload | null = null;

  do {
    const pageResult = await fetchProjectItemsPage(
      cycleConfig,
      cursor,
      fetchImpl
    );
    const page = pageResult.page;
    latestRateLimits = pageResult.rateLimits ?? latestRateLimits;
    const pageIssues = (page.nodes ?? []).flatMap((item) => {
      if (!item) {
        return [];
      }

      if (!isRepositoryFilterableProjectItem(item)) {
        if (config.repositoryFilter) {
          repositoryExcludedCount += 1;
        }
        return [];
      }

      if (currentUserLogin && !isIssueAssignedToLogin(item, currentUserLogin)) {
        excludedCount += 1;
        return [];
      }

      if (
        config.repositoryFilter &&
        !isIssueInRepository(item, config.repositoryFilter)
      ) {
        repositoryExcludedCount += 1;
        return [];
      }

      const normalized = normalizeProjectItem(
        config.projectId,
        item,
        config.lifecycle,
        {
          explicit: config.priority,
          legacy: {
            fieldName: config.priorityFieldName,
            optionIds: priorityOptionIds,
          },
        },
        latestRateLimits
      );
      if (!normalized) {
        return [];
      }

      return [normalized];
    });

    issues.push(...pageIssues);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  if (currentUserLogin) {
    emitAssignedOnlyFilterEvent({
      projectId: config.projectId,
      currentUserLogin,
      includedCount: issues.length,
      excludedCount,
    });
  }

  if (config.repositoryFilter) {
    emitRepositoryFilterEvent({
      projectId: config.projectId,
      repository: `${config.repositoryFilter.owner}/${config.repositoryFilter.name}`,
      includedCount: issues.length,
      excludedCount: repositoryExcludedCount,
    });
  }

  latestRateLimits = finalizeGraphQLRateLimitCycle(
    latestRateLimits,
    cycleConfig.rateLimitCollector
  );
  (issues as TrackedIssueList).rateLimits = latestRateLimits;

  return issues as GitHubTrackedIssue[] & TrackedIssueList;
}

export async function fetchActionableIssues(
  config: GitHubTrackerConfig,
  fetchImpl: FetchLike = fetch
): Promise<GitHubTrackedIssue[]> {
  const issues = await fetchProjectIssues(config, fetchImpl);
  const lifecycle = config.lifecycle ?? DEFAULT_WORKFLOW_LIFECYCLE;
  return issues.filter((issue) => {
    const normalized = issue.state.trim().toLowerCase();
    return lifecycle.activeStates.some(
      (s) => s.trim().toLowerCase() === normalized
    );
  });
}

export async function fetchIssueStatesByIds(
  config: GitHubTrackerConfig,
  issueIds: readonly string[],
  fetchImpl: FetchLike = fetch
): Promise<GitHubTrackedIssue[] & TrackedIssueList> {
  if (issueIds.length === 0) {
    return [];
  }

  const issues: GitHubTrackedIssue[] = [];
  const cycleConfig = beginGraphQLRateLimitCycle(config);
  let latestRateLimits: GitHubRateLimitPayload | null = null;

  for (const issueIdBatch of chunkValues([...new Set(issueIds)], 100)) {
    const result =
      await executeGraphQLQueryWithMetadata<GraphQLIssueStatesByIdsResponse>(
        cycleConfig,
        ISSUE_STATES_BY_IDS_QUERY,
        {
          issueIds: issueIdBatch,
        },
        fetchImpl
      );
    const data = result.data;
    const rateLimits = result.rateLimits;
    latestRateLimits = rateLimits ?? latestRateLimits;

    for (const node of data.nodes ?? []) {
      const projectItem = await resolveIssueProjectItemForStateLookup(
        cycleConfig,
        node,
        fetchImpl
      );
      const normalized = normalizeIssueStateLookupNode(
        config.projectId,
        node,
        projectItem,
        config.lifecycle,
        rateLimits
      );
      if (normalized) {
        issues.push(normalized);
      }
    }
  }

  const rateLimits = finalizeGraphQLRateLimitCycle(
    latestRateLimits,
    cycleConfig.rateLimitCollector
  );
  (issues as TrackedIssueList).rateLimits = rateLimits;

  return issues as GitHubTrackedIssue[] & TrackedIssueList;
}

export async function requestGithubProjectItemState(
  config: GitHubTrackerConfig,
  input: {
    issueSubjectId: string;
    itemId: string;
    request: TrackerStateRequest;
  },
  fetchImpl: FetchLike = fetch
): Promise<TrackerStateResult> {
  const queueKey = `${fingerprintToken(config.token)}:${config.projectId}`;
  const depth = transitionQueueDepths.get(queueKey) ?? 0;
  if (depth >= MAX_TRANSITION_QUEUE_DEPTH) {
    return {
      ok: false,
      outcome: "rejected",
      state: null,
      expectedState:
        input.request.type === "transition-request"
          ? input.request.expectedState
          : null,
      targetState:
        input.request.type === "transition-request"
          ? input.request.targetState
          : null,
      reason:
        input.request.type === "transition-request"
          ? input.request.reason
          : null,
      rateLimits:
        cachedGitHubGraphQLRateLimits.get(fingerprintToken(config.token)) ??
        null,
      error: "tracker_transition_queue_full",
    };
  }

  transitionQueueDepths.set(queueKey, depth + 1);
  const previous = transitionQueueTails.get(queueKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  transitionQueueTails.set(
    queueKey,
    previous.catch(() => undefined).then(() => gate)
  );

  await previous.catch(() => undefined);
  try {
    return await executeGithubProjectItemStateRequest(config, input, fetchImpl);
  } finally {
    release();
    const nextDepth = (transitionQueueDepths.get(queueKey) ?? 1) - 1;
    if (nextDepth <= 0) {
      transitionQueueDepths.delete(queueKey);
      transitionQueueTails.delete(queueKey);
    } else {
      transitionQueueDepths.set(queueKey, nextDepth);
    }
  }
}

async function executeGithubProjectItemStateRequest(
  config: GitHubTrackerConfig,
  input: {
    issueSubjectId: string;
    itemId: string;
    request: TrackerStateRequest;
  },
  fetchImpl: FetchLike
): Promise<TrackerStateResult> {
  const cycleConfig = beginGraphQLRateLimitCycle(config);
  let latestRateLimits: GitHubRateLimitPayload | null = null;
  const initial = await readExactProjectItemState(
    cycleConfig,
    input,
    fetchImpl
  );
  latestRateLimits = initial.rateLimits;

  if (input.request.type === "state-read") {
    return buildTrackerStateResult({
      ok: true,
      outcome: "confirmed",
      state: initial.state,
      request: input.request,
      rateLimits: finalizeGraphQLRateLimitCycle(
        latestRateLimits,
        cycleConfig.rateLimitCollector
      ),
    });
  }

  if (!statesEqual(initial.state, input.request.expectedState)) {
    return buildTrackerStateResult({
      ok: false,
      outcome: "expected_state_mismatch",
      state: initial.state,
      request: input.request,
      rateLimits: finalizeGraphQLRateLimitCycle(
        latestRateLimits,
        cycleConfig.rateLimitCollector
      ),
      error: `expected_state_mismatch: expected "${input.request.expectedState}", confirmed "${initial.state}"`,
    });
  }

  const statusField = await resolveStatusFieldConfiguration(
    cycleConfig,
    input.request.targetState,
    fetchImpl
  );
  latestRateLimits = statusField.rateLimits ?? latestRateLimits;
  const mutation = await executeTransitionMutationWithRetry(
    cycleConfig,
    {
      itemId: input.itemId,
      fieldId: statusField.fieldId,
      optionId: statusField.optionId,
    },
    fetchImpl
  );
  latestRateLimits = mutation.rateLimits ?? latestRateLimits;

  const readback = await readExactProjectItemState(
    cycleConfig,
    input,
    fetchImpl
  );
  latestRateLimits = readback.rateLimits ?? latestRateLimits;
  const confirmed = statesEqual(readback.state, input.request.targetState);
  return buildTrackerStateResult({
    ok: confirmed,
    outcome: confirmed ? "confirmed" : "failed",
    state: readback.state,
    request: input.request,
    rateLimits: finalizeGraphQLRateLimitCycle(
      latestRateLimits,
      cycleConfig.rateLimitCollector
    ),
    error: confirmed
      ? null
      : `tracker_readback_mismatch: target "${input.request.targetState}", confirmed "${readback.state}"`,
  });
}

function buildTrackerStateResult(input: {
  ok: boolean;
  outcome: TrackerStateResult["outcome"];
  state: string | null;
  request: TrackerStateRequest;
  rateLimits: Record<string, unknown> | null;
  error?: string | null;
}): TrackerStateResult {
  return {
    ok: input.ok,
    outcome: input.outcome,
    state: input.state,
    expectedState:
      input.request.type === "transition-request"
        ? input.request.expectedState
        : null,
    targetState:
      input.request.type === "transition-request"
        ? input.request.targetState
        : null,
    reason:
      input.request.type === "transition-request" ? input.request.reason : null,
    rateLimits: input.rateLimits,
    error: input.error ?? null,
  };
}

async function readExactProjectItemState(
  config: GitHubTrackerConfig,
  input: { issueSubjectId: string; itemId: string },
  fetchImpl: FetchLike
): Promise<{
  state: string;
  rateLimits: GitHubRateLimitPayload | null;
}> {
  const result =
    await executeGraphQLQueryWithMetadata<GraphQLExactProjectItemResponse>(
      config,
      EXACT_PROJECT_ITEM_STATE_QUERY,
      { itemId: input.itemId },
      fetchImpl
    );
  const node = result.data.node;
  if (!node || node.__typename !== "ProjectV2Item") {
    throw new GitHubTrackerQueryError(
      `tracker_item_not_found: ${input.itemId}`
    );
  }
  const exactNode = node as GraphQLExactProjectItemNode;
  if (
    exactNode.id !== input.itemId ||
    exactNode.project?.id !== config.projectId ||
    exactNode.content?.id !== input.issueSubjectId
  ) {
    throw new GitHubTrackerQueryError(
      "tracker_item_authorization_mismatch: canonical item does not match the run issue and project"
    );
  }

  return {
    state: requireProjectItemState(
      extractFieldValues(exactNode.fieldValues?.nodes ?? []),
      config.lifecycle ?? DEFAULT_WORKFLOW_LIFECYCLE,
      input.itemId
    ),
    rateLimits: result.rateLimits,
  };
}

async function resolveStatusFieldConfiguration(
  config: GitHubTrackerConfig,
  targetState: string,
  fetchImpl: FetchLike
): Promise<{
  fieldId: string;
  optionId: string;
  rateLimits: GitHubRateLimitPayload | null;
}> {
  const result =
    await executeGraphQLQueryWithMetadata<GraphQLProjectFieldsResponse>(
      config,
      PROJECT_FIELDS_QUERY,
      { projectId: config.projectId },
      fetchImpl
    );
  const fieldName =
    config.lifecycle?.stateFieldName ??
    DEFAULT_WORKFLOW_LIFECYCLE.stateFieldName;
  const field = (result.data.node?.fields?.nodes ?? [])
    .filter(isSingleSelectProjectField)
    .find((candidate) => candidate.name === fieldName);
  if (!field || !field.id) {
    throw new GitHubTrackerQueryError(
      `tracker_status_field_not_found: ${fieldName}`
    );
  }
  const option = (field.options ?? []).find(
    (candidate) => candidate && statesEqual(candidate.name, targetState)
  );
  if (!option?.id) {
    throw new GitHubTrackerQueryError(
      `tracker_target_state_not_found: ${targetState}`
    );
  }
  return {
    fieldId: field.id,
    optionId: option.id,
    rateLimits: result.rateLimits,
  };
}

async function executeTransitionMutationWithRetry(
  config: GitHubTrackerConfig,
  input: { itemId: string; fieldId: string; optionId: string },
  fetchImpl: FetchLike
): Promise<{
  rateLimits: GitHubRateLimitPayload | null;
}> {
  let lastError: unknown;
  for (let attempt = 0; attempt < TRANSITION_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const result =
        await executeGraphQLQueryWithMetadata<GraphQLUpdateProjectItemResponse>(
          config,
          UPDATE_PROJECT_ITEM_STATE_MUTATION,
          {
            projectId: config.projectId,
            itemId: input.itemId,
            fieldId: input.fieldId,
            optionId: input.optionId,
          },
          fetchImpl
        );
      if (
        result.data.updateProjectV2ItemFieldValue?.projectV2Item?.id !==
        input.itemId
      ) {
        throw new GitHubTrackerQueryError(
          "tracker_transition_mutation_unconfirmed"
        );
      }
      return { rateLimits: result.rateLimits };
    } catch (error) {
      lastError = error;
      if (
        attempt + 1 >= TRANSITION_RETRY_ATTEMPTS ||
        !isRetryableTransitionError(error)
      ) {
        throw error;
      }
      const delayMs = resolveTransitionRetryDelay(error, attempt);
      if (delayMs === null) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function resolveTransitionRetryDelay(
  error: unknown,
  attempt: number
): number | null {
  const fallbackMs = TRANSITION_RETRY_BASE_MS * 2 ** attempt;
  if (!(error instanceof GitHubTrackerHttpError)) {
    return fallbackMs;
  }
  const resetAtMs =
    parseTimestampMs(
      typeof error.rateLimits?.resetAt === "string"
        ? error.rateLimits.resetAt
        : null
    ) ??
    (typeof error.rateLimits?.reset === "number"
      ? error.rateLimits.reset * 1_000
      : null);
  const resetWaitMs =
    resetAtMs === null ? null : Math.max(0, resetAtMs - Date.now());
  const providerWaitMs = Math.max(error.retryAfterMs ?? 0, resetWaitMs ?? 0);
  if (providerWaitMs > MAX_RATE_LIMIT_WAIT_MS) {
    return null;
  }
  return Math.max(fallbackMs, providerWaitMs);
}

function isRetryableTransitionError(error: unknown): boolean {
  if (
    error instanceof GitHubTrackerHttpError &&
    (error.status === 429 ||
      (error.status === 403 &&
        error.details.toLowerCase().includes("rate limit")) ||
      error.status >= 500)
  ) {
    return true;
  }
  return (
    error instanceof GitHubTrackerError &&
    error.message.toLowerCase().includes("rate limit")
  );
}

function statesEqual(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export async function fetchProjectIssueByRepositoryAndNumber(
  config: GitHubTrackerConfig,
  repository: {
    owner: string;
    name: string;
  },
  issueNumber: number,
  fetchImpl: FetchLike = fetch
): Promise<GitHubTrackedIssue | null> {
  const cycleConfig = beginGraphQLRateLimitCycle(config);
  const priorityOptionIds =
    !config.priority && config.priorityFieldName
      ? await fetchPriorityOptionOrder(
          cycleConfig,
          config.priorityFieldName,
          fetchImpl
        )
      : undefined;
  const result =
    await executeGraphQLQueryWithMetadata<GraphQLRepositoryIssueLookupResponse>(
      cycleConfig,
      REPOSITORY_ISSUE_QUERY,
      {
        owner: repository.owner,
        name: repository.name,
        issueNumber,
      },
      fetchImpl
    );
  const issue = result.data.repository?.issue ?? null;

  if (!issue) {
    return null;
  }

  const projectItem = await resolveIssueProjectItemForStateLookup(
    cycleConfig,
    issue,
    fetchImpl
  );

  if (!projectItem) {
    return null;
  }

  return normalizeRepositoryIssueLookup(
    config.projectId,
    issue,
    projectItem,
    config.lifecycle,
    {
      explicit: config.priority,
      legacy: {
        fieldName: config.priorityFieldName,
        optionIds: priorityOptionIds,
      },
    },
    finalizeGraphQLRateLimitCycle(
      result.rateLimits,
      cycleConfig.rateLimitCollector
    )
  );
}

async function fetchProjectItemsPage(
  config: GitHubTrackerConfig,
  cursor: string | null,
  fetchImpl: FetchLike
): Promise<{
  page: GraphQLProjectItemsPage;
  rateLimits: GitHubRateLimitPayload | null;
}> {
  const result =
    await executeGraphQLQueryWithMetadata<GraphQLProjectItemsResponse>(
      config,
      PROJECT_ITEMS_QUERY,
      {
        projectId: config.projectId,
        cursor,
        pageSize: config.pageSize ?? DEFAULT_PAGE_SIZE,
      },
      fetchImpl
    );
  const data = result.data;
  const items = data.node?.items;

  if (!items) {
    throw new GitHubTrackerQueryError(
      "GitHub GraphQL response did not include project items."
    );
  }

  return {
    page: items,
    rateLimits: result.rateLimits,
  };
}

export const normalizeGithubProjectItem = normalizeProjectItem;
export const fetchGithubProjectIssues = fetchProjectIssues;
export const fetchGithubIssueStatesByIds = fetchIssueStatesByIds;
export const fetchGithubProjectIssueByRepositoryAndNumber =
  fetchProjectIssueByRepositoryAndNumber;
export const upsertGithubIssueComment = upsertIssueComment;

async function upsertIssueComment(
  config: GitHubTrackerConfig,
  issue: Pick<TrackedIssue, "id" | "number" | "repository">,
  input: {
    marker: string;
    body: string;
  },
  fetchImpl: FetchLike = fetch,
  cache?: IssueCommentCache
): Promise<"created" | "updated" | "unchanged"> {
  if (cache) {
    return upsertIssueCommentWithCache(config, issue, input, fetchImpl, cache);
  }

  const existingComment = await findIssueCommentByMarker(
    config,
    issue.id,
    input.marker,
    fetchImpl
  );

  if (!existingComment) {
    await executeGraphQLQuery<GraphQLAddIssueCommentResponse>(
      config,
      ADD_ISSUE_COMMENT_MUTATION,
      {
        subjectId: issue.id,
        body: input.body,
      },
      fetchImpl
    );
    return "created";
  }

  if (existingComment.body === input.body) {
    return "unchanged";
  }

  await executeGraphQLQuery<GraphQLUpdateIssueCommentResponse>(
    config,
    UPDATE_ISSUE_COMMENT_MUTATION,
    {
      commentId: existingComment.id,
      body: input.body,
    },
    fetchImpl
  );
  return "updated";
}

async function upsertIssueCommentWithCache(
  config: GitHubTrackerConfig,
  issue: Pick<TrackedIssue, "id" | "number" | "repository">,
  input: {
    marker: string;
    body: string;
  },
  fetchImpl: FetchLike,
  cache: IssueCommentCache
): Promise<"created" | "updated" | "unchanged"> {
  const cacheKey = buildIssueCommentCacheKey(issue, input.marker);
  const cached = await cache.get(cacheKey);

  if (cached) {
    const current = await fetchRestIssueComment(
      config,
      issue,
      cached.commentId,
      cached.etag,
      fetchImpl
    );
    if (current.status === "not-modified") {
      if (cached.body === input.body) {
        return "unchanged";
      }

      const updated = await updateRestIssueComment(
        config,
        issue,
        cached.commentId,
        input.body,
        fetchImpl
      );
      await cache.set(cacheKey, updated);
      return "updated";
    }
    if (current.status === "found") {
      await cache.set(cacheKey, current.entry);
      if (current.entry.body === input.body) {
        return "unchanged";
      }

      const updated = await updateRestIssueComment(
        config,
        issue,
        current.entry.commentId,
        input.body,
        fetchImpl
      );
      await cache.set(cacheKey, updated);
      return "updated";
    }

    await cache.delete(cacheKey);
  }

  const discovered = await findIssueCommentByMarker(
    config,
    issue.id,
    input.marker,
    fetchImpl
  );
  if (!discovered) {
    const created = await createRestIssueComment(
      config,
      issue,
      input.body,
      fetchImpl
    );
    await cache.set(cacheKey, created);
    return "created";
  }

  const current = await fetchRestIssueComment(
    config,
    issue,
    discovered.databaseId,
    null,
    fetchImpl
  );
  if (current.status === "missing") {
    const created = await createRestIssueComment(
      config,
      issue,
      input.body,
      fetchImpl
    );
    await cache.set(cacheKey, created);
    return "created";
  }
  if (current.status === "not-modified") {
    throw new GitHubTrackerQueryError(
      "GitHub returned 304 for an unconditional issue comment request."
    );
  }

  await cache.set(cacheKey, current.entry);
  if (current.entry.body === input.body) {
    return "unchanged";
  }

  const updated = await updateRestIssueComment(
    config,
    issue,
    current.entry.commentId,
    input.body,
    fetchImpl
  );
  await cache.set(cacheKey, updated);
  return "updated";
}

function buildIssueCommentCacheKey(
  issue: Pick<TrackedIssue, "number" | "repository">,
  marker: string
): string {
  const markerHash = createHash("sha256").update(marker).digest("hex");
  return [
    "github",
    issue.repository.owner.toLowerCase(),
    issue.repository.name.toLowerCase(),
    `issue-${issue.number}`,
    markerHash,
  ].join(":");
}

async function fetchRestIssueComment(
  config: GitHubTrackerConfig,
  issue: Pick<TrackedIssue, "repository">,
  commentId: number,
  etag: string | null,
  fetchImpl: FetchLike
): Promise<
  | { status: "not-modified" }
  | { status: "missing" }
  | { status: "found"; entry: IssueCommentCacheEntry }
> {
  const response = await fetchImpl(
    resolveRestApiUrl(
      config.apiUrl,
      `/repos/${encodeURIComponent(issue.repository.owner)}/${encodeURIComponent(issue.repository.name)}/issues/comments/${commentId}`
    ),
    {
      method: "GET",
      headers: buildRestHeaders(config, etag),
      signal: buildRequestSignal(config.timeoutMs),
    }
  );

  if (response.status === 304) {
    return { status: "not-modified" };
  }
  if (response.status === 404) {
    return { status: "missing" };
  }
  if (!response.ok) {
    throw await buildRestHttpError(response);
  }

  return {
    status: "found",
    entry: await parseRestIssueComment(response),
  };
}

async function createRestIssueComment(
  config: GitHubTrackerConfig,
  issue: Pick<TrackedIssue, "number" | "repository">,
  body: string,
  fetchImpl: FetchLike
): Promise<IssueCommentCacheEntry> {
  const response = await fetchImpl(
    resolveRestApiUrl(
      config.apiUrl,
      `/repos/${encodeURIComponent(issue.repository.owner)}/${encodeURIComponent(issue.repository.name)}/issues/${issue.number}/comments`
    ),
    {
      method: "POST",
      headers: buildRestHeaders(config),
      body: JSON.stringify({ body }),
      signal: buildRequestSignal(config.timeoutMs),
    }
  );
  if (!response.ok) {
    throw await buildRestHttpError(response);
  }

  return parseRestIssueComment(response);
}

async function updateRestIssueComment(
  config: GitHubTrackerConfig,
  issue: Pick<TrackedIssue, "repository">,
  commentId: number,
  body: string,
  fetchImpl: FetchLike
): Promise<IssueCommentCacheEntry> {
  const response = await fetchImpl(
    resolveRestApiUrl(
      config.apiUrl,
      `/repos/${encodeURIComponent(issue.repository.owner)}/${encodeURIComponent(issue.repository.name)}/issues/comments/${commentId}`
    ),
    {
      method: "PATCH",
      headers: buildRestHeaders(config),
      body: JSON.stringify({ body }),
      signal: buildRequestSignal(config.timeoutMs),
    }
  );
  if (!response.ok) {
    throw await buildRestHttpError(response);
  }

  return parseRestIssueComment(response);
}

function buildRestHeaders(
  config: GitHubTrackerConfig,
  etag?: string | null
): Record<string, string> {
  return {
    authorization: `Bearer ${config.token}`,
    "user-agent": "gh-symphony",
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    ...(etag ? { "if-none-match": etag } : {}),
  };
}

async function parseRestIssueComment(
  response: Response
): Promise<IssueCommentCacheEntry> {
  const payload = (await response.json()) as {
    id?: number;
    body?: string;
  };
  if (typeof payload.id !== "number" || typeof payload.body !== "string") {
    throw new GitHubTrackerQueryError(
      "GitHub REST response did not include a valid issue comment."
    );
  }

  return {
    commentId: payload.id,
    etag: response.headers.get("etag"),
    body: payload.body,
  };
}

async function buildRestHttpError(
  response: Response
): Promise<GitHubTrackerHttpError> {
  const details = await response.text();
  return new GitHubTrackerHttpError(
    `GitHub REST request failed with status ${response.status}`,
    response.status,
    details
  );
}

async function findIssueCommentByMarker(
  config: GitHubTrackerConfig,
  issueId: string,
  marker: string,
  fetchImpl: FetchLike
): Promise<GraphQLIssueCommentNode | null> {
  let cursor: string | null = null;

  while (true) {
    const data: GraphQLIssueCommentsByIdResponse =
      await executeGraphQLQuery<GraphQLIssueCommentsByIdResponse>(
        config,
        ISSUE_COMMENTS_BY_ID_QUERY,
        {
          issueId,
          cursor,
        },
        fetchImpl
      );

    if (data.node?.__typename !== "Issue") {
      throw new GitHubTrackerQueryError(
        "GitHub GraphQL response did not include issue comments."
      );
    }
    const issueNode = data.node as Extract<
      GraphQLIssueCommentsByIdResponse["node"],
      { __typename: "Issue" }
    >;

    const match =
      issueNode.comments.nodes?.find(
        (comment: GraphQLIssueCommentNode | null) =>
          comment?.body.includes(marker)
      ) ?? null;
    if (match) {
      return match;
    }

    if (!issueNode.comments.pageInfo.hasNextPage) {
      return null;
    }
    cursor = issueNode.comments.pageInfo.endCursor;
  }
}

async function fetchCurrentUserLogin(
  config: GitHubTrackerConfig,
  fetchImpl: FetchLike
): Promise<string> {
  const response = await fetchImpl(resolveRestUserApiUrl(config.apiUrl), {
    method: "GET",
    headers: {
      authorization: `Bearer ${config.token}`,
      "user-agent": "gh-symphony",
      accept: "application/vnd.github+json",
    },
    signal: buildRequestSignal(config.timeoutMs),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new GitHubTrackerHttpError(
      `GitHub REST request failed with status ${response.status}`,
      response.status,
      details
    );
  }

  const payload = (await response.json()) as { login?: string };
  if (!payload.login) {
    throw new GitHubTrackerQueryError(
      "GitHub REST response did not include the authenticated user login."
    );
  }

  return payload.login;
}

function isIssueAssignedToLogin(
  item: GraphQLProjectItem,
  login: string
): boolean {
  if (item.content?.__typename !== "Issue") {
    return false;
  }

  return (item.content.assignees?.nodes ?? []).some(
    (assignee) => assignee?.login === login
  );
}

function isRepositoryFilterableProjectItem(
  item: GraphQLProjectItem
): item is GraphQLProjectItem & {
  content: GraphQLIssueNode | GraphQLPullRequestNode;
} {
  return (
    item.content?.__typename === "Issue" ||
    item.content?.__typename === "PullRequest"
  );
}

function isIssueInRepository(
  item: GraphQLProjectItem & {
    content: GraphQLIssueNode | GraphQLPullRequestNode;
  },
  repository: { owner: string; name: string }
): boolean {
  const itemRepository = item.content.repository;
  const itemOwner = itemRepository.owner.login.toLowerCase();
  const itemName = itemRepository.name.toLowerCase();
  const filterOwner = repository.owner.toLowerCase();
  const filterName = repository.name.toLowerCase();

  return itemOwner === filterOwner && itemName === filterName;
}

function emitAssignedOnlyFilterEvent(input: {
  projectId: string;
  currentUserLogin: string;
  includedCount: number;
  excludedCount: number;
}): void {
  console.info(
    JSON.stringify({
      event: "tracker-assigned-only-filtered",
      projectId: input.projectId,
      currentUserLogin: input.currentUserLogin,
      includedCount: input.includedCount,
      excludedCount: input.excludedCount,
    })
  );
}

function emitRepositoryFilterEvent(input: {
  projectId: string;
  repository: string;
  includedCount: number;
  excludedCount: number;
}): void {
  console.info(
    JSON.stringify({
      event: "tracker-repository-filtered",
      projectId: input.projectId,
      repository: input.repository,
      includedCount: input.includedCount,
      excludedCount: input.excludedCount,
    })
  );
}

function extractFieldValues(
  nodes: Array<GraphQLFieldValue | null>
): Record<string, string> {
  return nodes.reduce<Record<string, string>>((values, node) => {
    const fieldName = node?.field?.name;

    if (!fieldName) {
      return values;
    }

    if (
      node.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
      node.name
    ) {
      values[fieldName] = node.name;
    }

    if (node.__typename === "ProjectV2ItemFieldTextValue" && node.text) {
      values[fieldName] = node.text;
    }

    return values;
  }, {});
}

function requireProjectItemState(
  fieldValues: Record<string, string>,
  lifecycle: WorkflowLifecycleConfig,
  itemId: string
): string {
  const stateFieldName =
    typeof lifecycle.stateFieldName === "string"
      ? lifecycle.stateFieldName.trim()
      : "";
  if (!stateFieldName) {
    throw new GitHubTrackerQueryError(
      `github_project_state_field_unconfigured: Project item ${itemId} cannot be normalized without lifecycle.stateFieldName.`
    );
  }

  const state = fieldValues[stateFieldName];
  if (!state) {
    throw new GitHubTrackerQueryError(
      `github_project_state_field_missing: Project item ${itemId} did not include configured state field "${stateFieldName}".`
    );
  }

  return state;
}

function normalizeIssueStateLookupNode(
  projectId: string,
  issue: GraphQLIssueStateLookupNode | null,
  projectItem: GraphQLIssueProjectItemNode | null,
  lifecycle: WorkflowLifecycleConfig = DEFAULT_WORKFLOW_LIFECYCLE,
  rateLimits: Record<string, unknown> | null = null
): GitHubTrackedIssue | null {
  if (issue?.__typename !== "Issue" && issue?.__typename !== "PullRequest") {
    return null;
  }
  if (!projectItem) {
    return null;
  }

  const fieldValues = extractFieldValues(projectItem.fieldValues?.nodes ?? []);
  const isArchived = projectItem.isArchived === true;
  const state = isArchived
    ? ARCHIVED_PROJECT_ITEM_STATE
    : requireProjectItemState(fieldValues, lifecycle, projectItem.id);
  const repository = issue.repository;
  const identifier = `${repository.owner.login}/${repository.name}#${issue.number}`;
  const url =
    issue.url ??
    `${repository.url}/${issue.__typename === "PullRequest" ? "pull" : "issues"}/${issue.number}`;

  return {
    id: issue.id,
    identifier,
    number: issue.number,
    title: identifier,
    description: null,
    priority: null,
    state,
    branchName:
      issue.__typename === "PullRequest" ? (issue.headRefName ?? null) : null,
    url,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: projectItem.updatedAt ?? issue.updatedAt,
    repository: {
      owner: repository.owner.login,
      name: repository.name,
      url: repository.url,
      cloneUrl: deriveCloneUrl(repository.url),
    },
    tracker: {
      adapter: "github-project",
      bindingId: projectId,
      itemId: projectItem.id,
    },
    metadata:
      issue.__typename === "PullRequest"
        ? withGitHubMetadata(fieldValues, {
            contentType: "PullRequest",
            isArchived,
          })
        : withGitHubMetadata(fieldValues, {
            isArchived,
          }),
    rateLimits,
  };
}

function normalizeRepositoryIssueLookup(
  projectId: string,
  issue: GraphQLRepositoryIssueLookupNode | null,
  projectItem: GraphQLIssueProjectItemNode | null,
  lifecycle: WorkflowLifecycleConfig = DEFAULT_WORKFLOW_LIFECYCLE,
  priority: PriorityResolutionInput = {},
  rateLimits: Record<string, unknown> | null = null
): GitHubTrackedIssue | null {
  if (!issue || !projectItem) {
    return null;
  }

  return normalizeProjectItem(
    projectId,
    {
      id: projectItem.id,
      isArchived: projectItem.isArchived,
      updatedAt: projectItem.updatedAt,
      fieldValues: projectItem.fieldValues,
      content: issue,
    },
    lifecycle,
    priority,
    rateLimits
  );
}

function normalizePullRequestNodes(
  nodes: Array<GraphQLPullRequestNode | null>
): GitHubPullRequestMetadata[] {
  return nodes.flatMap((node) =>
    node ? [normalizePullRequestNode(node)] : []
  );
}

function normalizePullRequestNode(
  node: GraphQLPullRequestNode
): GitHubPullRequestMetadata {
  const repository = normalizeRepositoryRef(node.repository);

  return {
    id: node.id,
    number: node.number,
    identifier: `${repository.owner}/${repository.name}#${node.number}`,
    title: node.title,
    body: node.body,
    url: node.url,
    state: node.state,
    isDraft: node.isDraft,
    merged: node.merged,
    headRefName: node.headRefName,
    baseRefName: node.baseRefName,
    headRepository: node.headRepository
      ? normalizeRepositoryRef(node.headRepository)
      : null,
    repository,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

function normalizeRepositoryRef(repository: {
  name: string;
  url: string;
  owner: { login: string };
}): GitHubRepositoryRef {
  return {
    owner: repository.owner.login,
    name: repository.name,
    url: repository.url,
    cloneUrl: deriveCloneUrl(repository.url),
  };
}

function normalizeLabelNames(
  nodes: Array<{ name: string | null } | null>
): string[] {
  return nodes
    .flatMap((label) => (label?.name ? [label.name.toLowerCase()] : []))
    .sort();
}

function withGitHubMetadata(
  fieldValues: Record<string, string>,
  metadata: Record<string, unknown>
): TrackedIssue["metadata"] {
  return {
    ...fieldValues,
    ...metadata,
  } as TrackedIssue["metadata"];
}

function withIssueMetadata(
  fieldValues: Record<string, string>,
  linkedPullRequests: GitHubPullRequestMetadata[],
  linkedPullRequestsTruncated = false,
  isArchived = false
): TrackedIssue["metadata"] {
  if (
    linkedPullRequests.length === 0 &&
    !linkedPullRequestsTruncated &&
    !isArchived
  ) {
    return fieldValues;
  }

  return withGitHubMetadata(fieldValues, {
    linkedPullRequests,
    linkedPullRequestsTruncated,
    isArchived,
  });
}

async function resolveIssueProjectItemForStateLookup(
  config: GitHubTrackerConfig,
  issue: GraphQLIssueStateLookupNode | null,
  fetchImpl: FetchLike
): Promise<GraphQLIssueProjectItemNode | null> {
  if (issue?.__typename !== "Issue" && issue?.__typename !== "PullRequest") {
    return null;
  }

  let connection = issue.projectItems;
  let projectItem = findProjectItemByProjectId(
    connection?.nodes ?? [],
    config.projectId
  );
  let cursor = connection?.pageInfo.endCursor ?? null;

  while (!projectItem && connection?.pageInfo.hasNextPage) {
    const nextPage = await fetchIssueProjectItemsPage(
      config,
      issue.id,
      cursor,
      fetchImpl
    );
    projectItem = findProjectItemByProjectId(
      nextPage.nodes ?? [],
      config.projectId
    );
    connection = nextPage;
    cursor = nextPage.pageInfo.endCursor;
  }

  return projectItem;
}

async function fetchIssueProjectItemsPage(
  config: GitHubTrackerConfig,
  issueId: string,
  cursor: string | null,
  fetchImpl: FetchLike
): Promise<GraphQLIssueProjectItemsConnection> {
  const result =
    await executeGraphQLQueryWithMetadata<GraphQLIssueProjectItemsByIdResponse>(
      config,
      ISSUE_PROJECT_ITEMS_PAGE_QUERY,
      {
        issueId,
        cursor,
      },
      fetchImpl
    );
  const data = result.data;
  const issue = data.node;

  if (
    (issue?.__typename !== "Issue" && issue?.__typename !== "PullRequest") ||
    !issue.projectItems
  ) {
    throw new GitHubTrackerQueryError(
      "GitHub GraphQL response did not include issue project items."
    );
  }

  return issue.projectItems;
}

function findProjectItemByProjectId(
  nodes: Array<GraphQLIssueProjectItemNode | null>,
  projectId: string
): GraphQLIssueProjectItemNode | null {
  return nodes.find((item) => item?.project?.id === projectId) ?? null;
}

function resolvePriority(
  item: GraphQLProjectItem,
  priority: PriorityResolutionInput
): number | null {
  const normalizedPriority = normalizePriorityResolutionConfig(priority);

  if (normalizedPriority.explicit) {
    return resolveExplicitPriority(item, normalizedPriority.explicit);
  }

  if (
    !normalizedPriority.legacy?.fieldName ||
    !normalizedPriority.legacy.optionIds
  ) {
    return null;
  }

  for (const node of item.fieldValues?.nodes ?? []) {
    if (
      node?.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
      node.field?.name === normalizedPriority.legacy.fieldName &&
      node.optionId
    ) {
      return normalizedPriority.legacy.optionIds[node.optionId] ?? null;
    }
  }

  return null;
}

function normalizePriorityResolutionConfig(
  priority: PriorityResolutionInput
): PriorityResolutionConfig {
  if ("explicit" in priority || "legacy" in priority) {
    return priority;
  }

  return {
    legacy: priority as LegacyPriorityResolutionConfig,
  };
}

function resolveExplicitPriority(
  item: GraphQLProjectItem,
  priority: WorkflowPriorityConfig
): number | null {
  if (priority.source === "disabled") {
    return null;
  }

  if (priority.source === "project-field") {
    return resolveProjectFieldPriority(item, priority);
  }

  return resolveLabelPriority(item, priority);
}

function resolveProjectFieldPriority(
  item: GraphQLProjectItem,
  priority: Extract<WorkflowPriorityConfig, { source: "project-field" }>
): number | null {
  for (const node of item.fieldValues?.nodes ?? []) {
    if (
      node?.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
      node.field?.name === priority.field &&
      node.name
    ) {
      const resolved = priority.values[node.name] ?? null;
      if (resolved === null) {
        emitPriorityUnmapped(item, "project-field", [node.name]);
      }
      return resolved;
    }
  }

  return null;
}

function resolveLabelPriority(
  item: GraphQLProjectItem,
  priority: Extract<WorkflowPriorityConfig, { source: "labels" }>
): number | null {
  if (item.content?.__typename !== "Issue") {
    return null;
  }

  const labels = rawLabelNames(item.content.labels?.nodes ?? []);
  const matches = labels.flatMap((label) => {
    const value = priority.labels[label];
    return typeof value === "number" ? [{ label, value }] : [];
  });

  if (matches.length === 0) {
    if (labels.length > 0) {
      emitPriorityUnmapped(item, "labels", labels);
    }
    return null;
  }

  const chosenValue = Math.min(...matches.map((match) => match.value));
  if (matches.length > 1) {
    const chosenLabels = matches
      .filter((match) => match.value === chosenValue)
      .map((match) => match.label);
    emitPriorityLabelConflictResolved(item, matches, chosenValue, chosenLabels);
  }

  return chosenValue;
}

function rawLabelNames(nodes: Array<{ name: string | null } | null>): string[] {
  return nodes.flatMap((label) => (label?.name ? [label.name] : []));
}

function emitPriorityLabelConflictResolved(
  item: GraphQLProjectItem,
  matched: Array<{ label: string; value: number }>,
  chosenValue: number,
  chosenLabels: string[]
): void {
  const issue = issueEventMetadata(item);
  if (!issue) {
    return;
  }

  console.info(
    JSON.stringify({
      at: new Date().toISOString(),
      event: "priority.label_conflict_resolved",
      issue,
      matched,
      chosenValue,
      chosenLabels,
    })
  );
}

function emitPriorityUnmapped(
  item: GraphQLProjectItem,
  source: "project-field" | "labels",
  rawValues: string[]
): void {
  const issue = issueEventMetadata(item);
  if (!issue) {
    return;
  }

  console.info(
    JSON.stringify({
      at: new Date().toISOString(),
      event: "priority.unmapped",
      issue,
      source,
      rawValues,
    })
  );
}

function issueEventMetadata(item: GraphQLProjectItem): {
  identifier: string;
  id: string;
} | null {
  if (
    item.content?.__typename !== "Issue" &&
    item.content?.__typename !== "PullRequest"
  ) {
    return null;
  }

  return {
    identifier: `${item.content.repository.owner.login}/${item.content.repository.name}#${item.content.number}`,
    id: item.content.id,
  };
}

function extractPriorityOptionOrder(
  fields: Array<GraphQLProjectFieldConfiguration | null>,
  priorityFieldName: string
): PriorityMap | undefined {
  for (const field of fields) {
    if (isSingleSelectProjectField(field) && field.name === priorityFieldName) {
      let nextPriority = 0;
      const optionEntries = (field.options ?? []).flatMap((option) => {
        if (!option?.id) {
          return [];
        }

        const entry = [option.id, nextPriority] as const;
        nextPriority += 1;
        return [entry];
      });
      return Object.fromEntries(optionEntries);
    }
  }

  return undefined;
}

async function fetchPriorityOptionOrder(
  config: GitHubTrackerConfig,
  priorityFieldName: string,
  fetchImpl: FetchLike
): Promise<PriorityMap | undefined> {
  const data = await executeGraphQLQuery<GraphQLProjectFieldsResponse>(
    config,
    PROJECT_FIELDS_QUERY,
    { projectId: config.projectId },
    fetchImpl
  );

  return extractPriorityOptionOrder(
    data.node?.fields?.nodes ?? [],
    priorityFieldName
  );
}

function isSingleSelectProjectField(
  field: GraphQLProjectFieldConfiguration | null
): field is Extract<
  GraphQLProjectFieldConfiguration,
  { __typename: "ProjectV2SingleSelectField" }
> {
  return field?.__typename === "ProjectV2SingleSelectField";
}

function deriveCloneUrl(repositoryUrl: string): string {
  if (repositoryUrl.startsWith("file://") || repositoryUrl.endsWith(".git")) {
    return repositoryUrl;
  }

  return `${repositoryUrl}.git`;
}

function normalizeBlockerState(
  state: string | null,
  lifecycle: WorkflowLifecycleConfig
): string | null {
  if (!state) {
    return null;
  }

  const normalized = state.trim().toLowerCase();
  if (normalized === "closed") {
    return lifecycle.terminalStates[0] ?? state;
  }

  if (normalized === "open") {
    return null;
  }

  return state;
}

function resolveRestUserApiUrl(apiUrl?: string): string {
  return resolveRestApiUrl(apiUrl, "/user");
}

function resolveRestApiUrl(apiUrl: string | undefined, path: string): string {
  const parsed = new URL(apiUrl ?? DEFAULT_API_URL);
  const pathSegments = parsed.pathname.split("/").filter(Boolean);

  if (pathSegments.at(-1) === "graphql") {
    pathSegments.pop();
  }

  parsed.pathname =
    `/${pathSegments.join("/")}/${path.replace(/^\/+/, "")}`.replace(
      /\/{2,}/g,
      "/"
    );
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function chunkValues<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

function buildRequestSignal(timeoutMs?: number): AbortSignal {
  return AbortSignal.timeout(resolveNetworkTimeoutMs(timeoutMs));
}

function resolveNetworkTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs !== undefined && Number.isInteger(timeoutMs) && timeoutMs > 0) {
    return timeoutMs;
  }

  return DEFAULT_NETWORK_TIMEOUT_MS;
}

async function executeGraphQLQuery<TData>(
  config: GitHubTrackerConfig,
  query: string,
  variables: Record<string, string | number | string[] | null>,
  fetchImpl: FetchLike
): Promise<TData> {
  const result = await executeGraphQLQueryWithMetadata<TData>(
    config,
    query,
    variables,
    fetchImpl
  );
  return result.data;
}

async function executeGraphQLQueryWithMetadata<TData>(
  config: GitHubTrackerConfig,
  query: string,
  variables: Record<string, string | number | string[] | null>,
  fetchImpl: FetchLike
): Promise<{
  data: TData;
  rateLimits: GitHubRateLimitPayload | null;
}> {
  const tokenFingerprint = fingerprintToken(config.token);
  await guardGraphQLRateLimit(tokenFingerprint);

  const response = await fetchImpl(config.apiUrl ?? DEFAULT_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      query,
      variables,
    }),
    signal: buildRequestSignal(config.timeoutMs),
  });

  if (!response.ok) {
    const details = await response.text();
    const rateLimits = extractGitHubRateLimits(response.headers);
    cachedGitHubGraphQLRateLimits.set(tokenFingerprint, rateLimits);
    throw new GitHubTrackerHttpError(
      `GitHub GraphQL request failed with status ${response.status}`,
      response.status,
      details,
      rateLimits,
      parseRetryAfterMs(response.headers?.get?.("retry-after") ?? null)
    );
  }

  const payload = (await response.json()) as GraphQLResponse<TData>;

  if (payload.errors?.length) {
    throw new GitHubTrackerQueryError(
      payload.errors.map((error) => error.message).join("; ")
    );
  }

  if (!payload.data) {
    throw new GitHubTrackerQueryError(
      "GitHub GraphQL response did not include data."
    );
  }

  const data = payload.data as TData;
  const fieldRateLimits = extractGraphQLRateLimitField(payload.data.rateLimit);
  const rateLimits = extractGitHubRateLimits(response.headers, fieldRateLimits);
  if (fieldRateLimits && rateLimits) {
    config.rateLimitCollector?.observations.push({
      operationName: extractGraphQLOperationName(query),
      rateLimit: fieldRateLimits,
      payload: rateLimits,
    });
  }
  cachedGitHubGraphQLRateLimits.set(tokenFingerprint, rateLimits);
  return {
    data,
    rateLimits,
  };
}

async function guardGraphQLRateLimit(tokenFingerprint: string): Promise<void> {
  const rateLimit = cachedGitHubGraphQLRateLimits.get(tokenFingerprint) ?? null;
  if (!rateLimit) {
    return;
  }

  const remaining = rateLimit.remaining;
  if (remaining === null || remaining > RATE_LIMIT_SOFT_THRESHOLD) {
    return;
  }

  const resetAtMs = parseTimestampMs(rateLimit.resetAt);
  if (resetAtMs === null) {
    if (remaining <= RATE_LIMIT_HARD_THRESHOLD) {
      throw new GitHubTrackerError("Rate limit near exhaustion", rateLimit);
    }
    return;
  }

  const waitMs = Math.max(0, resetAtMs - Date.now());
  if (waitMs > MAX_RATE_LIMIT_WAIT_MS) {
    if (remaining <= RATE_LIMIT_HARD_THRESHOLD) {
      throw new GitHubTrackerError("Rate limit near exhaustion", rateLimit);
    }
    return;
  }

  cachedGitHubGraphQLRateLimits.delete(tokenFingerprint);
  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

function fingerprintToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function extractGitHubRateLimits(
  headers: Pick<Headers, "get"> | null | undefined,
  fieldRateLimits: GraphQLRateLimitField | null = null
): GitHubRateLimitPayload | null {
  const headerRateLimits = extractGitHubRateLimitHeaders(headers);
  if (!fieldRateLimits) {
    return headerRateLimits;
  }

  return {
    source: "github",
    limit: headerRateLimits?.limit ?? null,
    remaining: fieldRateLimits.remaining,
    used: headerRateLimits?.used ?? null,
    reset: headerRateLimits?.reset ?? null,
    resetAt: fieldRateLimits.resetAt,
    resource: headerRateLimits?.resource ?? "graphql",
    cost: fieldRateLimits.cost,
    fieldRateLimits,
    headerRateLimits,
  };
}

function extractGitHubRateLimitHeaders(
  headers: Pick<Headers, "get"> | null | undefined
): GitHubRateLimitHeaderPayload | null {
  if (!headers || typeof headers.get !== "function") {
    return null;
  }

  const limit = parseIntegerHeader(headers.get("x-ratelimit-limit"));
  const remaining = parseIntegerHeader(headers.get("x-ratelimit-remaining"));
  const used = parseIntegerHeader(headers.get("x-ratelimit-used"));
  const reset = parseIntegerHeader(headers.get("x-ratelimit-reset"));
  const resource = headers.get("x-ratelimit-resource");

  if (
    limit === null &&
    remaining === null &&
    used === null &&
    reset === null &&
    resource === null
  ) {
    return null;
  }

  return {
    source: "github",
    limit,
    remaining,
    used,
    reset,
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    resource,
  };
}

function extractGraphQLRateLimitField(
  value: GraphQLRateLimitField | null | undefined
): GraphQLRateLimitField | null {
  if (
    !value ||
    !Number.isFinite(value.cost) ||
    !Number.isFinite(value.remaining) ||
    typeof value.resetAt !== "string" ||
    parseTimestampMs(value.resetAt) === null
  ) {
    return null;
  }

  return {
    cost: value.cost,
    remaining: value.remaining,
    resetAt: value.resetAt,
  };
}

function extractGraphQLOperationName(query: string): string {
  return (
    /\b(?:query|mutation)\s+([_A-Za-z][_0-9A-Za-z]*)/.exec(query)?.[1] ??
    "Anonymous"
  );
}

function beginGraphQLRateLimitCycle(
  config: GitHubTrackerConfig
): GitHubTrackerConfig {
  return {
    ...config,
    rateLimitCollector: {
      observations: [],
    },
  };
}

function finalizeGraphQLRateLimitCycle(
  latestRateLimits: GitHubRateLimitPayload | null,
  collector: GitHubRateLimitCollector | undefined
): GitHubRateLimitPayload | null {
  const observations = collector?.observations ?? [];
  if (observations.length === 0) {
    return latestRateLimits;
  }

  const queryCosts: NonNullable<GitHubRateLimitPayload["queryCosts"]> = {};
  let cycleCost = 0;
  for (const observation of observations) {
    const previous = queryCosts[observation.operationName] ?? {
      requestCount: 0,
      cost: 0,
    };
    queryCosts[observation.operationName] = {
      requestCount: previous.requestCount + 1,
      cost: previous.cost + observation.rateLimit.cost,
    };
    cycleCost += observation.rateLimit.cost;
  }

  const latestObservation = observations.at(-1);
  return {
    ...(latestObservation?.payload ??
      latestRateLimits ?? {
        source: "github",
        limit: null,
        remaining: latestObservation?.rateLimit.remaining ?? null,
        used: null,
        reset: null,
        resetAt: latestObservation?.rateLimit.resetAt ?? null,
        resource: "graphql",
      }),
    cycleCost,
    queryCosts,
  };
}

function parseIntegerHeader(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestampMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  const retryAtMs = Date.parse(value);
  return Number.isFinite(retryAtMs)
    ? Math.max(0, retryAtMs - Date.now())
    : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function resetGitHubRateLimitCacheForTests(): void {
  cachedGitHubGraphQLRateLimits.clear();
  transitionQueueTails.clear();
  transitionQueueDepths.clear();
}

const PROJECT_ITEMS_QUERY = `
  query ProjectItems($projectId: ID!, $cursor: String, $pageSize: Int!) {
    rateLimit {
      cost
      remaining
      resetAt
    }
    node(id: $projectId) {
      __typename
      ... on ProjectV2 {
        items(first: $pageSize, after: $cursor) {
          nodes {
            id
            updatedAt
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  optionId
                  field {
                    ... on ProjectV2SingleSelectField {
                      name
                    }
                  }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field {
                    ... on ProjectV2FieldCommon {
                      name
                    }
                  }
                }
              }
            }
            content {
              __typename
              ... on Issue {
                id
                number
                title
                body
                url
                createdAt
                updatedAt
                labels(first: 20) {
                  nodes {
                    name
                  }
                }
                assignees(first: 20) {
                  nodes {
                    login
                  }
                }
                repository {
                  name
                  url
                  owner {
                    login
                  }
                }
                blockedBy(first: 100) {
                  nodes {
                    id
                    number
                    state
                    repository {
                      name
                      owner {
                        login
                      }
                    }
                  }
                }
                closedByPullRequestsReferences(first: 20) {
                  nodes {
                    ...PullRequestMetadata
                  }
                  pageInfo {
                    hasNextPage
                  }
                }
              }
              ... on PullRequest {
                ...PullRequestMetadata
              }
            }
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }
  }

  fragment PullRequestMetadata on PullRequest {
    id
    number
    title
    body
    url
    state
    isDraft
    merged
    headRefName
    baseRefName
    headRepository {
      name
      url
      owner {
        login
      }
    }
    repository {
      name
      url
      owner {
        login
      }
    }
    createdAt
    updatedAt
  }
`;

const PROJECT_FIELDS_QUERY = `
  query ProjectFields($projectId: ID!) {
    rateLimit {
      cost
      remaining
      resetAt
    }
    node(id: $projectId) {
      __typename
      ... on ProjectV2 {
        fields(first: 100) {
          nodes {
            __typename
            ... on ProjectV2SingleSelectField {
              id
              name
              options {
                id
                name
              }
            }
          }
        }
      }
    }
  }
`;

const EXACT_PROJECT_ITEM_STATE_QUERY = `
  query ExactProjectItemState($itemId: ID!) {
    rateLimit {
      cost
      remaining
      resetAt
    }
    node(id: $itemId) {
      __typename
      ... on ProjectV2Item {
        id
        project {
          id
        }
        content {
          ... on Issue {
            id
          }
          ... on PullRequest {
            id
          }
        }
        fieldValues(first: 20) {
          nodes {
            __typename
            ... on ProjectV2ItemFieldSingleSelectValue {
              name
              optionId
              field {
                ... on ProjectV2SingleSelectField {
                  name
                }
              }
            }
            ... on ProjectV2ItemFieldTextValue {
              text
              field {
                ... on ProjectV2FieldCommon {
                  name
                }
              }
            }
          }
        }
      }
    }
  }
`;

const UPDATE_PROJECT_ITEM_STATE_MUTATION = `
  mutation UpdateProjectItemState(
    $projectId: ID!
    $itemId: ID!
    $fieldId: ID!
    $optionId: String!
  ) {
    updateProjectV2ItemFieldValue(
      input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }
    ) {
      projectV2Item {
        id
      }
    }
  }
`;

const ISSUE_STATES_BY_IDS_QUERY = `
  query IssueStatesByIds($issueIds: [ID!]!) {
    rateLimit {
      cost
      remaining
      resetAt
    }
    nodes(ids: $issueIds) {
      __typename
      ... on Issue {
        id
        number
        url
        updatedAt
        repository {
          name
          url
          owner {
            login
          }
        }
        projectItems(first: 100, includeArchived: true) {
          nodes {
            id
            isArchived
            updatedAt
            project {
              id
            }
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  optionId
                  field {
                    ... on ProjectV2SingleSelectField {
                      name
                    }
                  }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field {
                    ... on ProjectV2FieldCommon {
                      name
                    }
                  }
                }
              }
            }
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
      ... on PullRequest {
        id
        number
        url
        updatedAt
        headRefName
        repository {
          name
          url
          owner {
            login
          }
        }
        projectItems(first: 100, includeArchived: true) {
          nodes {
            id
            isArchived
            updatedAt
            project {
              id
            }
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  optionId
                  field {
                    ... on ProjectV2SingleSelectField {
                      name
                    }
                  }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field {
                    ... on ProjectV2FieldCommon {
                      name
                    }
                  }
                }
              }
            }
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }
  }
`;

const ISSUE_PROJECT_ITEMS_PAGE_QUERY = `
  query IssueProjectItemsPage($issueId: ID!, $cursor: String) {
    rateLimit {
      cost
      remaining
      resetAt
    }
    node(id: $issueId) {
      __typename
      ... on Issue {
        id
        number
        url
        updatedAt
        repository {
          name
          url
          owner {
            login
          }
        }
        projectItems(first: 100, after: $cursor, includeArchived: true) {
          nodes {
            id
            isArchived
            updatedAt
            project {
              id
            }
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  optionId
                  field {
                    ... on ProjectV2SingleSelectField {
                      name
                    }
                  }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field {
                    ... on ProjectV2FieldCommon {
                      name
                    }
                  }
                }
              }
            }
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
      ... on PullRequest {
        id
        number
        url
        updatedAt
        headRefName
        repository {
          name
          url
          owner {
            login
          }
        }
        projectItems(first: 100, after: $cursor, includeArchived: true) {
          nodes {
            id
            isArchived
            updatedAt
            project {
              id
            }
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  optionId
                  field {
                    ... on ProjectV2SingleSelectField {
                      name
                    }
                  }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field {
                    ... on ProjectV2FieldCommon {
                      name
                    }
                  }
                }
              }
            }
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }
  }
`;

const ISSUE_COMMENTS_BY_ID_QUERY = `
  query IssueCommentsById($issueId: ID!, $cursor: String) {
    rateLimit {
      cost
      remaining
      resetAt
    }
    node(id: $issueId) {
      __typename
      ... on Issue {
        comments(first: 100, after: $cursor) {
          nodes {
            id
            databaseId
            body
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }
  }
`;

const ADD_ISSUE_COMMENT_MUTATION = `
  mutation AddIssueComment($subjectId: ID!, $body: String!) {
    addComment(input: { subjectId: $subjectId, body: $body }) {
      commentEdge {
        node {
          id
          body
        }
      }
    }
  }
`;

const UPDATE_ISSUE_COMMENT_MUTATION = `
  mutation UpdateIssueComment($commentId: ID!, $body: String!) {
    updateIssueComment(input: { id: $commentId, body: $body }) {
      issueComment {
        id
        body
      }
    }
  }
`;

const REPOSITORY_ISSUE_QUERY = `
  query RepositoryIssue(
    $owner: String!
    $name: String!
    $issueNumber: Int!
  ) {
    rateLimit {
      cost
      remaining
      resetAt
    }
    repository(owner: $owner, name: $name) {
      issue(number: $issueNumber) {
        __typename
        id
        number
        title
        body
        url
        createdAt
        updatedAt
        labels(first: 20) {
          nodes {
            name
          }
        }
        assignees(first: 20) {
          nodes {
            login
          }
        }
        repository {
          name
          url
          owner {
            login
          }
        }
        blockedBy(first: 100) {
          nodes {
            id
            number
            state
            repository {
              name
              owner {
                login
              }
            }
          }
        }
        closedByPullRequestsReferences(first: 20) {
          nodes {
            ...RepositoryIssuePullRequestMetadata
          }
          pageInfo {
            hasNextPage
          }
        }
        projectItems(first: 20, includeArchived: true) {
          nodes {
            id
            isArchived
            updatedAt
            project {
              id
            }
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  optionId
                  field {
                    ... on ProjectV2SingleSelectField {
                      name
                    }
                  }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field {
                    ... on ProjectV2FieldCommon {
                      name
                    }
                  }
                }
              }
            }
          }
          pageInfo {
            endCursor
            hasNextPage
          }
        }
      }
    }
  }

  fragment RepositoryIssuePullRequestMetadata on PullRequest {
    id
    number
    title
    body
    url
    state
    isDraft
    merged
    headRefName
    baseRefName
    headRepository {
      name
      url
      owner {
        login
      }
    }
    repository {
      name
      url
      owner {
        login
      }
    }
    labels(first: 20) {
      nodes {
        name
      }
    }
    assignees(first: 20) {
      nodes {
        login
      }
    }
    createdAt
    updatedAt
  }
`;
