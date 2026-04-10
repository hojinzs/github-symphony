const DEFAULT_API_URL = "https://api.github.com/graphql";
const REST_API_URL = "https://api.github.com";

export type GitHubClient = {
  token: string;
  apiUrl: string;
  fetchImpl: typeof fetch;
};

export type ViewerInfo = {
  login: string;
  name: string | null;
  scopes: string[];
};

export type ProjectSummary = {
  id: string;
  title: string;
  shortDescription: string;
  url: string;
  openItemCount: number;
  owner: {
    login: string;
    type: "User" | "Organization";
  };
};

export type StatusFieldOption = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
};

export type ProjectStatusField = {
  id: string;
  name: string;
  options: StatusFieldOption[];
};

export type LinkedRepository = {
  owner: string;
  name: string;
  url: string;
  cloneUrl: string;
};

export type RepositoryLookupResult = LinkedRepository & {
  visibility: "public" | "private" | "internal" | null;
};

export type ProjectTextField = {
  id: string;
  name: string;
  dataType: string;
};

export type ProjectDetail = {
  id: string;
  title: string;
  url: string;
  statusFields: ProjectStatusField[];
  textFields: ProjectTextField[];
  linkedRepositories: LinkedRepository[];
};

export function findLinkedRepository(
  project: ProjectDetail,
  owner: string,
  name: string
): LinkedRepository | null {
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedName = name.trim().toLowerCase();

  return (
    project.linkedRepositories.find(
      (repository) =>
        repository.owner.trim().toLowerCase() === normalizedOwner &&
        repository.name.trim().toLowerCase() === normalizedName
    ) ?? null
  );
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export class GitHubScopeError extends GitHubApiError {
  constructor(
    message: string,
    readonly requiredScopes: string[],
    readonly currentScopes: string[]
  ) {
    super(message);
    this.name = "GitHubScopeError";
  }
}

export class GitHubRepositoryLookupError extends GitHubApiError {
  constructor(
    readonly reason:
      | "not_found"
      | "no_access"
      | "rate_limited"
      | "invalid_token"
      | "offline"
      | "unknown",
    message: string,
    readonly remediation: string,
    status?: number
  ) {
    super(message, status);
    this.name = "GitHubRepositoryLookupError";
  }
}

export function createClient(
  token: string,
  options?: { apiUrl?: string; fetchImpl?: typeof fetch }
): GitHubClient {
  return {
    token,
    apiUrl: options?.apiUrl ?? DEFAULT_API_URL,
    fetchImpl: options?.fetchImpl ?? fetch,
  };
}

export async function getRepositoryMetadata(
  client: GitHubClient,
  owner: string,
  name: string
): Promise<RepositoryLookupResult> {
  const restUrl = client.apiUrl.replace("/graphql", "");
  const baseUrl = restUrl === client.apiUrl ? REST_API_URL : restUrl;
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  let response: Response;
  try {
    response = await client.fetchImpl(`${baseUrl}${repoPath}`, {
      headers: {
        authorization: `Bearer ${client.token}`,
        accept: "application/vnd.github+json",
      },
    });
  } catch (error) {
    const detail =
      error instanceof Error && error.message.length > 0
        ? ` ${error.message}`
        : "";
    throw new GitHubRepositoryLookupError(
      "offline",
      `GitHub repository validation could not reach the API.${detail}`.trim(),
      "Check your network connection and re-run the command to validate before saving."
    );
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      message?: string;
    } | null;
    const message = payload?.message?.trim() || response.statusText;

    if (
      response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        /rate limit/i.test(message))
    ) {
      throw new GitHubRepositoryLookupError(
        "rate_limited",
        "GitHub API rate limit blocked repository validation.",
        "Wait for the rate limit window to reset, then re-run 'gh-symphony repo add owner/name'.",
        response.status
      );
    }

    if (response.status === 401) {
      throw new GitHubRepositoryLookupError(
        "invalid_token",
        "GitHub token is invalid or expired.",
        "Run 'gh auth login --scopes repo,read:org,project' or refresh GITHUB_GRAPHQL_TOKEN, then retry.",
        response.status
      );
    }

    if (
      response.status === 403 ||
      /resource not accessible|saml|single sign-on|access denied/i.test(message)
    ) {
      throw new GitHubRepositoryLookupError(
        "no_access",
        `GitHub denied access to ${owner}/${name}.`,
        "Confirm that the authenticated user can read this repository and that the token has the required access.",
        response.status
      );
    }

    if (response.status === 404) {
      throw new GitHubRepositoryLookupError(
        "not_found",
        `Repository ${owner}/${name} was not found.`,
        "Check the owner/name spelling. If the repository is private, confirm the current token can access it.",
        response.status
      );
    }

    throw new GitHubRepositoryLookupError(
      "unknown",
      `GitHub repository validation failed: ${response.status} ${message}`.trim(),
      "Retry the command. If the problem continues, verify GitHub API access separately.",
      response.status
    );
  }

  const repo = (await response.json()) as {
    name: string;
    clone_url: string;
    html_url: string;
    visibility?: "public" | "private" | "internal";
    private?: boolean;
    owner: { login: string };
  };

  return {
    owner: repo.owner.login,
    name: repo.name,
    url: repo.html_url,
    cloneUrl: repo.clone_url,
    visibility:
      repo.visibility ?? (repo.private === true ? "private" : "public"),
  };
}

