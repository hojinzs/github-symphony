import {
  DEFAULT_WORKFLOW_LIFECYCLE,
  type TrackedIssue,
  type WorkflowLifecycleConfig,
} from "@gh-symphony/core";

const DEFAULT_API_URL = "https://api.github.com/graphql";
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_NETWORK_TIMEOUT_MS = 30_000;

export type GitHubTrackerConfig = {
  projectId: string;
  token: string;
  apiUrl?: string;
  lifecycle?: WorkflowLifecycleConfig;
  pageSize?: number;
  assignedOnly?: boolean;
  timeoutMs?: number;
  priorityFieldName?: string;
};

export type GitHubRepositoryRef = {
  owner: string;
  name: string;
  url: string;
  cloneUrl: string;
};

export type GitHubTrackedIssue = TrackedIssue & {
  repository: GitHubRepositoryRef;
  tracker: TrackedIssue["tracker"] & {
    adapter: "github-project";
  };
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
      name: string | null;
      options:
        | Array<{
            id: string;
            name: string;
          } | null>
        | null;
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

type GraphQLProjectItem = {
  id: string;
  updatedAt: string | null;
  fieldValues: { nodes: Array<GraphQLFieldValue | null> | null } | null;
  content: GraphQLIssueNode | null;
};

type GraphQLIssueProjectItemNode = {
  id: string;
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
  __typename: "Issue";
  id: string;
  number: number;
  updatedAt: string | null;
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

type GraphQLResponse<TData> = {
  data?: TData;
  errors?: Array<{ message: string }>;
};

type PriorityMap = Record<string, number>;

export class GitHubTrackerError extends Error {}

export class GitHubTrackerHttpError extends GitHubTrackerError {
  constructor(
    message: string,
    readonly status: number,
    readonly details: string
  ) {
    super(message);
  }
}

export class GitHubTrackerQueryError extends GitHubTrackerError {}

export function normalizeProjectItem(
  projectId: string,
  item: GraphQLProjectItem,
  lifecycle: WorkflowLifecycleConfig = DEFAULT_WORKFLOW_LIFECYCLE,
  priority: {
    fieldName?: string;
    optionIds?: PriorityMap;
  } = {}
): GitHubTrackedIssue | null {
  if (item.content?.__typename !== "Issue") {
    return null;
  }

  const fieldValues = extractFieldValues(
    item.fieldValues?.nodes ?? []
  );
  const state = fieldValues[lifecycle.stateFieldName] ?? "Unknown";
  const repository = item.content.repository;
  const blockedBy = (item.content.blockedBy?.nodes ?? []).flatMap(
    (node) =>
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
    labels: (item.content.labels?.nodes ?? [])
      .flatMap((label) => (label?.name ? [label.name.toLowerCase()] : []))
      .sort(),
    blockedBy,
    createdAt: item.content.createdAt,
    updatedAt: item.content.updatedAt ?? item.updatedAt,
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
    metadata: fieldValues,
  };
}

export async function fetchProjectIssues(
  config: GitHubTrackerConfig,
  fetchImpl: FetchLike = fetch
): Promise<GitHubTrackedIssue[]> {
  const issues: GitHubTrackedIssue[] = [];
  let cursor: string | null = null;
  const priorityOptionIds = config.priorityFieldName
    ? await fetchPriorityOptionOrder(
        config,
        config.priorityFieldName,
        fetchImpl
      )
    : undefined;
  const currentUserLogin = config.assignedOnly
    ? await fetchCurrentUserLogin(config, fetchImpl)
    : null;
  let excludedCount = 0;

  do {
    const page = await fetchProjectItemsPage(config, cursor, fetchImpl);
    const pageIssues = (page.nodes ?? [])
      .flatMap((item) => {
        if (!item) {
          return [];
        }

        const normalized = normalizeProjectItem(
          config.projectId,
          item,
          config.lifecycle,
          {
            fieldName: config.priorityFieldName,
            optionIds: priorityOptionIds,
          }
        );
        if (!normalized) {
          return [];
        }

        if (
          currentUserLogin &&
          !isIssueAssignedToLogin(item, currentUserLogin)
        ) {
          excludedCount += 1;
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

  return issues;
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
): Promise<GitHubTrackedIssue[]> {
  if (issueIds.length === 0) {
    return [];
  }

  const issues: GitHubTrackedIssue[] = [];

  for (const issueIdBatch of chunkValues([...new Set(issueIds)], 100)) {
    const data = await executeGraphQLQuery<GraphQLIssueStatesByIdsResponse>(
      config,
      ISSUE_STATES_BY_IDS_QUERY,
      {
        issueIds: issueIdBatch,
      },
      fetchImpl
    );

    for (const node of data.nodes ?? []) {
      const projectItem = await resolveIssueProjectItemForStateLookup(
        config,
        node,
        fetchImpl
      );
      const normalized = normalizeIssueStateLookupNode(
        config.projectId,
        node,
        projectItem,
        config.lifecycle
      );
      if (normalized) {
        issues.push(normalized);
      }
    }
  }

  return issues;
}

async function fetchProjectItemsPage(
  config: GitHubTrackerConfig,
  cursor: string | null,
  fetchImpl: FetchLike
) : Promise<GraphQLProjectItemsPage> {
  const data = await executeGraphQLQuery<GraphQLProjectItemsResponse>(
    config,
    PROJECT_ITEMS_QUERY,
    {
      projectId: config.projectId,
      cursor,
      pageSize: config.pageSize ?? DEFAULT_PAGE_SIZE,
    },
    fetchImpl
  );
  const items = data.node?.items;

  if (!items) {
    throw new GitHubTrackerQueryError(
      "GitHub GraphQL response did not include project items."
    );
  }

  return items;
}

export const normalizeGithubProjectItem = normalizeProjectItem;
export const fetchGithubProjectIssues = fetchProjectIssues;
export const fetchGithubIssueStatesByIds = fetchIssueStatesByIds;

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

function normalizeIssueStateLookupNode(
  projectId: string,
  issue: GraphQLIssueStateLookupNode | null,
  projectItem: GraphQLIssueProjectItemNode | null,
  lifecycle: WorkflowLifecycleConfig = DEFAULT_WORKFLOW_LIFECYCLE
): GitHubTrackedIssue | null {
  if (issue?.__typename !== "Issue") {
    return null;
  }
  if (!projectItem) {
    return null;
  }

  const fieldValues = extractFieldValues(projectItem.fieldValues?.nodes ?? []);
  const state = fieldValues[lifecycle.stateFieldName] ?? "Unknown";
  const repository = issue.repository;
  const identifier = `${repository.owner.login}/${repository.name}#${issue.number}`;

  return {
    id: issue.id,
    identifier,
    number: issue.number,
    title: identifier,
    description: null,
    priority: null,
    state,
    branchName: null,
    url: `${repository.url}/issues/${issue.number}`,
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
    metadata: fieldValues,
  };
}

async function resolveIssueProjectItemForStateLookup(
  config: GitHubTrackerConfig,
  issue: GraphQLIssueStateLookupNode | null,
  fetchImpl: FetchLike
): Promise<GraphQLIssueProjectItemNode | null> {
  if (issue?.__typename !== "Issue") {
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
  const data = await executeGraphQLQuery<GraphQLIssueProjectItemsByIdResponse>(
    config,
    ISSUE_PROJECT_ITEMS_PAGE_QUERY,
    {
      issueId,
      cursor,
    },
    fetchImpl
  );
  const issue = data.node;

  if (issue?.__typename !== "Issue" || !issue.projectItems) {
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
  priority: {
    fieldName?: string;
    optionIds?: PriorityMap;
  }
): number | null {
  if (!priority.fieldName || !priority.optionIds) {
    return null;
  }

  for (const node of item.fieldValues?.nodes ?? []) {
    if (
      node?.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
      node.field?.name === priority.fieldName &&
      node.optionId
    ) {
      return priority.optionIds[node.optionId] ?? null;
    }
  }

  return null;
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
  const parsed = new URL(apiUrl ?? DEFAULT_API_URL);
  const pathSegments = parsed.pathname.split("/").filter(Boolean);

  if (pathSegments.at(-1) === "graphql") {
    pathSegments.pop();
  }

  parsed.pathname = `/${pathSegments.join("/")}/user`.replace(/\/{2,}/g, "/");
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
  if (
    timeoutMs !== undefined &&
    Number.isInteger(timeoutMs) &&
    timeoutMs > 0
  ) {
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
    throw new GitHubTrackerHttpError(
      `GitHub GraphQL request failed with status ${response.status}`,
      response.status,
      details
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

  return payload.data;
}

const PROJECT_ITEMS_QUERY = `
  query ProjectItems($projectId: ID!, $cursor: String, $pageSize: Int!) {
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

const PROJECT_FIELDS_QUERY = `
  query ProjectFields($projectId: ID!) {
    node(id: $projectId) {
      __typename
      ... on ProjectV2 {
        fields(first: 100) {
          nodes {
            __typename
            ... on ProjectV2SingleSelectField {
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

const ISSUE_STATES_BY_IDS_QUERY = `
  query IssueStatesByIds($issueIds: [ID!]) {
    nodes(ids: $issueIds) {
      __typename
      ... on Issue {
        id
        number
        updatedAt
        repository {
          name
          url
          owner {
            login
          }
        }
        projectItems(first: 100, includeArchived: false) {
          nodes {
            id
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
    node(id: $issueId) {
      __typename
      ... on Issue {
        id
        number
        updatedAt
        repository {
          name
          url
          owner {
            login
          }
        }
        projectItems(first: 100, after: $cursor, includeArchived: false) {
          nodes {
            id
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
