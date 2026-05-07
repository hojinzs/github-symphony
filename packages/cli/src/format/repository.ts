import type { ProjectStatusSnapshot } from "@gh-symphony/core";

type LegacyStatusSnapshot = ProjectStatusSnapshot & {
  slug?: string;
};

export function formatRepositoryDisplay(
  snapshot: ProjectStatusSnapshot,
  fallback = "repository"
): string {
  if (snapshot.repository) {
    return `${snapshot.repository.owner}/${snapshot.repository.name}`;
  }

  return (snapshot as LegacyStatusSnapshot).slug ?? fallback;
}
