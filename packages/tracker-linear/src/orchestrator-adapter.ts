import {
  DEFAULT_LINEAR_GRAPHQL_URL as CORE_DEFAULT_LINEAR_GRAPHQL_URL,
  WorkflowValidationError,
  type OrchestratorProjectConfig,
  type OrchestratorRunRecord,
  type OrchestratorTrackerAdapter,
  type OrchestratorTrackerConfig,
  type OrchestratorTrackerDependencies,
  type TrackedIssue,
  type TrackedIssueList,
  filterIssuesByPickupLabels,
  normalizeLabels,
  parseTrackerTimestamp,
} from "@gh-symphony/core";
import {
  executeLinearGraphQL,
  type LinearGraphQLInvocation,
} from "@gh-symphony/tool-linear-graphql";

export const DEFAULT_LINEAR_GRAPHQL_URL = CORE_DEFAULT_LINEAR_GRAPHQL_URL;
const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_LINEAR_MAX_PAGES = 100;
export const MAX_LINEAR_MAX_PAGES = 1_000;
export const DEFAULT_LINEAR_PAGE_TIMEOUT_MS = 10_000;
export const MAX_LINEAR_PAGE_TIMEOUT_MS = 60_000;
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
  branchName?: string | null;
  url?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  state?: {
    name?: string | null;
  } | null;
  labels?: LinearConnection<{
    name?: string | null;
  }> | null;
  assignee?: { id?: string | null } | null;
  inverseRelations?: LinearConnection<{
    type?: string | null;
    issue?: {
      id?: string | null;
      identifier?: string | null;
      state?: {
        name?: string | null;
      } | null;
    } | null;
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
  viewer?: { id?: string | null } | null;
};

type LinearIssueFilter = {
  project: { slugId: { eq: string } };
  state?: { name: { in: string[] } };
  id?: { in: string[] };
  identifier?: { in: string[] };
};

const LINEAR_ISSUE_FIELDS = /* GraphQL */ `
  nodes {
    id
    identifier
    number
    title
    description
    priority
    branchName
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
    assignee {
      id
    }
    inverseRelations {
      nodes {
        type
        issue {
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
    viewer {
      id
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
    viewer {
      id
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
    viewer {
      id
    }
  }
`;

const LINEAR_ISSUE_STATE_QUERY = /* GraphQL */ `
  query SymphonyLinearIssueState($filter: IssueFilter!) {
    issues(first: 1, filter: $filter) {
      nodes {
        id
        state {
          name
        }
      }
    }
  }
`;

type LinearIssueStateResponse = {
  issues?: LinearConnection<{
    id?: string | null;
    state?: { name?: string | null } | null;
  }> | null;
};

