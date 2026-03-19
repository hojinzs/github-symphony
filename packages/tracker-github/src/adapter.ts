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
      field: { name: string | null } | null;
    }
  | {
      __typename: "ProjectV2ItemFieldTextValue";
      text: string | null;
      field: { name: string | null } | null;
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

type GraphQLProjectItemsPage = {
  nodes: Array<GraphQLProjectItem | null> | null;
  pageInfo: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
};

type GraphQLResponse = {
  data?: {
    node?: {
      __typename?: string;
      items?: GraphQLProjectItemsPage;
    } | null;
  };
  errors?: Array<{ message: string }>;
};

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
  lifecycle: WorkflowLifecycleConfig = DEFAULT_WORKFLOW_LIFECYCLE
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
    priority: null,
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
          config.lifecycle
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

async function fetchProjectItemsPage(
  config: GitHubTrackerConfig,
  cursor: string | null,
  fetchImpl: FetchLike
): Promise<GraphQLProjectItemsPage> {
  const response = await fetchImpl(config.apiUrl ?? DEFAULT_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify({
      query: PROJECT_ITEMS_QUERY,
      variables: {
        projectId: config.projectId,
        cursor,
        pageSize: config.pageSize ?? DEFAULT_PAGE_SIZE,
      },
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

  const payload = (await response.json()) as GraphQLResponse;

  if (payload.errors?.length) {
    throw new GitHubTrackerQueryError(
      payload.errors.map((error) => error.message).join("; ")
    );
  }

  const items = payload.data?.node?.items;

  if (!items) {
    throw new GitHubTrackerQueryError(
      "GitHub GraphQL response did not include project items."
    );
  }

  return items;
}

export const normalizeGithubProjectItem = normalizeProjectItem;
export const fetchGithubProjectIssues = fetchProjectIssues;

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
