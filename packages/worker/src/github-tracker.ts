import {
  DEFAULT_WORKFLOW_LIFECYCLE,
  isWorkflowPhaseActionable,
  resolveWorkflowExecutionPhase,
  type WorkflowExecutionPhase,
  type WorkflowLifecycleConfig
} from "./workflow-lifecycle.js";

const DEFAULT_API_URL = "https://api.github.com/graphql";
const DEFAULT_PAGE_SIZE = 25;

export type GitHubTrackerConfig = {
  projectId: string;
  token: string;
  apiUrl?: string;
  activeStates?: string[];
  lifecycle?: WorkflowLifecycleConfig;
  pageSize?: number;
};

export type GitHubRepositoryRef = {
  owner: string;
  name: string;
  url: string;
  cloneUrl: string;
};

export type GitHubTrackedIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: [];
  createdAt: string | null;
  updatedAt: string | null;
  repository: GitHubRepositoryRef;
  projectId: string;
  projectItemId: string;
  fieldValues: Record<string, string>;
  phase: WorkflowExecutionPhase;
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
  repository: {
    name: string;
    url: string;
    owner: { login: string };
  };
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

export function normalizeStateName(state: string): string {
  return state.trim().toLowerCase();
}

export function isActionableState(state: string, activeStates: string[]): boolean {
  return activeStates.map(normalizeStateName).includes(normalizeStateName(state));
}

export function normalizeProjectItem(
  projectId: string,
  item: GraphQLProjectItem,
  lifecycle: WorkflowLifecycleConfig = DEFAULT_WORKFLOW_LIFECYCLE
): GitHubTrackedIssue | null {
  if (item.content?.__typename !== "Issue") {
    return null;
  }

  const fieldValues = extractFieldValues(item.fieldValues?.nodes ?? []);
  const state = fieldValues[lifecycle.stateFieldName] ?? "Unknown";
  const repository = item.content.repository;

  return {
    id: item.content.id,
    identifier: `${repository.owner.login}/${repository.name}#${item.content.number}`,
    title: item.content.title,
    description: item.content.body,
    priority: null,
    state,
    branchName: null,
    url: item.content.url,
    labels: (item.content.labels?.nodes ?? [])
      .flatMap((label) => (label?.name ? [label.name.toLowerCase()] : []))
      .sort(),
    blockedBy: [],
    createdAt: item.content.createdAt,
    updatedAt: item.content.updatedAt ?? item.updatedAt,
    repository: {
      owner: repository.owner.login,
      name: repository.name,
      url: repository.url,
      cloneUrl: `${repository.url}.git`
    },
    projectId,
    projectItemId: item.id,
    fieldValues,
    phase: resolveWorkflowExecutionPhase(state, lifecycle)
  };
}

export async function fetchActionableIssues(
  config: GitHubTrackerConfig,
  fetchImpl: FetchLike = fetch
): Promise<GitHubTrackedIssue[]> {
  const issues: GitHubTrackedIssue[] = [];
  let cursor: string | null = null;

  do {
    const page = await fetchProjectItemsPage(config, cursor, fetchImpl);
    const pageIssues = (page.nodes ?? [])
      .flatMap((item) =>
        item ? [normalizeProjectItem(config.projectId, item, config.lifecycle)] : []
      )
      .flatMap((issue) => (issue ? [issue] : []))
      .filter((issue) => isTrackedIssueActionable(issue, config));

    issues.push(...pageIssues);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  return issues;
}

export function isTrackedIssueActionable(
  issue: Pick<GitHubTrackedIssue, "state" | "phase">,
  config: Pick<GitHubTrackerConfig, "activeStates" | "lifecycle">
): boolean {
  if (config.lifecycle) {
    return isWorkflowPhaseActionable(issue.phase);
  }

  return isActionableState(issue.state, config.activeStates ?? []);
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
      authorization: `Bearer ${config.token}`
    },
    body: JSON.stringify({
      query: PROJECT_ITEMS_QUERY,
      variables: {
        projectId: config.projectId,
        cursor,
        pageSize: config.pageSize ?? DEFAULT_PAGE_SIZE
      }
    })
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
    throw new GitHubTrackerQueryError("GitHub GraphQL response did not include project items.");
  }

  return items;
}

function extractFieldValues(nodes: Array<GraphQLFieldValue | null>): Record<string, string> {
  return nodes.reduce<Record<string, string>>((values, node) => {
    const fieldName = node?.field?.name;

    if (!fieldName) {
      return values;
    }

    if (node.__typename === "ProjectV2ItemFieldSingleSelectValue" && node.name) {
      values[fieldName] = node.name;
    }

    if (node.__typename === "ProjectV2ItemFieldTextValue" && node.text) {
      values[fieldName] = node.text;
    }

    return values;
  }, {});
}

const PROJECT_ITEMS_QUERY = `
  query GitHubSymphonyProjectItems($projectId: ID!, $cursor: String, $pageSize: Int!) {
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
                repository {
                  name
                  url
                  owner {
                    login
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