export const linearTrackerAdapter: OrchestratorTrackerAdapter = {
  validateProviderConfig(provider, context) {
    const errors: WorkflowValidationError[] = [];
    validateRequiredProviderString(provider, "project_slug", errors);
    validateOptionalProviderString(provider, "endpoint", errors);
    validateLinearApiKey(context?.rawProvider ?? provider, errors);
    validatePickupLabels(provider, errors);

    for (const key of ["project_id", "projectId", "teamId", "team_id"]) {
      if (provider[key] !== undefined && provider[key] !== null) {
        errors.push(
          new WorkflowValidationError(
            "workflow_validation_error",
            `tracker.provider.${key}`,
            `Linear tracker provider does not support "${key}"; use "project_slug" to scope a Linear project.`
          )
        );
      }
    }
    return errors;
  },

  defaultLifecycle() {
    return {
      stateFieldName: "Status",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done"],
      blockerCheckStates: ["Todo"],
      planningStates: [],
    };
  },

  secretEnvironmentNames() {
    return ["LINEAR_API_KEY", "LINEAR_AUTHORIZATION"];
  },

  resolveWorkerCredentials(_project, environments) {
    for (const environment of [environments.project, environments.daemon]) {
      const authorization = environment.LINEAR_AUTHORIZATION?.trim();
      const apiKey = environment.LINEAR_API_KEY?.trim();
      if (authorization || apiKey) {
        return {
          ...(authorization ? { LINEAR_AUTHORIZATION: authorization } : {}),
          ...(apiKey ? { LINEAR_API_KEY: apiKey } : {}),
        };
      }
    }
    return {};
  },

  agentToolSpecs() {
    return [
      {
        name: "linear_graphql",
        description:
          "Execute a Linear GraphQL query or mutation for the active tracker issue.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "GraphQL query or mutation document.",
            },
            variables: {
              type: "object",
              description: "Variables for the GraphQL document.",
            },
            operationName: {
              type: "string",
              description: "Optional GraphQL operation name.",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ];
  },

  async executeAgentTool(name, args, context) {
    if (name !== "linear_graphql") {
      throw new Error(`Unknown Linear agent tool: ${name}`);
    }
    return executeLinearGraphQL(
      args as LinearGraphQLInvocation,
      {
        apiKey: context.environment?.LINEAR_API_KEY,
        apiUrl: context.environment?.LINEAR_GRAPHQL_URL,
        authorizationHeader: context.environment?.LINEAR_AUTHORIZATION,
      },
      fetch,
      context
    );
  },

  async listIssues(project, dependencies = {}) {
    const issues = await listLinearIssues(
      project,
      project.tracker.settings?.activeStates,
      dependencies
    );
    const filtered = filterIssuesByPickupLabels(
      issues,
      project
    ) as TrackedIssueList;
    if (filtered !== issues) {
      Object.defineProperty(filtered, "rateLimits", {
        configurable: true,
        enumerable: false,
        value: issues.rateLimits,
        writable: true,
      });
    }
    return filtered;
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

    return listLinearIssues(project, undefined, dependencies, issueIds, {
      applyPickupLabels: true,
    });
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
      url: run.issueUrl ?? null,
      labels: [],
      dispatchable: true,
      assigneeId: null,
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
      repository: project.repository,
      tracker: {
        adapter: "linear",
        bindingId: project.tracker.bindingId,
        itemId: run.issueId,
      },
      nativeRef: { itemId: run.issueId },
      isArchived: false,
      metadata: {},
    };
  },

  getTrackerItemId(issue) {
    const itemId = issue.nativeRef?.itemId;
    return typeof itemId === "string" ? itemId : null;
  },

  resolveAttributableBranches(issue) {
    const branchName = issue.branchName?.trim();
    return branchName ? [branchName] : [];
  },

  async requestState(project, input, dependencies = {}) {
    if (input.request.type === "transition-request") {
      return {
        ok: false,
        outcome: "rejected" as const,
        state: null,
        expectedState: input.request.expectedState,
        targetState: input.request.targetState,
        reason: input.request.reason,
        rateLimits: null,
        error: "linear_state_transitions_unsupported",
      };
    }

    const config = resolveLinearTrackerConfig(project, dependencies);
    const client = createLinearGraphqlClient(config, dependencies.fetchImpl);
    const response = await client<LinearIssueStateResponse>(
      LINEAR_ISSUE_STATE_QUERY,
      {
        filter: buildLinearIssueFilter({
          projectSlug: config.projectSlug,
          issueIds: [input.itemId],
        }),
      }
    );
    const issue = response.data.issues?.nodes?.find(
      (candidate) => candidate.id === input.itemId
    );
    if (!issue) {
      // This is a sentinel rather than a Linear workflow state. The worker
      // requires a string state for confirmed reads; routability is derived
      // from the missing normalized snapshot and keeps this non-actionable.
      return {
        ok: true,
        outcome: "confirmed" as const,
        state: "Missing",
        expectedState: null,
        targetState: null,
        reason: null,
        rateLimits: response.rateLimits,
        error: null,
      };
    }

    return {
      ok: true,
      outcome: "confirmed" as const,
      state: requireString(issue.state?.name, "Linear issue state name"),
      expectedState: null,
      targetState: null,
      reason: null,
      rateLimits: response.rateLimits,
      error: null,
    };
  },

  buildStructuredEventMetadata(project) {
    return { projectSlug: project.tracker.bindingId };
  },
};

function validateRequiredProviderString(
  provider: Record<string, unknown>,
  key: string,
  errors: WorkflowValidationError[]
): void {
  const value = provider[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(
      new WorkflowValidationError(
        "workflow_validation_error",
        `tracker.provider.${key}`,
        `${key} is required by the Linear tracker adapter.`
      )
    );
  }
}

function validateOptionalProviderString(
  provider: Record<string, unknown>,
  key: string,
  errors: WorkflowValidationError[]
): void {
  const value = provider[key];
  if (value !== undefined && (typeof value !== "string" || !value.trim())) {
    errors.push(
      new WorkflowValidationError(
        "workflow_validation_error",
        `tracker.provider.${key}`,
        `${key} must be a non-empty string when provided.`
      )
    );
  }
}

function validateLinearApiKey(
  provider: Record<string, unknown>,
  errors: WorkflowValidationError[]
): void {
  const value = provider.api_key;
  if (value === undefined || value === null) return;
  if (
    typeof value !== "string" ||
    !/^(?:\$[A-Z0-9_]+|env:[A-Z0-9_]+|.*\$\{[A-Z0-9_]+\}.*)$/.test(value)
  ) {
    errors.push(
      new WorkflowValidationError(
        "workflow_validation_error",
        "tracker.provider.api_key",
        'api_key must reference an environment variable such as "$LINEAR_API_KEY", "env:LINEAR_API_KEY", or "${LINEAR_API_KEY}".'
      )
    );
  }
}