// ── 2.1: Token validation & scope check ──────────────────────────────────────

export async function validateToken(client: GitHubClient): Promise<ViewerInfo> {
  // Use REST to get X-OAuth-Scopes header (GraphQL doesn't expose scopes)
  const restUrl = client.apiUrl.replace("/graphql", "");
  const baseUrl = restUrl === client.apiUrl ? REST_API_URL : restUrl;
  const response = await client.fetchImpl(`${baseUrl}/user`, {
    headers: {
      authorization: `Bearer ${client.token}`,
      accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new GitHubApiError("Invalid token: authentication failed.", 401);
    }
    throw new GitHubApiError(
      `GitHub API error: ${response.status} ${response.statusText}`,
      response.status
    );
  }

  const scopes =
    response.headers
      .get("x-oauth-scopes")
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];

  const user = (await response.json()) as {
    login: string;
    name: string | null;
  };

  return {
    login: user.login,
    name: user.name,
    scopes,
  };
}

export function checkRequiredScopes(scopes: string[]): {
  valid: boolean;
  missing: string[];
} {
  const required = ["repo", "read:org", "project"];
  const normalizedScopes = scopes.map((s) => s.toLowerCase());
  const missing = required.filter((r) => !normalizedScopes.includes(r));
  return { valid: missing.length === 0, missing };
}

// ── 2.2: Projects v2 list ────────────────────────────────────────────────────

export async function listUserProjects(
  client: GitHubClient
): Promise<ProjectSummary[]> {
  const data = await graphql<ViewerProjectsResponse>(
    client,
    VIEWER_PROJECTS_QUERY
  );
  const projects: ProjectSummary[] = [];

  for (const node of data.viewer.projectsV2?.nodes ?? []) {
    if (!node) continue;
    projects.push(
      normalizeProjectSummary(node, {
        login: data.viewer.login,
        type: "User",
      })
    );
  }

  for (const orgNode of data.viewer.organizations?.nodes ?? []) {
    if (!orgNode) continue;
    for (const projNode of orgNode.projectsV2?.nodes ?? []) {
      if (!projNode) continue;
      projects.push(
        normalizeProjectSummary(projNode, {
          login: orgNode.login,
          type: "Organization",
        })
      );
    }
  }

  return projects;
}

function normalizeProjectSummary(
  node: GraphQLProjectNode,
  owner: { login: string; type: "User" | "Organization" }
): ProjectSummary {
  return {
    id: node.id,
    title: node.title,
    shortDescription: node.shortDescription ?? "",
    url: node.url,
    openItemCount: node.items?.totalCount ?? 0,
    owner,
  };
}

