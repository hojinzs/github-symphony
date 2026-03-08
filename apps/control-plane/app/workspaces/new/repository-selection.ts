export type AvailableRepository = {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  cloneUrl: string;
};

export function addRepositorySelection(
  selectedRepositoryIds: string[],
  repositoryId: string
): string[] {
  if (selectedRepositoryIds.includes(repositoryId)) {
    return selectedRepositoryIds;
  }

  return [...selectedRepositoryIds, repositoryId];
}

export function removeRepositorySelection(
  selectedRepositoryIds: string[],
  repositoryId: string
): string[] {
  return selectedRepositoryIds.filter((selectedId) => selectedId !== repositoryId);
}

export function filterRepositoryInventory(
  repositories: AvailableRepository[],
  selectedRepositoryIds: string[],
  query: string
): AvailableRepository[] {
  const selectedIds = new Set(selectedRepositoryIds);
  const normalizedQuery = query.trim().toLowerCase();

  return repositories.filter((repository) => {
    if (selectedIds.has(repository.id)) {
      return false;
    }

    if (normalizedQuery.length === 0) {
      return true;
    }

    return [repository.fullName, repository.cloneUrl, repository.owner, repository.name]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });
}

export function reconcileRepositorySelection(
  selectedRepositoryIds: string[],
  repositories: AvailableRepository[]
): {
  selectedRepositoryIds: string[];
  removedRepositoryIds: string[];
} {
  const availableIds = new Set(repositories.map((repository) => repository.id));
  const nextSelectedRepositoryIds = selectedRepositoryIds.filter((repositoryId) =>
    availableIds.has(repositoryId)
  );

  return {
    selectedRepositoryIds: nextSelectedRepositoryIds,
    removedRepositoryIds: selectedRepositoryIds.filter(
      (repositoryId) => !availableIds.has(repositoryId)
    )
  };
}

export function buildRepositoryInventoryErrorMessage(
  action: "load" | "refresh",
  message?: string
): string {
  if (message && message.trim().length > 0) {
    return message.trim();
  }

  return action === "load"
    ? "Could not load repositories from the configured machine-user PAT. Check setup and try again."
    : "Could not refresh the repository list. Check the configured machine-user PAT and try again.";
}

export function buildRepositorySelectionRefreshMessage(
  removedCount: number
): string {
  if (removedCount <= 0) {
    return "";
  }

  return removedCount === 1
    ? "A selected repository is no longer available. Review the selection before creating the workspace."
    : "Some selected repositories are no longer available. Review the selection before creating the workspace.";
}
