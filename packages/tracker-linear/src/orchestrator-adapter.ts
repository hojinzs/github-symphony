import {
  DEFAULT_LINEAR_GRAPHQL_URL as CORE_DEFAULT_LINEAR_GRAPHQL_URL,
  type OrchestratorProjectConfig,
  type OrchestratorRunRecord,
  type OrchestratorTrackerAdapter,
  type OrchestratorTrackerConfig,
  type OrchestratorTrackerDependencies,
  type TrackedIssue,
} from "@gh-symphony/core";

export const DEFAULT_LINEAR_GRAPHQL_URL = CORE_DEFAULT_LINEAR_GRAPHQL_URL;
const DEFAULT_PAGE_SIZE = 50;
const LINEAR_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

type LinearGraphqlClient = <TData>(
  query: string,
  variables: Record<string, unknown>
) => Promise<TData>;

type LinearConnection<TNode> = {
  nodes?: TNode[] | null;
  pageInfo?: {
    hasNextPage?: boolean | null;
    endCursor?: string | null;
  } | null;
};

type LinearIssueNode = {
  id?: string | null;
  identifier?: string | null;
  number?: number | null;
  title?: string | null;
  description?: string | null;
  priority?: number | null;
  url?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  state?: {
    name?: string | null;
  } | null;
  labels?: LinearConnection<{
    name?: string | null;
  }> | null;
  relations?: LinearConnection<{
    type?: string | null;
    relatedIssue?: {
      id?: string | null;
      identifier?: string | null;
      state?: {
        name?: string | null;
      } | null;
    } | null;
  }> | null;
};

type LinearIssuesResponse = {
  issues?: LinearConnection<LinearIssueNode> | null;
};

const LINEAR_ISSUE_FIELDS = /* GraphQL */ `
  nodes {
    id
    identifier
    number
    title
    description
    priority
    url
    createdAt
    updatedAt
    state {
      name
    }
    labels {
      nodes {
        name
      }
    }
    relations {
      nodes {
        type
        relatedIssue {
          id
          identifier
          state {
            name
          }
        }
      }
    }
  }
  pageInfo {
    hasNextPage
    endCursor
  }
`;

const LINEAR_ISSUES_BY_STATES_QUERY = /* GraphQL */ `
  query SymphonyLinearIssues(
    $projectSlug: String!
    $stateNames: [String!]!
    $first: Int!
    $after: String
  ) {
    issues(
      first: $first
      after: $after
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $stateNames } }
      }
    ) {
      ${LINEAR_ISSUE_FIELDS}
    }
  }
`;

const LINEAR_ISSUES_BY_IDS_QUERY = /* GraphQL */ `
  query SymphonyLinearIssueStates(
    $projectSlug: String!
    $issueIds: [ID!]!
    $first: Int!
    $after: String
  ) {
    issues(
      first: $first
      after: $after
      filter: {
        project: { slugId: { eq: $projectSlug } }
        id: { in: $issueIds }
      }
    ) {
      ${LINEAR_ISSUE_FIELDS}
    }
  }
`;

export const linearTrackerAdapter: OrchestratorTrackerAdapter = {
  async listIssues(project, dependencies = {}) {
    return listLinearIssues(
      project,
      project.tracker.settings?.activeStates,
      dependencies
    );
  },

  async listIssuesByStates(project, states, dependencies = {}) {
    if (states.length === 0) {
      return [];
    }

    return listLinearIssues(project, states, dependencies);
  },

  async fetchIssueStatesByIds(project, issueIds, dependencies = {}) {
    if (issueIds.length === 0) {
      return [];
    }

    return listLinearIssues(project, undefined, dependencies, issueIds);
  },

  buildWorkerEnvironment(project, issue) {
    return {
      LINEAR_GRAPHQL_URL: resolveLinearEndpoint(project.tracker),
      LINEAR_ISSUE_ID: issue.id,
      LINEAR_ISSUE_IDENTIFIER: issue.identifier,
      SYMPHONY_TRACKER_KIND: "linear",
    };
  },

  reviveIssue(project, run: OrchestratorRunRecord): TrackedIssue {
    const revivedIdentifier = reviveLinearIdentifier(run.issueIdentifier);

    return {
      id: run.issueId,
      identifier: revivedIdentifier,
      number: parseLinearIssueNumberOrZero(revivedIdentifier),
      title: run.issueTitle ?? run.issueIdentifier,
      description: null,
      priority: null,
      state: run.issueState,
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
      repository: project.repository,
      tracker: {
        adapter: "linear",
        bindingId: project.tracker.bindingId,
        itemId: run.issueId,
      },
      metadata: {},
    };
  },
};

async function listLinearIssues(
  project: OrchestratorProjectConfig,
  stateNamesInput: unknown,
  dependencies: OrchestratorTrackerDependencies,
  issueIds?: readonly string[]
): Promise<TrackedIssue[]> {
  const config = resolveLinearTrackerConfig(project, dependencies);
  const client = createLinearGraphqlClient(config, dependencies.fetchImpl);
  const stateNames = readStringArray(stateNamesInput);
  if (!issueIds && (!stateNames || stateNames.length === 0)) {
    throw new Error(
      'Tracker adapter "linear" requires at least one active state name in the "activeStates" setting.'
    );
  }
  const nodes = await fetchPaginatedLinearIssues(client, {
    projectSlug: config.projectSlug,
    stateNames,
    issueIds: issueIds ? [...issueIds] : undefined,
    pageSize: config.pageSize,
  });

  return nodes.map((node) =>
    normalizeLinearIssue(project, config.projectSlug, node)
  );
}

