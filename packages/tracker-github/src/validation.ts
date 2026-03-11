import type { WorkflowLifecycleConfig } from "@gh-symphony/core";
import type { GitHubTrackedIssue } from "./adapter.js";

type RepositoryAlias = {
  owner: string;
  name: string;
};

type FieldMappingValidationError = {
  phase: string;
  expectedState: string;
  message: string;
};

export type FieldMappingValidationResult = {
  valid: boolean;
  errors: FieldMappingValidationError[];
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
  const requiredStatesByPhase: Array<{
    phase: string;
    states: readonly string[];
  }> = [
    { phase: "planning", states: options.lifecycle.planningStates },
    { phase: "human-review", states: options.lifecycle.humanReviewStates },
    { phase: "implementation", states: options.lifecycle.implementationStates },
    { phase: "awaiting-merge", states: options.lifecycle.awaitingMergeStates },
    { phase: "completed", states: options.lifecycle.completedStates },
    {
      phase: "planning-complete",
      states: [options.lifecycle.planningCompleteState],
    },
    {
      phase: "implementation-complete",
      states: [options.lifecycle.implementationCompleteState],
    },
    {
      phase: "merge-complete",
      states: [options.lifecycle.mergeCompleteState],
    },
  ];

  const errors: FieldMappingValidationError[] = [];

  for (const { phase, states } of requiredStatesByPhase) {
    for (const expectedState of states) {
      if (normalizedAvailableOptions.has(normalize(expectedState))) {
        continue;
      }

      errors.push({
        phase,
        expectedState,
        message: `Missing status option "${expectedState}" required for workflow phase "${phase}".`,
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