// ── 2.3: Project detail (status fields + linked repos) ───────────────────────

export async function getProjectDetail(
  client: GitHubClient,
  projectId: string
): Promise<ProjectDetail> {
  const data = await graphql<ProjectDetailResponse>(
    client,
    PROJECT_DETAIL_QUERY,
    { projectId }
  );

  const project = data.node;
  if (!project || project.__typename !== "ProjectV2") {
    throw new GitHubApiError(`Project not found: ${projectId}`);
  }

  const statusFields: ProjectStatusField[] = [];
  const textFields: ProjectTextField[] = [];
  for (const field of project.fields?.nodes ?? []) {
    if (!field) continue;
    if (field.__typename === "ProjectV2SingleSelectField") {
      statusFields.push({
        id: field.id,
        name: field.name,
        options: (field.options ?? []).map((opt) => ({
          id: opt.id,
          name: opt.name,
          description: opt.description ?? null,
          color: opt.color ?? null,
        })),
      });
    } else if (field.__typename === "ProjectV2Field" && field.dataType) {
      textFields.push({
        id: field.id,
        name: field.name,
        dataType: field.dataType,
      });
    }
  }

  const repoMap = new Map<string, LinkedRepository>();
  let cursor: string | null = null;
  let hasMore = true;

  // Use initial page from the detail query
  for (const item of project.items?.nodes ?? []) {
    const repo = item?.content?.repository;
    if (!repo) continue;
    const key = `${repo.owner.login}/${repo.name}`;
    if (!repoMap.has(key)) {
      repoMap.set(key, {
        owner: repo.owner.login,
        name: repo.name,
        url: repo.url,
        cloneUrl: repo.url.endsWith(".git") ? repo.url : `${repo.url}.git`,
      });
    }
  }

  hasMore = project.items?.pageInfo?.hasNextPage ?? false;
  cursor = project.items?.pageInfo?.endCursor ?? null;

  // Paginate remaining items for linked repos
  while (hasMore && cursor) {
    const pageData = await graphql<ProjectItemsPageResponse>(
      client,
      PROJECT_ITEMS_PAGE_QUERY,
      { projectId, cursor }
    );

    const items = pageData.node?.items;
    if (!items) break;

    for (const item of items.nodes ?? []) {
      const repo = item?.content?.repository;
      if (!repo) continue;
      const key = `${repo.owner.login}/${repo.name}`;
      if (!repoMap.has(key)) {
        repoMap.set(key, {
          owner: repo.owner.login,
          name: repo.name,
          url: repo.url,
          cloneUrl: repo.url.endsWith(".git") ? repo.url : `${repo.url}.git`,
        });
      }
    }

    hasMore = items.pageInfo?.hasNextPage ?? false;
    cursor = items.pageInfo?.endCursor ?? null;
  }

  return {
    id: project.id,
    title: project.title,
    url: project.url,
    statusFields,
    textFields,
    linkedRepositories: [...repoMap.values()],
  };
}

// ── GraphQL helpers ──────────────────────────────────────────────────────────

async function graphql<T>(
  client: GitHubClient,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const response = await client.fetchImpl(client.apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${client.token}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GitHubApiError(
      `GitHub GraphQL request failed: ${response.status} ${response.statusText}. ${text}`,
      response.status
    );
  }

  const payload = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (payload.errors?.length) {
    const scopeMessages = payload.errors
      .map((e) => e.message)
      .filter((m) => m.includes("has not been granted the required scopes"));

    if (scopeMessages.length > 0) {
      const requiredScopes = new Set<string>();
      let currentScopes: string[] = [];

      for (const msg of scopeMessages) {
        for (const match of msg.matchAll(
          /requires one of the following scopes: \['([^']+)'\]/g
        )) {
          requiredScopes.add(match[1]!);
        }
        if (currentScopes.length === 0) {
          const currMatch = /has only been granted the: \[([^\]]+)\]/.exec(msg);
          if (currMatch) {
            currentScopes = currMatch[1]!
              .split(",")
              .map((s) => s.trim().replace(/'/g, ""))
              .filter(Boolean);
          }
        }
      }

      throw new GitHubScopeError(
        "Token is missing required GitHub scopes.",
        [...requiredScopes],
        currentScopes
      );
    }

    throw new GitHubApiError(
      `GraphQL errors: ${payload.errors.map((e) => e.message).join("; ")}`
    );
  }

  if (!payload.data) {
    throw new GitHubApiError("GraphQL response missing data.");
  }

  return payload.data;
}

