import { fingerprintGitHubToken } from "./github-auth";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_GRAPHQL_API_URL = `${GITHUB_API_URL}/graphql`;
const REPOSITORY_PAGE_SIZE = 100;

export class GitHubPatValidationError extends Error {
  constructor(
    message: string,
    readonly capability:
      | "authentication"
      | "owner_lookup"
      | "repository_inventory"
      | "project_access",
    readonly status?: number
  ) {
    super(message);
  }
}

export type ValidatedGitHubPat = {
  tokenFingerprint: string;
  actorId: string;
  actorLogin: string;
  validatedOwnerId: string;
  validatedOwnerLogin: string;
  validatedOwnerType: "Organization";
  validatedOwnerUrl: string | null;
};

export type GitHubPatRepository = {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  cloneUrl: string;
};

type GraphQLResponse<T> = {
  data?: T;
  errors?: Array<{ message?: string }>;
};

export async function validateGitHubPat(
  input: {
    token: string;
    ownerLogin: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<ValidatedGitHubPat> {
  const actor = await fetchGitHubPatActor(input.token, fetchImpl);
  const owner = await fetchGitHubOrganization(input.token, input.ownerLogin, fetchImpl);

  await ensureGitHubOrganizationRepositoryAccess(
    input.token,
    input.ownerLogin,
    fetchImpl
  );
  await ensureGitHubOrganizationProjectAccess(
    input.token,
    input.ownerLogin,
    fetchImpl
  );

  return {
    tokenFingerprint: fingerprintGitHubToken(input.token),
    actorId: actor.id,
    actorLogin: actor.login,
    validatedOwnerId: owner.id,
    validatedOwnerLogin: owner.login,
    validatedOwnerType: "Organization",
    validatedOwnerUrl: owner.url
  };
}

export async function listGitHubPatRepositories(
  token: string,
  ownerLogin: string,
  fetchImpl: typeof fetch = fetch
): Promise<GitHubPatRepository[]> {
  const repositories: GitHubPatRepository[] = [];
  let page = 1;

  while (true) {
    const response = await fetchImpl(
      `${GITHUB_API_URL}/orgs/${encodeURIComponent(
        ownerLogin
      )}/repos?per_page=${REPOSITORY_PAGE_SIZE}&page=${page}&type=all`,
      buildGitHubApiRequest(token)
    );

    if (!response.ok) {
      throw new GitHubPatValidationError(
        `GitHub repository inventory request failed with status ${response.status}.`,
        "repository_inventory",
        response.status
      );
    }

    const payload = (await response.json()) as Array<{
      id?: number;
      name?: string;
      full_name?: string;
      clone_url?: string;
      owner?: {
        login?: string;
      };
    }>;

    if (!Array.isArray(payload)) {
      throw new GitHubPatValidationError(
        "GitHub repository inventory response was incomplete.",
        "repository_inventory"
      );
    }

    repositories.push(
      ...payload.map((repository, index) => {
        if (
          !repository.id ||
          !repository.name ||
          !repository.full_name ||
          !repository.clone_url ||
          !repository.owner?.login
        ) {
          throw new GitHubPatValidationError(
            `GitHub repository inventory returned incomplete data for entry ${index + 1} on page ${page}.`,
            "repository_inventory"
          );
        }

        return {
          id: String(repository.id),
          owner: repository.owner.login,
          name: repository.name,
          fullName: repository.full_name,
          cloneUrl: repository.clone_url
        };
      })
    );

    if (payload.length < REPOSITORY_PAGE_SIZE) {
      break;
    }

    page += 1;
  }

  return repositories.sort((left, right) => left.fullName.localeCompare(right.fullName));
}

async function fetchGitHubPatActor(
  token: string,
  fetchImpl: typeof fetch
): Promise<{ id: string; login: string }> {
  const response = await fetchImpl(`${GITHUB_API_URL}/user`, buildGitHubApiRequest(token));

  if (!response.ok) {
    throw new GitHubPatValidationError(
      `GitHub PAT authentication failed with status ${response.status}.`,
      "authentication",
      response.status
    );
  }

  const payload = (await response.json()) as {
    id?: number;
    login?: string;
  };

  if (!payload.id || !payload.login) {
    throw new GitHubPatValidationError(
      "GitHub PAT authentication returned an incomplete actor profile.",
      "authentication"
    );
  }

  return {
    id: String(payload.id),
    login: payload.login
  };
}

async function fetchGitHubOrganization(
  token: string,
  ownerLogin: string,
  fetchImpl: typeof fetch
): Promise<{ id: string; login: string; url: string | null }> {
  const response = await fetchImpl(
    `${GITHUB_API_URL}/orgs/${encodeURIComponent(ownerLogin)}`,
    buildGitHubApiRequest(token)
  );

  if (!response.ok) {
    throw new GitHubPatValidationError(
      `GitHub organization lookup failed with status ${response.status}.`,
      "owner_lookup",
      response.status
    );
  }

  const payload = (await response.json()) as {
    id?: number;
    login?: string;
    html_url?: string;
    type?: string;
  };

  if (!payload.id || !payload.login || payload.type !== "Organization") {
    throw new GitHubPatValidationError(
      `GitHub owner "${ownerLogin}" is not an accessible organization.`,
      "owner_lookup"
    );
  }

  return {
    id: String(payload.id),
    login: payload.login,
    url: payload.html_url ?? null
  };
}

async function ensureGitHubOrganizationRepositoryAccess(
  token: string,
  ownerLogin: string,
  fetchImpl: typeof fetch
) {
  const response = await fetchImpl(
    `${GITHUB_API_URL}/orgs/${encodeURIComponent(ownerLogin)}/repos?per_page=1&type=all`,
    buildGitHubApiRequest(token)
  );

  if (!response.ok) {
    throw new GitHubPatValidationError(
      `GitHub repository inventory request failed with status ${response.status}.`,
      "repository_inventory",
      response.status
    );
  }
}

async function ensureGitHubOrganizationProjectAccess(
  token: string,
  ownerLogin: string,
  fetchImpl: typeof fetch
) {
  const response = await fetchImpl(GITHUB_GRAPHQL_API_URL, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "github-symphony"
    },
    body: JSON.stringify({
      query: VALIDATE_GITHUB_PAT_GRAPHQL,
      variables: {
        ownerLogin
      }
    })
  });

  if (!response.ok) {
    throw new GitHubPatValidationError(
      `GitHub project capability validation failed with status ${response.status}.`,
      "project_access",
      response.status
    );
  }

  const payload = (await response.json()) as GraphQLResponse<{
    viewer: { login: string } | null;
    organization: { id: string; login: string } | null;
  }>;

  if (payload.errors?.length) {
    throw new GitHubPatValidationError(
      payload.errors
        .map((error) => error.message)
        .filter((message): message is string => Boolean(message))
        .join("; ") || "GitHub project capability validation failed.",
      "project_access"
    );
  }

  if (!payload.data?.viewer?.login || !payload.data.organization?.id) {
    throw new GitHubPatValidationError(
      "GitHub project capability validation returned incomplete data.",
      "project_access"
    );
  }
}

function buildGitHubApiRequest(token: string): RequestInit {
  return {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "github-symphony"
    }
  };
}

const VALIDATE_GITHUB_PAT_GRAPHQL = `
  query ValidateGitHubPat($ownerLogin: String!) {
    viewer {
      login
    }
    organization(login: $ownerLogin) {
      id
      login
      projectsV2(first: 1) {
        totalCount
      }
    }
  }
`;
