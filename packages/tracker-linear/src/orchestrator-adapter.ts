import {
  DEFAULT_LINEAR_GRAPHQL_URL as CORE_DEFAULT_LINEAR_GRAPHQL_URL,
  type OrchestratorProjectConfig,
  type OrchestratorRunRecord,
  type OrchestratorTrackerAdapter,
  type OrchestratorTrackerConfig,
  type OrchestratorTrackerDependencies,
  type TrackedIssue,
  type TrackedIssueList,
} from "@gh-symphony/core";

export const DEFAULT_LINEAR_GRAPHQL_URL = CORE_DEFAULT_LINEAR_GRAPHQL_URL;
const DEFAULT_PAGE_SIZE = 50;
const LINEAR_IDENTIFIER_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

type LinearRateLimitPayload = {
  source: "linear";
  limit: number | null;
  remaining: number | null;
  used: number | null;
  reset: number | null;
  resetAt: string | null;
  retryAfter: number | null;
  resource: "graphql";
};

type LinearGraphqlClient = <TData>(
  query: string,
  variables: Record<string, unknown>
) => Promise<{
  data: TData;
  rateLimits: LinearRateLimitPayload | null;
}>;

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

type LinearIssueFilter = {
  project: { slugId: { eq: string } };
  state?: { name: { in: string[] } };
  id?: { in: string[] };
  identifier?: { in: string[] };
  assignee?: { isMe: { eq: true } };
};

type PickupLabelConfig = {
  include: string[];
  exclude: string[];
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
    $filter: IssueFilter!
    $first: Int!
    $after: String
  ) {
    issues(
      first: $first
      after: $after
      filter: $filter
    ) {
      ${LINEAR_ISSUE_FIELDS}
    }
  }
`;

const LINEAR_ISSUES_BY_IDS_QUERY = /* GraphQL */ `
  query SymphonyLinearIssueStates(
    $filter: IssueFilter!
    $first: Int!
    $after: String
  ) {
    issues(
      first: $first
      after: $after
      filter: $filter
    ) {
      ${LINEAR_ISSUE_FIELDS}
    }
  }
`;

const LINEAR_ISSUES_BY_IDENTIFIERS_QUERY = /* GraphQL */ `
  query SymphonyLinearIssueStatesByIdentifier(
    $filter: IssueFilter!
    $first: Int!
    $after: String
  ) {
    issues(
      first: $first
      after: $after
      filter: $filter
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
      dependencies,
      undefined,
      { applyPickupLabels: true }
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
  issueIds?: readonly string[],
  options: { applyPickupLabels?: boolean } = {}
): Promise<TrackedIssueList> {
  const config = resolveLinearTrackerConfig(project, dependencies);
  const client = createLinearGraphqlClient(config, dependencies.fetchImpl);
  const stateNames = readStringArray(stateNamesInput);
  if (!issueIds && (!stateNames || stateNames.length === 0)) {
    throw new Error(
      'Tracker adapter "linear" requires at least one active state name in the "activeStates" setting.'
    );
  }
  const result = await fetchPaginatedLinearIssues(client, {
    projectSlug: config.projectSlug,
    stateNames,
    issueIds:
      issueIds && !issueIds.every(isLinearIdentifier)
        ? [...issueIds]
        : undefined,
    issueIdentifiers:
      issueIds && issueIds.every(isLinearIdentifier)
        ? issueIds.map((identifier) => identifier.trim().toUpperCase())
        : undefined,
    assignedOnly: config.assignedOnly,
    pageSize: config.pageSize,
  });

  const fetchedIssues = result.nodes.map((node) =>
    normalizeLinearIssue(project, config.projectSlug, node, result.rateLimits)
  ) as TrackedIssueList;
  const filteredIssues = options.applyPickupLabels
    ? filterIssuesByPickupLabels(
        fetchedIssues,
        config.pickupLabels,
        config.projectSlug
      )
    : fetchedIssues;
  Object.defineProperty(filteredIssues, "rateLimits", {
    configurable: true,
    enumerable: false,
    value: result.rateLimits,
    writable: true,
  });

  if (config.assignedOnly) {
    emitAssignedOnlyFilterEvent({
      projectSlug: config.projectSlug,
      includedCount: filteredIssues.length,
    });
  }

  return filteredIssues;
}

async function fetchPaginatedLinearIssues(
  client: LinearGraphqlClient,
  input: {
    projectSlug: string;
    stateNames?: string[];
    issueIds?: string[];
    issueIdentifiers?: string[];
    assignedOnly: boolean;
    pageSize: number;
  }
): Promise<{
  nodes: LinearIssueNode[];
  rateLimits: LinearRateLimitPayload | null;
}> {
  const issues: LinearIssueNode[] = [];
  let latestRateLimits: LinearRateLimitPayload | null = null;
  let after: string | null = null;

  do {
    const query = input.issueIdentifiers
      ? LINEAR_ISSUES_BY_IDENTIFIERS_QUERY
      : input.issueIds
        ? LINEAR_ISSUES_BY_IDS_QUERY
        : LINEAR_ISSUES_BY_STATES_QUERY;
    const response: {
      data: LinearIssuesResponse;
      rateLimits: LinearRateLimitPayload | null;
    } = await client<LinearIssuesResponse>(query, {
      filter: buildLinearIssueFilter(input),
      first: input.pageSize,
      after,
    });
    latestRateLimits = response.rateLimits ?? latestRateLimits;
    const connection: LinearConnection<LinearIssueNode> | null | undefined =
      response.data.issues;
    issues.push(...(connection?.nodes ?? []));
    after = connection?.pageInfo?.hasNextPage
      ? (connection.pageInfo.endCursor ?? null)
      : null;
  } while (after);

  return {
    nodes: issues,
    rateLimits: latestRateLimits,
  };
}

function buildLinearIssueFilter(input: {
  projectSlug: string;
  stateNames?: string[];
  issueIds?: string[];
  issueIdentifiers?: string[];
  assignedOnly: boolean;
}): LinearIssueFilter {
  return {
    project: { slugId: { eq: input.projectSlug } },
    ...(input.issueIdentifiers
      ? { identifier: { in: input.issueIdentifiers } }
      : input.issueIds
        ? { id: { in: input.issueIds } }
        : { state: { name: { in: input.stateNames ?? [] } } }),
    ...(input.assignedOnly ? { assignee: { isMe: { eq: true } } } : {}),
  };
}

function isLinearIdentifier(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed === trimmed.toUpperCase() && LINEAR_IDENTIFIER_PATTERN.test(trimmed)
  );
}