function validatePickupLabels(
  provider: Record<string, unknown>,
  errors: WorkflowValidationError[]
): void {
  const value = provider.pickup_labels;
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    errors.push(
      new WorkflowValidationError(
        "workflow_validation_error",
        "tracker.provider.pickup_labels",
        "pickup_labels must be an object with optional include and exclude string lists."
      )
    );
    return;
  }
  const labels = value as Record<string, unknown>;
  for (const key of ["include", "exclude"]) {
    const labelsForKey = labels[key];
    if (
      labelsForKey !== undefined &&
      (!Array.isArray(labelsForKey) ||
        labelsForKey.some((label) => typeof label !== "string"))
    ) {
      errors.push(
        new WorkflowValidationError(
          "workflow_validation_error",
          `tracker.provider.pickup_labels.${key}`,
          `${key} must be a list of strings when provided.`
        )
      );
    }
  }
}

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
    pageSize: config.pageSize,
    maxPages: config.maxPages,
  });
  if (config.assignedOnly && result.viewerId === null) {
    throw new Error(
      "Linear assignedOnly is enabled but the authenticated viewer id could not be resolved; refusing to derive dispatch eligibility."
    );
  }

  const fetchedIssues = result.nodes.map((node) =>
    normalizeLinearIssue(project, config.projectSlug, node, {
      assignedOnly: config.assignedOnly,
      rateLimits: result.rateLimits,
      viewerId: result.viewerId,
    })
  ) as TrackedIssueList;
  const blockerEligibleIssues = fetchedIssues.map((issue) =>
    applyBlockerDispatchability(issue, config)
  ) as TrackedIssueList;
  const issues = options.applyPickupLabels
    ? (filterIssuesByPickupLabels(
        blockerEligibleIssues,
        project
      ) as TrackedIssueList)
    : blockerEligibleIssues;
  Object.defineProperty(issues, "rateLimits", {
    configurable: true,
    enumerable: false,
    value: result.rateLimits,
    writable: true,
  });

  if (config.assignedOnly) {
    emitDispatchableDerivedEvent({
      projectSlug: config.projectSlug,
      dispatchableCount: issues.filter((issue) => issue.dispatchable).length,
      nonDispatchableCount: issues.filter((issue) => !issue.dispatchable)
        .length,
    });
  }

  return issues;
}

async function fetchPaginatedLinearIssues(
  client: LinearGraphqlClient,
  input: {
    projectSlug: string;
    stateNames?: string[];
    issueIds?: string[];
    issueIdentifiers?: string[];
    pageSize: number;
    maxPages: number;
  }
): Promise<{
  nodes: LinearIssueNode[];
  viewerId: string | null;
  rateLimits: LinearRateLimitPayload | null;
}> {
  const issues: LinearIssueNode[] = [];
  let latestRateLimits: LinearRateLimitPayload | null = null;
  let viewerId: string | null = null;
  let after: string | null = null;

  for (let page = 0; page < input.maxPages; page += 1) {
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
    viewerId ??= normalizeLinearUserId(response.data.viewer?.id);
    const connection: LinearConnection<LinearIssueNode> | null | undefined =
      response.data.issues;
    issues.push(...(connection?.nodes ?? []));
    if (connection?.pageInfo?.hasNextPage && !connection.pageInfo.endCursor) {
      throw trackerPaginationError({
        adapter: "linear",
        projectSlug: input.projectSlug,
        pageCount: page + 1,
        reason: "hasNextPage=true but endCursor is null",
      });
    }
    after = connection?.pageInfo?.hasNextPage
      ? (connection.pageInfo.endCursor ?? null)
      : null;
    if (!after) {
      break;
    }
  }

  if (after) {
    throw trackerPaginationError({
      adapter: "linear",
      projectSlug: input.projectSlug,
      pageCount: input.maxPages,
      reason: `maximum page limit (${input.maxPages}) reached before pagination completed`,
    });
  }

  return {
    nodes: issues,
    viewerId,
    rateLimits: latestRateLimits,
  };
}