async function fetchPaginatedLinearIssues(
  client: LinearGraphqlClient,
  input: {
    projectSlug: string;
    stateNames?: string[];
    issueIds?: string[];
    pageSize: number;
  }
): Promise<LinearIssueNode[]> {
  const issues: LinearIssueNode[] = [];
  let after: string | null = null;

  do {
    const query = input.issueIds
      ? LINEAR_ISSUES_BY_IDS_QUERY
      : LINEAR_ISSUES_BY_STATES_QUERY;
    const response: LinearIssuesResponse = await client<LinearIssuesResponse>(
      query,
      {
        projectSlug: input.projectSlug,
        ...(input.issueIds
          ? { issueIds: input.issueIds }
          : { stateNames: input.stateNames ?? [] }),
        first: input.pageSize,
        after,
      }
    );
    const connection: LinearConnection<LinearIssueNode> | null | undefined =
      response.issues;
    issues.push(...(connection?.nodes ?? []));
    after = connection?.pageInfo?.hasNextPage
      ? (connection.pageInfo.endCursor ?? null)
      : null;
  } while (after);

  return issues;
}

export function normalizeLinearIssue(
  project: OrchestratorProjectConfig,
  projectSlug: string,
  issue: LinearIssueNode
): TrackedIssue {
  const id = requireString(issue.id, "Linear issue id");
  const identifier = sanitizeLinearIdentifier(
    requireString(issue.identifier, "Linear issue identifier")
  );
  const state = requireString(issue.state?.name, "Linear issue state name");

  return {
    id,
    identifier,
    number:
      typeof issue.number === "number"
        ? issue.number
        : parseLinearIssueNumber(identifier),
    title: issue.title ?? identifier,
    description: issue.description ?? null,
    priority: typeof issue.priority === "number" ? issue.priority : null,
    state,
    branchName: null,
    url: issue.url ?? null,
    labels: (issue.labels?.nodes ?? [])
      .map((label) => label.name)
      .filter((label): label is string => typeof label === "string"),
    blockedBy: (issue.relations?.nodes ?? [])
      .filter((relation) => relation.type === "blocks")
      .map((relation) => ({
        id: relation.relatedIssue?.id ?? null,
        identifier:
          typeof relation.relatedIssue?.identifier === "string"
            ? sanitizeLinearIdentifier(relation.relatedIssue.identifier)
            : null,
        state: relation.relatedIssue?.state?.name ?? null,
      })),
    createdAt: issue.createdAt ?? null,
    updatedAt: issue.updatedAt ?? null,
    repository: project.repository,
    tracker: {
      adapter: "linear",
      bindingId: project.tracker.bindingId,
      itemId: id,
    },
    metadata: {
      projectSlug,
    },
  };
}

function createLinearGraphqlClient(
  config: ReturnType<typeof resolveLinearTrackerConfig>,
  fetchImpl: typeof fetch = fetch
): LinearGraphqlClient {
  return async <TData>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<TData> => {
    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: config.token,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(
        `Linear GraphQL request failed with HTTP ${response.status}.`
      );
    }

    const payload = (await response.json()) as {
      data?: TData;
      errors?: Array<{ message?: string }>;
    };

    if (payload.errors?.length) {
      const message =
        payload.errors
          .map((error) => error.message)
          .filter(Boolean)
          .join("; ") || "Unknown Linear GraphQL error";
      throw new Error(`Linear GraphQL request failed: ${message}`);
    }

    if (!payload.data) {
      throw new Error("Linear GraphQL response did not include data.");
    }

    return payload.data;
  };
}

function resolveLinearTrackerConfig(
  project: OrchestratorProjectConfig,
  dependencies: OrchestratorTrackerDependencies
) {
  const projectSlug = readRequiredSetting(project.tracker, "projectSlug");
  const token = dependencies.token ?? process.env.LINEAR_API_KEY;

  if (!token) {
    throw new Error("LINEAR_API_KEY environment variable is required.");
  }

  return {
    endpoint: resolveLinearEndpoint(project.tracker),
    pageSize:
      readPositiveIntegerSetting(project.tracker, "pageSize") ??
      DEFAULT_PAGE_SIZE,
    projectSlug,
    token,
  };
}

function resolveLinearEndpoint(tracker: OrchestratorTrackerConfig): string {
  return tracker.apiUrl?.trim() || DEFAULT_LINEAR_GRAPHQL_URL;
}

function readRequiredSetting(
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

function readPositiveIntegerSetting(
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

function readStringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n|,/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function sanitizeLinearIdentifier(identifier: string): string {
  const sanitized = identifier.trim().toUpperCase();
  if (!LINEAR_IDENTIFIER_PATTERN.test(sanitized)) {
    throw new Error(
      `Linear issue identifier "${identifier}" must match ${LINEAR_IDENTIFIER_PATTERN.source}.`
    );
  }
  return sanitized;
}

function parseLinearIssueNumber(identifier: string): number {
  const sanitized = sanitizeLinearIdentifier(identifier);
  return Number.parseInt(sanitized.split("-").at(-1) ?? "0", 10);
}

function parseLinearIssueNumberOrZero(identifier: string): number {
  try {
    return parseLinearIssueNumber(identifier);
  } catch {
    return 0;
  }
}

function reviveLinearIdentifier(identifier: string): string {
  try {
    return sanitizeLinearIdentifier(identifier);
  } catch {
    return identifier;
  }
}