// ── GraphQL types ────────────────────────────────────────────────────────────

type GraphQLProjectNode = {
  id: string;
  title: string;
  shortDescription: string | null;
  url: string;
  items: { totalCount: number } | null;
};

type ViewerProjectsResponse = {
  viewer: {
    login: string;
    projectsV2: { nodes: Array<GraphQLProjectNode | null> | null } | null;
    organizations: {
      nodes: Array<{
        login: string;
        projectsV2: { nodes: Array<GraphQLProjectNode | null> | null } | null;
      } | null> | null;
    } | null;
  };
};

type ProjectDetailResponse = {
  node: {
    __typename: string;
    id: string;
    title: string;
    url: string;
    fields: {
      nodes: Array<{
        __typename: string;
        id: string;
        name: string;
        dataType?: string;
        options?: Array<{
          id: string;
          name: string;
          description?: string;
          color?: string;
        }>;
      } | null> | null;
    } | null;
    items: {
      nodes: Array<{
        content: {
          __typename: string;
          repository?: {
            name: string;
            url: string;
            owner: { login: string };
          };
        } | null;
      } | null> | null;
      pageInfo: {
        endCursor: string | null;
        hasNextPage: boolean;
      } | null;
    } | null;
  } | null;
};

type ProjectItemsPageResponse = {
  node: {
    items: {
      nodes: Array<{
        content: {
          __typename: string;
          repository?: {
            name: string;
            url: string;
            owner: { login: string };
          };
        } | null;
      } | null> | null;
      pageInfo: {
        endCursor: string | null;
        hasNextPage: boolean;
      };
    } | null;
  } | null;
};

// ── GraphQL queries ──────────────────────────────────────────────────────────

const VIEWER_PROJECTS_QUERY = `
  query ViewerProjects {
    viewer {
      login
      projectsV2(first: 50) {
        nodes {
          id
          title
          shortDescription
          url
          items { totalCount }
        }
      }
      organizations(first: 20) {
        nodes {
          login
          projectsV2(first: 50) {
            nodes {
              id
              title
              shortDescription
              url
              items { totalCount }
            }
          }
        }
      }
    }
  }
`;

const PROJECT_DETAIL_QUERY = `
  query ProjectDetail($projectId: ID!) {
    node(id: $projectId) {
      __typename
      ... on ProjectV2 {
        id
        title
        url
        fields(first: 50) {
          nodes {
            __typename
            ... on ProjectV2SingleSelectField {
              id
              name
              options {
                id
                name
                description
                color
              }
            }
            ... on ProjectV2Field {
              id
              name
              dataType
            }
          }
        }
        items(first: 100) {
          nodes {
            content {
              __typename
              ... on Issue {
                repository {
                  name
                  url
                  owner { login }
                }
              }
              ... on PullRequest {
                repository {
                  name
                  url
                  owner { login }
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

const PROJECT_ITEMS_PAGE_QUERY = `
  query ProjectItemsPage($projectId: ID!, $cursor: String) {
    node(id: $projectId) {
      ... on ProjectV2 {
        items(first: 100, after: $cursor) {
          nodes {
            content {
              __typename
              ... on Issue {
                repository {
                  name
                  url
                  owner { login }
                }
              }
              ... on PullRequest {
                repository {
                  name
                  url
                  owner { login }
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