function buildLinearIssueFilter(input: {
  projectSlug: string;
  stateNames?: string[];
  issueIds?: string[];
  issueIdentifiers?: string[];
}): LinearIssueFilter {
  return {
    project: { slugId: { eq: input.projectSlug } },
    ...(input.issueIdentifiers
      ? { identifier: { in: input.issueIdentifiers } }
      : input.issueIds
        ? { id: { in: input.issueIds } }
        : { state: { name: { in: input.stateNames ?? [] } } }),
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
  options: {
    assignedOnly?: boolean;
    rateLimits?: Record<string, unknown> | null;
    viewerId?: string | null;
  } = {}
): TrackedIssue {
  const assigneeId = normalizeLinearUserId(issue.assignee?.id);
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
    priority:
      typeof issue.priority === "number" && issue.priority !== 0
        ? issue.priority
        : null,
    state,
    branchName: normalizeLinearBranchName(issue.branchName),
    url: issue.url ?? null,
    labels: normalizeLabels(
      (issue.labels?.nodes ?? []).map((label) => label.name)
    ),
    dispatchable:
      !options.assignedOnly ||
      (assigneeId !== null && assigneeId === options.viewerId),
    assigneeId,
    blockedBy: (issue.inverseRelations?.nodes ?? [])
      .filter((relation) => relation.type === "blocks")
      .map((relation) => ({
        id: relation.issue?.id ?? null,
        identifier:
          typeof relation.issue?.identifier === "string"
            ? sanitizeLinearIdentifier(relation.issue.identifier)
            : null,
        state: relation.issue?.state?.name ?? null,
      })),
    createdAt: parseTrackerTimestamp(issue.createdAt),
    updatedAt: parseTrackerTimestamp(issue.updatedAt),
    repository: project.repository,
    tracker: {
      adapter: "linear",
      bindingId: project.tracker.bindingId,
      itemId: id,
    },
    nativeRef: { itemId: id, projectSlug },
    metadata: {},
    rateLimits: options.rateLimits ?? null,
  };
}

function normalizeLinearBranchName(
  value: string | null | undefined
): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function trackerPaginationError(input: Record<string, unknown>): Error {
  const event = { event: "tracker-pagination-integrity-failure", ...input };
  console.error(JSON.stringify(event));
  const error = new Error(`tracker_pagination: ${input.reason}`);
  Object.assign(error, { category: "tracker_pagination", event });
  return error;
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.pageTimeoutMs);
    try {
      const response = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: config.token,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
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
    } finally {
      clearTimeout(timeout);
    }
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
    maxPages: Math.min(
      readPositiveIntegerSetting(project.tracker, "maxPages") ??
        DEFAULT_LINEAR_MAX_PAGES,
      MAX_LINEAR_MAX_PAGES
    ),
    pageTimeoutMs: Math.min(
      readPositiveIntegerSetting(project.tracker, "pageTimeoutMs") ??
        DEFAULT_LINEAR_PAGE_TIMEOUT_MS,
      MAX_LINEAR_PAGE_TIMEOUT_MS
    ),
    projectSlug,
    blockerCheckStates:
      dependencies.workflowTracker?.blockerCheckStates ??
      readStringArray(project.tracker.settings?.blockerCheckStates),
    terminalStates:
      dependencies.workflowTracker?.terminalStates ??
      readStringArray(project.tracker.settings?.terminalStates),
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
        "[gh-symphony] Deprecated tracker.settings.assignedOnly detected. Use 'gh-symphony project start --project-dir <path> --assigned-only' instead; persisted assignedOnly support will be removed in the next major release."
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

function applyBlockerDispatchability(
  issue: TrackedIssue,
  config: {
    blockerCheckStates: string[] | undefined;
    terminalStates: string[] | undefined;
  }
): TrackedIssue {
  if (
    !issue.dispatchable ||
    !matchesState(issue.state, config.blockerCheckStates ?? [])
  ) {
    return issue;
  }
  const unresolved = issue.blockedBy.filter(
    (blocker) =>
      !blocker.state ||
      !matchesState(blocker.state, config.terminalStates ?? [])
  );
  if (unresolved.length === 0) {
    return issue;
  }
  const identifiers = unresolved
    .map((blocker) => blocker.identifier ?? blocker.id ?? "unknown")
    .join(", ");
  return {
    ...issue,
    dispatchable: false,
    dispatchReason: `Blocked by unresolved Linear issue${unresolved.length === 1 ? "" : "s"}: ${identifiers}.`,
  };
}

function matchesState(state: string, candidates: readonly string[]): boolean {
  const normalized = state.trim().toLowerCase();
  return candidates.some(
    (candidate) => candidate.trim().toLowerCase() === normalized
  );
}

function emitDispatchableDerivedEvent(input: {
  projectSlug: string;
  dispatchableCount: number;
  nonDispatchableCount: number;
}): void {
  console.info(
    JSON.stringify({
      event: "tracker-dispatchable-derived",
      tracker: "linear",
      projectSlug: input.projectSlug,
      assignmentScope: "viewer",
      dispatchableCount: input.dispatchableCount,
      nonDispatchableCount: input.nonDispatchableCount,
    })
  );
}

function normalizeLinearUserId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
