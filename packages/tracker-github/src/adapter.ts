import { createHash } from "node:crypto";
import {
  DEFAULT_WORKFLOW_LIFECYCLE,
  type IssueCommentCache,
  type IssueCommentCacheEntry,
  type TrackedIssue,
  type TrackedIssueList,
  type TrackerStateRequest,
  type TrackerStateResult,
  type TrackerCommentWriteResult,
  type TrackerIssueCommentUpsertResult,
  type WorkflowPriorityConfig,
  type WorkflowLifecycleConfig,
} from "@gh-symphony/core";
import {
  extractGitHubRateLimits,
  extractGraphQLRateLimitField,
  fingerprintGitHubToken,
  githubGraphQLRateLimitPolicy,
  isGitHubRateLimitResponse,
  parseGitHubRetryAfterMs,
  type GitHubRateLimitPayload,
  type GraphQLRateLimitField,
  type GitHubGraphQLAttemptResult,
} from "@gh-symphony/tool-github-graphql";

const DEFAULT_API_URL = "https://api.github.com/graphql";
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_NETWORK_TIMEOUT_MS = 30_000;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
const MAX_TRANSITION_QUEUE_DEPTH = 100;
const TRANSITION_RETRY_ATTEMPTS = 3;
const TRANSITION_RETRY_BASE_MS = 25;

export type GitHubTrackerConfig = {
  projectId: string;
  token: string;
  apiUrl?: string;
  lifecycle?: WorkflowLifecycleConfig;
  filterTerminalStates?: boolean;
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

const cachedProjectFields = new Map<
  string,
  Promise<Array<GraphQLProjectFieldConfiguration | null>>
>();

type ProjectStatusFieldMetadata = {
  fieldId: string;
  options: Array<{ id: string; name: string }>;
};

const cachedProjectStatusFields = new Map<
  string,
  Promise<ProjectStatusFieldMetadata>
>();

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
  state?: string | null;
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
  totalCount?: number;
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
    unfilteredItems?: {
      totalCount?: number;
    };
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
  content: {
    id: string;
    number: number;
    repository: {
      name: string;
      owner: { login: string };
    };
  } | null;
  fieldValueByName: GraphQLFieldValue | null;
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

type GitHubRateLimitObservation = {
  operationName: string;
  cost: number;
  payload: GitHubRateLimitPayload;
};

type GitHubRateLimitCollector = {
  observations: GitHubRateLimitObservation[];
  lastUsed: number | null;
};

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
  const issueIdentifier = projectItemIssueIdentifier(item);
  const stateFieldName = lifecycle.stateFieldName?.trim() ?? "";
  if (!stateFieldName && !isArchived) {
    throw new GitHubTrackerQueryError(
      `github_project_state_field_unconfigured: Project item ${item.id} cannot be normalized without lifecycle.stateFieldName.`
    );
  }
  if (getMissingStateSkippedItem(item, lifecycle)) {
    emitProjectItemStatusMissingEvent({
      projectId,
      itemId: item.id,
      issueIdentifier,
    });
    return null;
  }
  const state = isArchived
    ? ARCHIVED_PROJECT_ITEM_STATE
    : requireProjectItemState(fieldValues, lifecycle, item.id, issueIdentifier);

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
      item.content.state ?? null,
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
  const stateFilterQuery =
    config.filterTerminalStates === false
      ? null
      : buildTerminalStatesQuery(config.lifecycle);
  const issues: GitHubTrackedIssue[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  let unfilteredCount: number | null = null;
  let filteredCount: number | null = null;
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
  const skippedItems: NonNullable<TrackedIssueList["skippedItems"]> = [];

  do {
    const pageResult = await fetchProjectItemsPage(
      cycleConfig,
      cursor,
      stateFilterQuery,
      fetchImpl
    );
    pageCount += 1;
    const page = pageResult.page;
    unfilteredCount = pageResult.unfilteredCount ?? unfilteredCount;
    filteredCount = page.totalCount ?? filteredCount;
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
        const skippedItem = getMissingStateSkippedItem(
          item,
          config.lifecycle ?? DEFAULT_WORKFLOW_LIFECYCLE
        );
        if (skippedItem) {
          skippedItems.push(skippedItem);
        }
        return [];
      }

      return [normalized];
    });

    issues.push(...pageIssues);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  if (stateFilterQuery && unfilteredCount !== null && filteredCount !== null) {
    emitProjectItemsStateFilterEvent({
      projectId: config.projectId,
      query: stateFilterQuery,
      unfilteredCount,
      filteredCount,
      pageCount,
    });
  }

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
  (issues as TrackedIssueList).skippedItems = skippedItems;

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
  // Rate-limit budget is shared by all projects using this token.
  const queueKey = fingerprintGitHubToken(config.token);
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
      rateLimits: githubGraphQLRateLimitPolicy.get(
        fingerprintGitHubToken(config.token)
      ),
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

