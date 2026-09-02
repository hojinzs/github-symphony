import type {
  ParsedWorkflow,
  TrackedIssue,
  WorkflowDiagnostic,
  WorkflowPriorityConfig,
} from "@gh-symphony/core";
import type { ProjectDetail } from "./github/client.js";

export type PriorityDiagnostic = {
  title: string;
  summary: string;
  remediation?: string;
  details?: Record<string, unknown>;
};

export function buildStateConcurrencyDiagnostics(
  workflow: ParsedWorkflow
): PriorityDiagnostic[] {
  return workflow.diagnostics
    .filter(
      (diagnostic: WorkflowDiagnostic) =>
        diagnostic.code === "state_concurrency_entry_ignored"
    )
    .map((diagnostic) => ({
      title: "Ignored per-state concurrency entry",
      summary: `${diagnostic.path} is ignored: ${diagnostic.reason}.`,
      remediation: diagnostic.remediation,
      details: { path: diagnostic.path, reason: diagnostic.reason },
    }));
}

type RepositoryLabelSnapshot = {
  repository: string;
  labels: string[];
};

export function buildPriorityConfigDiagnostics(
  workflow: ParsedWorkflow
): PriorityDiagnostic[] {
  const diagnostics: PriorityDiagnostic[] = [];

  if (workflow.tracker.priorityFieldName) {
    if (workflow.tracker.priority) {
      diagnostics.push({
        title: "Priority mapping precedence",
        summary:
          "Both legacy tracker.priority_field and explicit tracker.priority are configured; explicit tracker.priority wins.",
        remediation:
          "Remove tracker.priority_field after confirming the explicit tracker.priority mapping is correct.",
        details: {
          priorityFieldName: workflow.tracker.priorityFieldName,
          explicitSource: workflow.tracker.priority.source,
        },
      });
    } else {
      diagnostics.push({
        title: "Legacy priority mapping",
        summary:
          "tracker.priority_field is deprecated and still supported with legacy Project option-order semantics.",
        remediation:
          "Migrate to tracker.priority with an explicit project-field, labels, or disabled source.",
        details: {
          priorityFieldName: workflow.tracker.priorityFieldName,
        },
      });
    }
  }

  return diagnostics;
}

/** Copyable migration guidance for doctor-only legacy workflow parsing. */
export function buildProviderDeprecationDiagnostics(
  workflow: ParsedWorkflow
): PriorityDiagnostic[] {
  if (workflow.tracker.deprecatedKeys.length === 0) {
    return [];
  }

  const providerKeys = [
    "project_id",
    "project_slug",
    "api_key",
    "endpoint",
    "state_field",
    "priority",
    "priority_field",
    "pickup_labels",
    "blocker_check_states",
    "planning_states",
  ];
  const migrated = providerKeys.filter((key) =>
    workflow.tracker.deprecatedKeys.includes(key)
  );
  if (migrated.length === 0) return [];

  const provider = Object.fromEntries(
    migrated.map((key) => [key, workflow.tracker.provider[key]])
  );
  const providerBlock = renderProviderBlock(provider);
  return [
    {
      title: "Deprecated tracker provider keys",
      summary: `Flat tracker key(s) ${migrated.join(", ")} are rejected in this major release.`,
      remediation: `Move them under tracker.provider:\n\n${providerBlock}`,
      details: { deprecatedKeys: migrated, providerBlock },
    },
  ];
}

function renderProviderBlock(provider: Record<string, unknown>): string {
  const lines = ["tracker:", "  provider:"];
  renderYamlObject(lines, provider, 4);
  return ["```yaml", ...lines, "```"].join("\n");
}

