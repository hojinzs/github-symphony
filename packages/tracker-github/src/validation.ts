import type { WorkflowLifecycleConfig } from "@gh-symphony/core";
import type { GitHubTrackedIssue } from "./adapter.js";

type RepositoryAlias = {
  owner: string;
  name: string;
};

type StateValidationError = {
  state: string;
  category: "active" | "terminal" | "blocker_check";
  message: string;
};

export type FieldMappingValidationResult = {
  valid: boolean;
  errors: StateValidationError[];
};

export type PlacementIntegrityResult = Array<{
  issueId: string;
  issueIdentifier: string;
  duplicateItemIds: string[];
}>;

export type RebindRequirement = {
  issueId: string;
  issueIdentifier: string;
  previousRepository: {
    owner: string;
    name: string;
  };
  currentRepository: {
    owner: string;
    name: string;
  };
  reason: string;
} | null;

export function validateWorkflowFieldMapping(options: {
  lifecycle: WorkflowLifecycleConfig;
  availableOptions: string[];
}): FieldMappingValidationResult {
  const normalizedAvailableOptions = new Set(
    options.availableOptions.map((option) => normalize(option))
  );

  const stateCategories: Array<{
    category: "active" | "terminal" | "blocker_check";
    states: readonly string[];
  }> = [
    { category: "active", states: options.lifecycle.activeStates },
    { category: "terminal", states: options.lifecycle.terminalStates },
    { category: "blocker_check", states: options.lifecycle.blockerCheckStates },
  ];

  const errors: StateValidationError[] = [];

  for (const { category, states } of stateCategories) {
    for (const expectedState of states) {
      if (normalizedAvailableOptions.has(normalize(expectedState))) {
        continue;
      }

      errors.push({
        state: expectedState,
        category,
        message: `Missing status option "${expectedState}" required for ${category} states.`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function detectDuplicatePlacements(
  issues: GitHubTrackedIssue[]
): PlacementIntegrityResult {
  const placementsByIssueId = new Map<string, GitHubTrackedIssue[]>();

  for (const issue of issues) {
    const placements = placementsByIssueId.get(issue.id);

    if (placements) {
      placements.push(issue);
      continue;
    }

    placementsByIssueId.set(issue.id, [issue]);
  }

  const duplicates: PlacementIntegrityResult = [];

  for (const [issueId, placements] of placementsByIssueId) {
    if (placements.length < 2) {
      continue;
    }

    duplicates.push({
      issueId,
      issueIdentifier: placements[0]?.identifier ?? issueId,
      duplicateItemIds: placements.map((placement) => placement.tracker.itemId),
    });
  }

  return duplicates;
}

export function detectTransferRebindRequired(
  issue: GitHubTrackedIssue,
  knownAliases: RepositoryAlias | RepositoryAlias[]
): RebindRequirement {
  const aliases = Array.isArray(knownAliases) ? knownAliases : [knownAliases];
  const currentRepository = {
    owner: issue.repository.owner,
    name: issue.repository.name,
  };

  const hasKnownAliasMatch = aliases.some(
    (alias) =>
      normalize(alias.owner) === normalize(currentRepository.owner) &&
      normalize(alias.name) === normalize(currentRepository.name)
  );

  if (hasKnownAliasMatch) {
    return null;
  }

  const previousRepository = aliases[0];

  if (!previousRepository) {
    return null;
  }

  return {
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    previousRepository,
    currentRepository,
    reason:
      "Issue repository metadata no longer matches known tracker aliases.",
  };
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}