export function normalizeLinearIssue(
  project: OrchestratorProjectConfig,
  projectSlug: string,
  issue: LinearIssueNode,
  rateLimits: Record<string, unknown> | null = null
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
    rateLimits,
  };
}

function createLinearGraphqlClient(
  config: ReturnType<typeof resolveLinearTrackerConfig>,
  fetchImpl: typeof fetch = fetch
): LinearGraphqlClient {
  return async <TData>(
    query: string,
    variables: Record<string, unknown>
  ): Promise<{
    data: TData;
    rateLimits: LinearRateLimitPayload | null;
  }> => {
    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: config.token,
      },
      body: JSON.stringify({ query, variables }),
    });
    const rateLimits = extractLinearRateLimits(response.headers);

    if (!response.ok) {
      const retryAfter = rateLimits?.retryAfter;
      const retrySuffix =
        typeof retryAfter === "number"
          ? ` Retry after ${retryAfter} seconds.`
          : "";
      throw new Error(
        `Linear GraphQL request failed with HTTP ${response.status}.${retrySuffix}`
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

    return {
      data: payload.data,
      rateLimits,
    };
  };
}

function extractLinearRateLimits(
  headers: Pick<Headers, "get"> | null | undefined
): LinearRateLimitPayload | null {
  if (!headers || typeof headers.get !== "function") {
    return null;
  }

  const limit =
    parseIntegerHeader(headers.get("x-ratelimit-requests-limit")) ??
    parseIntegerHeader(headers.get("x-ratelimit-limit"));
  const remaining =
    parseIntegerHeader(headers.get("x-ratelimit-requests-remaining")) ??
    parseIntegerHeader(headers.get("x-ratelimit-remaining"));
  const reset =
    parseIntegerHeader(headers.get("x-ratelimit-requests-reset")) ??
    parseIntegerHeader(headers.get("x-ratelimit-reset"));
  const retryAfter = parseIntegerHeader(headers.get("retry-after"));
  const used =
    limit !== null && remaining !== null
      ? Math.max(0, limit - remaining)
      : null;

  if (
    limit === null &&
    remaining === null &&
    reset === null &&
    retryAfter === null
  ) {
    return null;
  }

  return {
    source: "linear",
    limit,
    remaining,
    used,
    reset,
    resetAt: resolveRateLimitResetAt(reset),
    retryAfter,
    resource: "graphql",
  };
}