function renderYamlObject(
  lines: string[],
  value: Record<string, unknown>,
  indent: number
): void {
  for (const [key, entry] of Object.entries(value)) {
    const padding = " ".repeat(indent);
    if (Array.isArray(entry)) {
      if (entry.length === 0) {
        lines.push(`${padding}${key}: []`);
      } else {
        lines.push(`${padding}${key}:`);
        for (const item of entry) {
          lines.push(`${padding}  - ${renderYamlScalar(item)}`);
        }
      }
    } else if (entry && typeof entry === "object") {
      lines.push(`${padding}${key}:`);
      renderYamlObject(lines, entry as Record<string, unknown>, indent + 2);
    } else {
      lines.push(`${padding}${key}: ${renderYamlScalar(entry)}`);
    }
  }
}

function renderYamlScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

export function buildPriorityDriftDiagnostics(input: {
  workflow: ParsedWorkflow;
  projectDetail: ProjectDetail;
  repositoryLabels: RepositoryLabelSnapshot[] | null;
  activeIssues: TrackedIssue[];
}): PriorityDiagnostic[] {
  const priority = input.workflow.tracker.priority;
  if (!priority || priority.source === "disabled") {
    return [];
  }

  if (priority.source === "project-field") {
    return buildProjectFieldDriftDiagnostics({
      priority,
      projectDetail: input.projectDetail,
      activeIssues: input.activeIssues,
    });
  }

  return buildLabelDriftDiagnostics({
    priority,
    repositoryLabels: input.repositoryLabels,
    activeIssues: input.activeIssues,
  });
}

function buildProjectFieldDriftDiagnostics(input: {
  priority: Extract<WorkflowPriorityConfig, { source: "project-field" }>;
  projectDetail: ProjectDetail;
  activeIssues: TrackedIssue[];
}): PriorityDiagnostic[] {
  const diagnostics: PriorityDiagnostic[] = [];
  const field = input.projectDetail.statusFields.find(
    (candidate) => candidate.name === input.priority.field
  );

  if (!field) {
    diagnostics.push({
      title: "Priority Project field drift",
      summary: `Configured priority field "${input.priority.field}" was not found in the GitHub Project schema.`,
      remediation:
        "Update tracker.priority.field to the exact live Project V2 single-select field name, or disable priority mapping.",
      details: {
        field: input.priority.field,
        availableFields: input.projectDetail.statusFields.map(
          (candidate) => candidate.name
        ),
      },
    });
    return diagnostics;
  }

  const liveOptions = new Set(field.options.map((option) => option.name));
  const mappedOptions = new Set(Object.keys(input.priority.values));
  const unmappedLiveOptions = [...liveOptions].filter(
    (option) => !mappedOptions.has(option)
  );
  const missingConfiguredOptions = [...mappedOptions].filter(
    (option) => !liveOptions.has(option)
  );

  if (unmappedLiveOptions.length > 0) {
    diagnostics.push({
      title: "Unmapped priority Project options",
      summary: `Priority field "${field.name}" has live option(s) not mapped in tracker.priority.values: ${unmappedLiveOptions.join(", ")}.`,
      remediation:
        "Add explicit numeric mappings for these options or accept that issues holding them resolve to priority = null.",
      details: { field: field.name, unmappedLiveOptions },
    });
  }

  if (missingConfiguredOptions.length > 0) {
    diagnostics.push({
      title: "Missing priority Project options",
      summary: `tracker.priority.values references option(s) that do not exist in priority field "${field.name}": ${missingConfiguredOptions.join(", ")}.`,
      remediation:
        "Rename the mapping keys to match live Project option display names or remove stale mappings.",
      details: { field: field.name, missingConfiguredOptions },
    });
  }

  const activeUnmapped = input.activeIssues.flatMap((issue) => {
    const rawValue = issue.metadata?.[field.name];
    return typeof rawValue === "string" &&
      rawValue.length > 0 &&
      !mappedOptions.has(rawValue)
      ? [{ issue: issue.identifier, value: rawValue }]
      : [];
  });
  if (activeUnmapped.length > 0) {
    diagnostics.push({
      title: "Active issues with unmapped priority values",
      summary: `Active issue(s) currently hold unmapped "${field.name}" value(s); they resolve to priority = null.`,
      remediation:
        "Map the live value in tracker.priority.values, change the issue value, or leave it unmapped intentionally.",
      details: { field: field.name, activeUnmapped },
    });
  }

  return diagnostics;
}