export async function upsertGithubTransitionComment(
  config: GitHubTrackerConfig,
  input: {
    issueSubjectId: string;
    body: string;
  },
  fetchImpl: FetchLike = fetch
): Promise<TrackerCommentWriteResult> {
  const queueKey = fingerprintGitHubToken(config.token);
  const depth = transitionQueueDepths.get(queueKey) ?? 0;
  if (depth >= MAX_TRANSITION_QUEUE_DEPTH) {
    throw new GitHubTrackerQueryError("tracker_transition_queue_full");
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
    return await executeGithubTransitionComment(config, input, fetchImpl);
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

async function executeGithubTransitionComment(
  config: GitHubTrackerConfig,
  input: { issueSubjectId: string; body: string },
  fetchImpl: FetchLike
): Promise<TrackerCommentWriteResult> {
  const cycleConfig = beginGraphQLRateLimitCycle(config);
  const finalizeRateLimits = () =>
    finalizeGraphQLRateLimitCycle(null, cycleConfig.rateLimitCollector);
  try {
    const existing = await findIssueCommentByExactBody(
      cycleConfig,
      input.issueSubjectId,
      input.body,
      fetchImpl
    );
    if (existing) {
      return { outcome: "unchanged", rateLimits: finalizeRateLimits() };
    }

    for (let attempt = 0; attempt < TRANSITION_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const result =
          await executeGraphQLQueryWithMetadata<GraphQLAddIssueCommentResponse>(
            cycleConfig,
            ADD_ISSUE_COMMENT_MUTATION,
            {
              subjectId: input.issueSubjectId,
              body: input.body,
            },
            fetchImpl
          );
        if (!result.data.addComment?.commentEdge?.node) {
          throw new GitHubTrackerQueryError(
            "tracker_transition_comment_mutation_unconfirmed"
          );
        }
        return { outcome: "created", rateLimits: finalizeRateLimits() };
      } catch (error) {
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
        const discovered = await findIssueCommentByExactBody(
          cycleConfig,
          input.issueSubjectId,
          input.body,
          fetchImpl
        );
        if (discovered) {
          return { outcome: "unchanged", rateLimits: finalizeRateLimits() };
        }
      }
    }

    throw new GitHubTrackerQueryError("tracker_transition_comment_failed");
  } catch (error) {
    const rateLimits = finalizeRateLimits();
    if (
      error instanceof GitHubTrackerError &&
      error.rateLimits === null &&
      rateLimits !== null
    ) {
      Object.assign(error, { rateLimits });
    }
    throw error;
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

  let statusField = await resolveStatusFieldConfiguration(
    cycleConfig,
    input.request.targetState,
    fetchImpl
  );
  let mutation;
  try {
    mutation = await executeTransitionMutationWithRetry(
      cycleConfig,
      {
        itemId: input.itemId,
        fieldId: statusField.fieldId,
        optionId: statusField.optionId,
      },
      fetchImpl
    );
  } catch (error) {
    if (!isStaleStatusFieldMetadataError(error)) {
      throw error;
    }
    invalidateProjectStatusFieldMetadata(cycleConfig);
    statusField = await resolveStatusFieldConfiguration(
      cycleConfig,
      input.request.targetState,
      fetchImpl,
      { forceRefresh: true }
    );
    mutation = await executeTransitionMutationWithRetry(
      cycleConfig,
      {
        itemId: input.itemId,
        fieldId: statusField.fieldId,
        optionId: statusField.optionId,
      },
      fetchImpl
    );
  }
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
      {
        itemId: input.itemId,
        stateFieldName: (
          config.lifecycle?.stateFieldName ??
          DEFAULT_WORKFLOW_LIFECYCLE.stateFieldName
        ).trim(),
      },
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
      extractFieldValues([exactNode.fieldValueByName]),
      config.lifecycle ?? DEFAULT_WORKFLOW_LIFECYCLE,
      input.itemId,
      exactProjectItemIssueIdentifier(exactNode.content)
    ),
    rateLimits: result.rateLimits,
  };
}

