import { describe, expect, it } from "vitest";
import {
  addRepositorySelection,
  buildRepositoryInventoryErrorMessage,
  buildRepositorySelectionRefreshMessage,
  filterRepositoryInventory,
  reconcileRepositorySelection,
  removeRepositorySelection,
  type AvailableRepository
} from "./repository-selection";

const REPOSITORIES: AvailableRepository[] = [
  {
    id: "repo-1",
    owner: "acme",
    name: "platform",
    fullName: "acme/platform",
    cloneUrl: "https://github.com/acme/platform.git"
  },
  {
    id: "repo-2",
    owner: "acme",
    name: "design-system",
    fullName: "acme/design-system",
    cloneUrl: "https://github.com/acme/design-system.git"
  }
];

describe("repository selection state", () => {
  it("filters loaded repositories by query and excludes selected entries", () => {
    expect(filterRepositoryInventory(REPOSITORIES, ["repo-1"], "design")).toEqual([
      REPOSITORIES[1]
    ]);
  });

  it("adds and removes repository selections without duplication", () => {
    expect(addRepositorySelection(["repo-1"], "repo-2")).toEqual(["repo-1", "repo-2"]);
    expect(addRepositorySelection(["repo-1"], "repo-1")).toEqual(["repo-1"]);
    expect(removeRepositorySelection(["repo-1", "repo-2"], "repo-1")).toEqual(["repo-2"]);
  });

  it("reconciles stale selections after a repository refresh", () => {
    expect(reconcileRepositorySelection(["repo-1", "repo-3"], REPOSITORIES)).toEqual({
      selectedRepositoryIds: ["repo-1"],
      removedRepositoryIds: ["repo-3"]
    });
    expect(buildRepositorySelectionRefreshMessage(1)).toBe(
      "A selected repository is no longer available. Review the selection before creating the workspace."
    );
  });

  it("builds actionable repository loading and refresh errors", () => {
    expect(buildRepositoryInventoryErrorMessage("load")).toBe(
      "Could not load repositories from the configured machine-user PAT. Check setup and try again."
    );
    expect(buildRepositoryInventoryErrorMessage("refresh", "GitHub is temporarily unavailable.")).toBe(
      "GitHub is temporarily unavailable."
    );
  });
});