function buildLabelDriftDiagnostics(input: {
  priority: Extract<WorkflowPriorityConfig, { source: "labels" }>;
  repositoryLabels: RepositoryLabelSnapshot[] | null;
  activeIssues: TrackedIssue[];
}): PriorityDiagnostic[] {
  const diagnostics: PriorityDiagnostic[] = [];
  const configuredLabels = Object.keys(input.priority.labels);
  if (input.repositoryLabels) {
    const missingByRepository = input.repositoryLabels.flatMap((snapshot) => {
      const live = new Set(snapshot.labels);
      const missing = configuredLabels.filter((label) => !live.has(label));
      return missing.length > 0
        ? [{ repository: snapshot.repository, missing }]
        : [];
    });

    if (missingByRepository.length > 0) {
      diagnostics.push({
        title: "Missing configured priority labels",
        summary:
          "One or more configured tracker.priority.labels entries are absent from linked repositories.",
        remediation:
          "Create the labels in each linked repository, rename the mapping keys to exact live labels, or remove stale mappings.",
        details: { missingByRepository },
      });
    }

    const liveLabels = new Set(
      input.repositoryLabels.flatMap((snapshot) => snapshot.labels)
    );
    const missingEverywhere = configuredLabels.filter(
      (label) => !liveLabels.has(label)
    );
    if (missingEverywhere.length > 0) {
      diagnostics.push({
        title: "Stale priority label mappings",
        summary: `tracker.priority.labels references label(s) that do not exist in any linked repository: ${missingEverywhere.join(", ")}.`,
        remediation:
          "Rename the mapping keys to exact live labels, create those labels, or remove stale mappings.",
        details: { missingEverywhere },
      });
    }
  }

  const configuredLabelByNormalized = new Map(
    configuredLabels.map((label) => [normalizeLabelForComparison(label), label])
  );
  const activeConflicts = input.activeIssues.flatMap((issue) => {
    const matches = issue.labels.flatMap((label) => {
      const configuredLabel = configuredLabelByNormalized.get(
        normalizeLabelForComparison(label)
      );
      return configuredLabel ? [configuredLabel] : [];
    });
    return matches.length > 1
      ? [{ issue: issue.identifier, labels: matches }]
      : [];
  });
  if (activeConflicts.length > 0) {
    diagnostics.push({
      title: "Active issues with multiple priority labels",
      summary:
        "Active issue(s) have multiple configured priority labels; runtime chooses the lowest numeric value and emits priority.label_conflict_resolved.",
      remediation:
        "Remove extra priority labels from the issue if only one priority label should apply.",
      details: { activeConflicts },
    });
  }

  const activeUnmapped = input.activeIssues.flatMap((issue) => {
    const labels = issue.labels.filter(
      (label) =>
        isPriorityLikeLabel(label) &&
        !configuredLabelByNormalized.has(normalizeLabelForComparison(label))
    );
    return labels.length > 0 ? [{ issue: issue.identifier, labels }] : [];
  });
  if (activeUnmapped.length > 0) {
    diagnostics.push({
      title: "Active issues with unmapped priority labels",
      summary:
        "Active issue(s) have priority-like labels not mapped by tracker.priority.labels; those labels do not affect dispatch priority.",
      remediation:
        "Add explicit mappings for these labels, rename the issue labels, or leave them unmapped intentionally.",
      details: { activeUnmapped },
    });
  }

  return diagnostics;
}

function isPriorityLikeLabel(label: string): boolean {
  return /^(p\d+|priority[:/\s_-].+|prio[:/\s_-].+)$/i.test(label.trim());
}

function normalizeLabelForComparison(label: string): string {
  return label.trim().toLowerCase();
}