async function resolveStatusFieldConfiguration(
  config: GitHubTrackerConfig,
  targetState: string,
  fetchImpl: FetchLike,
  options: { forceRefresh?: boolean } = {}
): Promise<{
  fieldId: string;
  optionId: string;
}> {
  const fieldName =
    config.lifecycle?.stateFieldName ??
    DEFAULT_WORKFLOW_LIFECYCLE.stateFieldName;
  const resolved = await getProjectStatusFieldMetadata(
    config,
    fieldName,
    fetchImpl,
    options.forceRefresh === true
  );
  const option = resolved.metadata.options.find(
    (candidate) => candidate && statesEqual(candidate.name, targetState)
  );
  if (!option?.id) {
    if (!options.forceRefresh) {
      invalidateProjectStatusFieldMetadata(config, fieldName);
      return resolveStatusFieldConfiguration(config, targetState, fetchImpl, {
        forceRefresh: true,
      });
    }
    throw new GitHubTrackerQueryError(
      `tracker_target_state_not_found: ${targetState}`
    );
  }
  return {
    fieldId: resolved.metadata.fieldId,
    optionId: option.id,
  };
}

async function getProjectStatusFieldMetadata(
  config: GitHubTrackerConfig,
  fieldName: string,
  fetchImpl: FetchLike,
  forceRefresh: boolean
): Promise<{
  metadata: ProjectStatusFieldMetadata;
}> {
  const cacheKey = projectStatusFieldCacheKey(config, fieldName);
  if (forceRefresh) {
    cachedProjectStatusFields.delete(cacheKey);
  }
  let pending = cachedProjectStatusFields.get(cacheKey);
  if (!pending) {
    pending = executeGraphQLQueryWithMetadata<GraphQLProjectFieldsResponse>(
      config,
      PROJECT_FIELDS_QUERY,
      { projectId: config.projectId },
      fetchImpl
    ).then((result) => {
      const field = (result.data.node?.fields?.nodes ?? [])
        .filter(isSingleSelectProjectField)
        .find((candidate) => candidate.name === fieldName);
      if (!field?.id) {
        throw new GitHubTrackerQueryError(
          `tracker_status_field_not_found: ${fieldName}`
        );
      }
      return {
        fieldId: field.id,
        options: (field.options ?? []).flatMap((option) =>
          option?.id && option.name ? [option] : []
        ),
      };
    });
    cachedProjectStatusFields.set(cacheKey, pending);
  }
  try {
    return {
      metadata: await pending,
    };
  } catch (error) {
    if (cachedProjectStatusFields.get(cacheKey) === pending) {
      cachedProjectStatusFields.delete(cacheKey);
    }
    throw error;
  }
}

function projectStatusFieldCacheKey(
  config: GitHubTrackerConfig,
  fieldName?: string
): string {
  return JSON.stringify({
    apiUrl: config.apiUrl ?? DEFAULT_API_URL,
    projectId: config.projectId,
    stateFieldName:
      fieldName ??
      config.lifecycle?.stateFieldName ??
      DEFAULT_WORKFLOW_LIFECYCLE.stateFieldName,
    tokenFingerprint: fingerprintGitHubToken(config.token),
  });
}

function invalidateProjectStatusFieldMetadata(
  config: GitHubTrackerConfig,
  fieldName?: string
): void {
  cachedProjectStatusFields.delete(
    projectStatusFieldCacheKey(config, fieldName)
  );
}