function resolveRateLimitResetAt(reset: number | null): string | null {
  if (reset === null) {
    return null;
  }

  if (reset > 1_000_000_000_000) {
    return new Date(reset).toISOString();
  }

  if (reset > 1_000_000_000) {
    return new Date(reset * 1000).toISOString();
  }

  return new Date(Date.now() + reset * 1000).toISOString();
}

function parseIntegerHeader(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
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
    assignedOnly: resolveAssignedOnly(project.tracker, dependencies),
    pageSize:
      readPositiveIntegerSetting(project.tracker, "pageSize") ??
      DEFAULT_PAGE_SIZE,
    pickupLabels: resolvePickupLabels(project.tracker),
    projectSlug,
    token,
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

  const legacyAssignedOnly = readBooleanSetting(tracker, "assignedOnly");
  if (legacyAssignedOnly) {
    const warningKey = `${tracker.adapter}:${tracker.bindingId}`;
    if (!warnedLegacyAssignedOnlyProjectIds.has(warningKey)) {
      warnedLegacyAssignedOnlyProjectIds.add(warningKey);
      console.warn(
        "[gh-symphony] Deprecated tracker.settings.assignedOnly detected. Use 'gh-symphony repo start --assigned-only' instead; persisted assignedOnly support will be removed in the next major release."
      );
    }
  }

  return legacyAssignedOnly;
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

function readBooleanSetting(
  tracker: OrchestratorTrackerConfig,
  key: string
): boolean {
  const value = tracker.settings?.[key];
  return value === true || value === "true";
}

function resolvePickupLabels(
  tracker: OrchestratorTrackerConfig
): PickupLabelConfig {
  const pickupLabels =
    readObjectSetting(tracker, "pickupLabels") ??
    readObjectSetting(tracker, "pickup_labels");

  return {
    include: normalizeConfiguredLabels(
      readStringArray(pickupLabels?.include) ?? []
    ),
    exclude: normalizeConfiguredLabels(
      readStringArray(pickupLabels?.exclude) ?? []
    ),
  };
}

function readObjectSetting(
  tracker: OrchestratorTrackerConfig,
  key: string
): Record<string, unknown> | undefined {
  const value = tracker.settings?.[key];
  if (
    value === undefined ||
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object"
  ) {
    return undefined;
  }
  return value as Record<string, unknown>;
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

function normalizeConfiguredLabels(labels: string[]): string[] {
  return Array.from(
    new Set(
      labels.map((label) => label.trim()).filter((label) => label.length > 0)
    )
  );
}

function filterIssuesByPickupLabels(
  issues: TrackedIssueList,
  config: PickupLabelConfig,
  projectSlug: string
): TrackedIssueList {
  if (config.include.length === 0 && config.exclude.length === 0) {
    return issues;
  }

  const includeLabels = new Set(config.include);
  const excludeLabels = new Set(config.exclude);
  const filtered = issues.filter((issue) => {
    const issueLabels = new Set(issue.labels);
    if (config.exclude.some((label) => issueLabels.has(label))) {
      return false;
    }
    return (
      includeLabels.size === 0 ||
      config.include.some((label) => issueLabels.has(label))
    );
  }) as TrackedIssueList;

  emitPickupLabelFilterEvent({
    projectSlug,
    include: [...includeLabels],
    exclude: [...excludeLabels],
    includedCount: filtered.length,
    excludedCount: issues.length - filtered.length,
  });

  return filtered;
}

function emitAssignedOnlyFilterEvent(input: {
  projectSlug: string;
  includedCount: number;
}): void {
  console.info(
    JSON.stringify({
      event: "tracker-assigned-only-filtered",
      tracker: "linear",
      projectSlug: input.projectSlug,
      assigneeFilter: "isMe",
      includedCount: input.includedCount,
      excludedCount: null,
    })
  );
}

function emitPickupLabelFilterEvent(input: {
  projectSlug: string;
  include: string[];
  exclude: string[];
  includedCount: number;
  excludedCount: number;
}): void {
  console.info(
    JSON.stringify({
      event: "tracker-pickup-label-filtered",
      tracker: "linear",
      projectSlug: input.projectSlug,
      include: input.include,
      exclude: input.exclude,
      includedCount: input.includedCount,
      excludedCount: input.excludedCount,
    })
  );
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
