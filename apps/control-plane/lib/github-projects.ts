const GITHUB_GRAPHQL_API_URL = "https://api.github.com/graphql";

export type WorkspaceProject = {
  id: string;
  number: number;
  title: string;
  url: string;
};

export type WorkspaceIssue = {
  id: string;
  number: number;
  url: string;
  projectItemId: string;
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message: string }>;
};

export class GitHubGraphQLError extends Error {}

export async function createWorkspaceProject(
  token: string,
  input: {
    ownerLogin: string;
    title: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<WorkspaceProject> {
  const ownerId = await resolveOwnerId(token, input.ownerLogin, fetchImpl);

  const payload = await executeGitHubGraphQL<{
    createProjectV2: {
      projectV2: WorkspaceProject;
    };
  }>(
    token,
    CREATE_PROJECT_MUTATION,
    {
      ownerId,
      title: input.title
    },
    fetchImpl
  );

  return payload.createProjectV2.projectV2;
}

export async function createWorkspaceIssue(
  token: string,
  input: {
    repositoryOwner: string;
    repositoryName: string;
    projectId: string;
    title: string;
    body: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<WorkspaceIssue> {
  const repositoryId = await resolveRepositoryId(
    token,
    input.repositoryOwner,
    input.repositoryName,
    fetchImpl
  );

  const issuePayload = await executeGitHubGraphQL<{
    createIssue: {
      issue: {
        id: string;
        number: number;
        url: string;
      };
    };
  }>(
    token,
    CREATE_ISSUE_MUTATION,
    {
      repositoryId,
      title: input.title,
      body: input.body
    },
    fetchImpl
  );

  const issue = issuePayload.createIssue.issue;

  const projectPayload = await executeGitHubGraphQL<{
    addProjectV2ItemById: {
      item: {
        id: string;
      };
    };
  }>(
    token,
    ADD_ITEM_TO_PROJECT_MUTATION,
    {
      projectId: input.projectId,
      contentId: issue.id
    },
    fetchImpl
  );

  return {
    ...issue,
    projectItemId: projectPayload.addProjectV2ItemById.item.id
  };
}

async function resolveOwnerId(
  token: string,
  ownerLogin: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const payload = await executeGitHubGraphQL<{
    user: { id: string } | null;
    organization: { id: string } | null;
  }>(
    token,
    RESOLVE_OWNER_QUERY,
    {
      login: ownerLogin
    },
    fetchImpl
  );

  const ownerId = payload.user?.id ?? payload.organization?.id;

  if (!ownerId) {
    throw new GitHubGraphQLError(`GitHub owner not found for login "${ownerLogin}".`);
  }

  return ownerId;
}

async function resolveRepositoryId(
  token: string,
  owner: string,
  name: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const payload = await executeGitHubGraphQL<{
    repository: { id: string } | null;
  }>(
    token,
    RESOLVE_REPOSITORY_QUERY,
    {
      owner,
      name
    },
    fetchImpl
  );

  if (!payload.repository?.id) {
    throw new GitHubGraphQLError(`Repository not found for ${owner}/${name}.`);
  }

  return payload.repository.id;
}

async function executeGitHubGraphQL<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch
): Promise<T> {
  const response = await fetchImpl(GITHUB_GRAPHQL_API_URL, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "github-symphony"
    },
    body: JSON.stringify({
      query,
      variables
    })
  });

  if (!response.ok) {
    throw new GitHubGraphQLError(
      `GitHub GraphQL request failed with status ${response.status}.`
    );
  }

  const payload = (await response.json()) as GraphQLResponse<T>;

  if (payload.errors?.length) {
    throw new GitHubGraphQLError(
      payload.errors.map((error) => error.message).join("; ")
    );
  }

  if (!payload.data) {
    throw new GitHubGraphQLError("GitHub GraphQL response did not include data.");
  }

  return payload.data;
}

const RESOLVE_OWNER_QUERY = `
  query ResolveOwner($login: String!) {
    user(login: $login) {
      id
    }
    organization(login: $login) {
      id
    }
  }
`;

const CREATE_PROJECT_MUTATION = `
  mutation CreateProject($ownerId: ID!, $title: String!) {
    createProjectV2(input: { ownerId: $ownerId, title: $title }) {
      projectV2 {
        id
        number
        title
        url
      }
    }
  }
`;

const RESOLVE_REPOSITORY_QUERY = `
  query ResolveRepository($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      id
    }
  }
`;

const CREATE_ISSUE_MUTATION = `
  mutation CreateIssue($repositoryId: ID!, $title: String!, $body: String!) {
    createIssue(input: { repositoryId: $repositoryId, title: $title, body: $body }) {
      issue {
        id
        number
        url
      }
    }
  }
`;

const ADD_ITEM_TO_PROJECT_MUTATION = `
  mutation AddProjectItem($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item {
        id
      }
    }
  }
`;