function isStaleStatusFieldMetadataError(error: unknown): boolean {
  // GitHub does not provide a structured stale-ID code for this mutation.
  // Unknown errors fail normally rather than risking an extra mutation retry.
  return (
    error instanceof GitHubTrackerQueryError &&
    /(?:field|option|single.?select).*(?:invalid|not found|does not belong)|(?:invalid|not found|does not belong).*(?:field|option|single.?select)|could not resolve to a node with the global id/i.test(
      error.message
    )
  );
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
  return false;
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
  query: string | null,
  fetchImpl: FetchLike
): Promise<{
  page: GraphQLProjectItemsPage;
  rateLimits: GitHubRateLimitPayload | null;
  unfilteredCount: number | null;
}> {
  const result =
    await executeGraphQLQueryWithMetadata<GraphQLProjectItemsResponse>(
      config,
      PROJECT_ITEMS_QUERY,
      {
        projectId: config.projectId,
        cursor,
        pageSize: config.pageSize ?? DEFAULT_PAGE_SIZE,
        query,
        includeUnfilteredCount: cursor === null && query !== null,
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
    unfilteredCount: data.node?.unfilteredItems?.totalCount ?? null,
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
): Promise<TrackerIssueCommentUpsertResult> {
  const cycleConfig = beginGraphQLRateLimitCycle(config);
  const result = cache
    ? await upsertIssueCommentWithCache(
        cycleConfig,
        issue,
        input,
        fetchImpl,
        cache
      )
    : await upsertIssueCommentWithoutCache(
        cycleConfig,
        issue,
        input,
        fetchImpl
      );
  return {
    outcome: result,
    rateLimits: finalizeGraphQLRateLimitCycle(
      null,
      cycleConfig.rateLimitCollector
    ),
  };
}

async function upsertIssueCommentWithoutCache(
  config: GitHubTrackerConfig,
  issue: Pick<TrackedIssue, "id" | "number" | "repository">,
  input: {
    marker: string;
    body: string;
  },
  fetchImpl: FetchLike
): Promise<"created" | "updated" | "unchanged"> {
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
      if (current.entry.body === input.body) {
        await cache.set(cacheKey, current.entry);
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

  if (current.entry.body === input.body) {
    await cache.set(cacheKey, current.entry);
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

async function findIssueCommentByExactBody(
  config: GitHubTrackerConfig,
  issueId: string,
  body: string,
  fetchImpl: FetchLike
): Promise<GraphQLIssueCommentNode | null> {
  let cursor: string | null = null;

  while (true) {
    const data: GraphQLIssueCommentsByIdResponse =
      await executeGraphQLQuery<GraphQLIssueCommentsByIdResponse>(
        config,
        ISSUE_COMMENTS_BY_ID_QUERY,
        { issueId, cursor },
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
        (comment: GraphQLIssueCommentNode | null) => comment?.body === body
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

function emitProjectItemsStateFilterEvent(input: {
  projectId: string;
  query: string;
  unfilteredCount: number;
  filteredCount: number;
  pageCount: number;
}): void {
  console.info(
    JSON.stringify({
      event: "tracker-project-items-state-filtered",
      projectId: input.projectId,
      query: input.query,
      unfilteredCount: input.unfilteredCount,
      filteredCount: input.filteredCount,
      excludedCount: input.unfilteredCount - input.filteredCount,
      pageCount: input.pageCount,
    })
  );
}

function buildTerminalStatesQuery(
  lifecycle: WorkflowLifecycleConfig | undefined
): string | null {
  if (!lifecycle) {
    return null;
  }

  if (lifecycle.stateFieldName.trim().toLowerCase() !== "status") {
    return null;
  }

  const activeStates = new Set(
    lifecycle.activeStates.map((state) => state.trim().toLowerCase())
  );
  const terminalStates = new Map<string, string>();
  for (const state of lifecycle.terminalStates) {
    const trimmedState = state.trim();
    if (!trimmedState) {
      continue;
    }

    const normalizedState = trimmedState.toLowerCase();
    if (activeStates.has(normalizedState)) {
      throw new GitHubTrackerQueryError(
        `Workflow state "${trimmedState}" cannot be both active and terminal.`
      );
    }
    if (!terminalStates.has(normalizedState)) {
      terminalStates.set(normalizedState, trimmedState);
    }
  }

  if (terminalStates.size === 0) {
    return null;
  }

  return `-status:${[...terminalStates.values()]
    .map(formatProjectQueryValue)
    .join(",")}`;
}

function formatProjectQueryValue(value: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(value)) {
    return value;
  }

  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
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
  itemId: string,
  issueIdentifier?: string
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
      `github_project_state_field_missing: Project item ${itemId} did not include configured state field "${stateFieldName}".` +
        (issueIdentifier ? ` Issue: ${issueIdentifier}.` : "")
    );
  }

  return state;
}

function hasProjectItemState(
  fieldValues: Record<string, string>,
  lifecycle: WorkflowLifecycleConfig
): boolean {
  const stateFieldName = lifecycle.stateFieldName?.trim() ?? "";
  return Boolean(stateFieldName && fieldValues[stateFieldName]);
}

function getMissingStateSkippedItem(
  item: GraphQLProjectItem,
  lifecycle: WorkflowLifecycleConfig
): NonNullable<TrackedIssueList["skippedItems"]>[number] | null {
  if (
    item.isArchived === true ||
    (item.content?.__typename !== "Issue" &&
      item.content?.__typename !== "PullRequest")
  ) {
    return null;
  }

  const fieldValues = extractFieldValues(item.fieldValues?.nodes ?? []);
  if (hasProjectItemState(fieldValues, lifecycle)) {
    return null;
  }

  return {
    id: item.id,
    identifier: projectItemIssueIdentifier(item),
    reason: `missing ${lifecycle.stateFieldName?.trim() || "configured state"}`,
  };
}

function projectItemIssueIdentifier(item: GraphQLProjectItem): string {
  const content = item.content;
  if (!content) {
    return item.id;
  }

  const repository = content.repository;
  return `${repository.owner.login}/${repository.name}#${content.number}`;
}

function emitProjectItemStatusMissingEvent(input: {
  projectId: string;
  itemId: string;
  issueIdentifier: string;
}): void {
  console.warn(
    JSON.stringify({ event: "tracker-project-item-status-missing", ...input })
  );
}

function exactProjectItemIssueIdentifier(
  content: GraphQLExactProjectItemNode["content"]
): string | undefined {
  if (!content?.repository?.owner?.login || !content.repository.name) {
    return undefined;
  }

  return `${content.repository.owner.login}/${content.repository.name}#${content.number}`;
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
  const repository = issue.repository;
  const identifier = `${repository.owner.login}/${repository.name}#${issue.number}`;
  const state = isArchived
    ? ARCHIVED_PROJECT_ITEM_STATE
    : requireProjectItemState(
        fieldValues,
        lifecycle,
        projectItem.id,
        identifier
      );
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
  sourceState: string | null,
  linkedPullRequests: GitHubPullRequestMetadata[],
  linkedPullRequestsTruncated = false,
  isArchived = false
): TrackedIssue["metadata"] {
  if (
    linkedPullRequests.length === 0 &&
    !linkedPullRequestsTruncated &&
    !isArchived
  ) {
    return sourceState === null
      ? fieldValues
      : withGitHubMetadata(fieldValues, { sourceState });
  }

  return withGitHubMetadata(fieldValues, {
    sourceState,
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
  const cacheKey = JSON.stringify({
    apiUrl: config.apiUrl ?? DEFAULT_API_URL,
    projectId: config.projectId,
  });
  let pending = cachedProjectFields.get(cacheKey);
  if (!pending) {
    pending = executeGraphQLQuery<GraphQLProjectFieldsResponse>(
      config,
      PROJECT_FIELDS_QUERY,
      { projectId: config.projectId },
      fetchImpl
    ).then((data) => data.node?.fields?.nodes ?? []);
    cachedProjectFields.set(cacheKey, pending);
  }

  try {
    return extractPriorityOptionOrder(await pending, priorityFieldName);
  } catch (error) {
    if (cachedProjectFields.get(cacheKey) === pending) {
      cachedProjectFields.delete(cacheKey);
    }
    throw error;
  }
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
    if (pathSegments.at(-1) === "api") {
      pathSegments.push("v3");
    }
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
  variables: Record<string, string | number | boolean | string[] | null>,
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
  variables: Record<string, string | number | boolean | string[] | null>,
  fetchImpl: FetchLike
): Promise<{
  data: TData;
  rateLimits: GitHubRateLimitPayload | null;
}> {
  const tokenFingerprint = fingerprintGitHubToken(config.token);
  const requestResult = await githubGraphQLRateLimitPolicy.execute(
    tokenFingerprint,
    async (): Promise<
      GitHubGraphQLAttemptResult<
        {
          response: Response;
          payload: GraphQLResponse<TData>;
        },
        GitHubRateLimitPayload
      >
    > => {
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
      const rateLimits = extractGitHubRateLimits(response.headers);
      if (!response.ok) {
        const details = await response.text();
        return {
          ok: false,
          status: response.status,
          details,
          rateLimits,
          retryAfterMs: parseGitHubRetryAfterMs(
            response.headers?.get?.("retry-after") ?? null
          ),
          rateLimited: isGitHubRateLimitResponse(
            response.status,
            details,
            response.headers
          ),
        };
      }

      const payload = (await response.json()) as GraphQLResponse<TData>;
      const fieldRateLimits = extractGraphQLRateLimitField(
        payload.data?.rateLimit
      );
      return {
        ok: true,
        value: { response, payload },
        rateLimits: extractGitHubRateLimits(response.headers, fieldRateLimits),
      };
    }
  );

  if (!requestResult.ok) {
    throw new GitHubTrackerHttpError(
      `GitHub GraphQL request failed with status ${requestResult.status}`,
      requestResult.status,
      requestResult.details,
      requestResult.rateLimits,
      requestResult.retryAfterMs
    );
  }

  const { payload, response } = requestResult.value;

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
  const cost =
    fieldRateLimits?.cost ??
    inferGraphQLHeaderCost(config.rateLimitCollector, rateLimits);
  if (rateLimits && cost !== null) {
    config.rateLimitCollector?.observations.push({
      operationName: extractGraphQLOperationName(query),
      cost,
      payload: rateLimits,
    });
  }
  if (rateLimits && config.rateLimitCollector) {
    config.rateLimitCollector.lastUsed = rateLimits.used;
  }
  return {
    data,
    rateLimits,
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
      lastUsed: null,
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
      cost: previous.cost + observation.cost,
    };
    cycleCost += observation.cost;
  }

  return {
    ...observations.at(-1)!.payload,
    cycleCost,
    queryCosts,
  };
}

function inferGraphQLHeaderCost(
  collector: GitHubRateLimitCollector | undefined,
  rateLimits: GitHubRateLimitPayload | null
): number | null {
  if (
    !collector ||
    !rateLimits ||
    rateLimits.used === null ||
    collector.lastUsed === null
  ) {
    return null;
  }

  // Header deltas are token-scoped, so concurrent requests can over-attribute cost.
  const cost = rateLimits.used - collector.lastUsed;
  return cost >= 0 ? cost : null;
}

function parseTimestampMs(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function resetGitHubRateLimitCacheForTests(): void {
  githubGraphQLRateLimitPolicy.reset();
  transitionQueueTails.clear();
  transitionQueueDepths.clear();
  cachedProjectStatusFields.clear();
}

export function resetPriorityOptionOrderCacheForTests(): void {
  cachedProjectFields.clear();
  cachedProjectStatusFields.clear();
}

const PROJECT_ITEMS_QUERY = `
  query ProjectItems(
    $projectId: ID!
    $cursor: String
    $pageSize: Int!
    $query: String
    $includeUnfilteredCount: Boolean!
  ) {
    rateLimit {
      cost
      remaining
      resetAt
    }
    node(id: $projectId) {
      __typename
      ... on ProjectV2 {
        unfilteredItems: items(first: 1) @include(if: $includeUnfilteredCount) {
          totalCount
        }
        items(first: $pageSize, after: $cursor, query: $query) {
          totalCount
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
                state
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
  query ExactProjectItemState($itemId: ID!, $stateFieldName: String!) {
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
            number
            repository {
              name
              owner {
                login
              }
            }
          }
          ... on PullRequest {
            id
            number
            repository {
              name
              owner {
                login
              }
            }
          }
        }
        fieldValueByName(name: $stateFieldName) {
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
