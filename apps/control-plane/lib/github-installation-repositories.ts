import {
  listGitHubPatRepositories
} from "./github-pat-api";
import {
  getProjectGitHubCredentials,
} from "./github-user-broker";

const STALE_SELECTION_ERROR =
  "One or more selected repositories are no longer available to the configured machine-user PAT. Refresh the repository list and try again.";

export type GitHubInstallationRepository = {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  cloneUrl: string;
};

export async function listGitHubInstallationRepositories(
  dependencies: {
    fetchImpl?: typeof fetch;
    credentialBroker?: typeof getProjectGitHubCredentials;
  } = {}
): Promise<GitHubInstallationRepository[]> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const credentialBroker =
    dependencies.credentialBroker ?? getProjectGitHubCredentials;
  const credentials = await credentialBroker({
    fetchImpl
  });

  return listGitHubPatRepositories(
    credentials.token,
    credentials.ownerLogin,
    fetchImpl
  );
}

export async function resolveGitHubInstallationRepositorySelection(
  repositoryIds: string[],
  dependencies: {
    fetchImpl?: typeof fetch;
    credentialBroker?: typeof getProjectGitHubCredentials;
  } = {}
): Promise<GitHubInstallationRepository[]> {
  const requestedIds = uniqueRepositoryIds(repositoryIds);
  const repositories = await listGitHubInstallationRepositories(dependencies);
  const repositoriesById = new Map(
    repositories.map((repository) => [repository.id, repository] as const)
  );
  const selectedRepositories = requestedIds.map((repositoryId) =>
    repositoriesById.get(repositoryId)
  );

  if (selectedRepositories.some((repository) => !repository)) {
    throw new Error(STALE_SELECTION_ERROR);
  }

  return selectedRepositories as GitHubInstallationRepository[];
}

export function getStaleRepositorySelectionError(): string {
  return STALE_SELECTION_ERROR;
}

function uniqueRepositoryIds(repositoryIds: string[]): string[] {
  return [...new Set(repositoryIds)];
}
