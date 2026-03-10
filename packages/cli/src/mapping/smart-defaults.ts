import type { WorkflowLifecycleConfig } from "@github-symphony/core";
import type { ColumnRole, HumanReviewMode } from "../config.js";

// ── 3.1: Smart defaults pattern matching ─────────────────────────────────────

const ROLE_PATTERNS: Array<{ role: ColumnRole; pattern: RegExp }> = [
  {
    role: "trigger",
    pattern: /^(todo|to.do|to-do|ready|queued|open|new|triage)$/i,
  },
  {
    role: "working",
    pattern:
      /^(in.progress|working|active|doing|in.development|developing|wip)$/i,
  },
  {
    role: "human-review",
    pattern:
      /^(review|in.review|pr.review|needs.review|plan.review|awaiting.review|code.review)$/i,
  },
  {
    role: "done",
    pattern: /^(done|completed?|closed|merged|shipped|resolved|finished)$/i,
  },
  {
    role: "ignored",
    pattern:
      /^(icebox|someday|later|blocked|on.hold|paused|won.?t.do|cancelled|deferred|draft|backlog)$/i,
  },
];

export type ColumnMapping = {
  columnName: string;
  role: ColumnRole | null;
  confidence: "high" | "low";
};

export function inferColumnRole(columnName: string): ColumnMapping {
  const normalized = columnName.trim();

  for (const { role, pattern } of ROLE_PATTERNS) {
    if (pattern.test(normalized)) {
      return { columnName: normalized, role, confidence: "high" };
    }
  }

  return { columnName: normalized, role: null, confidence: "low" };
}

export function inferAllColumnRoles(columnNames: string[]): ColumnMapping[] {
  return columnNames.map(inferColumnRole);
}

// ── 3.2: Human-review mode logic ─────────────────────────────────────────────

export type PhaseMapping = {
  planningStates: string[];
  humanReviewStates: string[];
  implementationStates: string[];
  awaitingMergeStates: string[];
  completedStates: string[];
};

/**
 * Map column roles to Symphony execution phases based on the human-review mode.
 *
 * Modes:
 * - plan-and-pr: Human reviews both plans and PRs (full review pipeline)
 * - plan-only: Human reviews plans, PRs auto-merge
 * - pr-only: No plan review, human reviews PRs
 * - none: No human review at all (full auto)
 */
export function buildPhaseMapping(
  roles: Record<string, ColumnRole>,
  mode: HumanReviewMode
): PhaseMapping {
  const planningStates: string[] = [];
  const humanReviewStates: string[] = [];
  const implementationStates: string[] = [];
  const awaitingMergeStates: string[] = [];
  const completedStates: string[] = [];

  for (const [columnName, role] of Object.entries(roles)) {
    switch (role) {
      case "trigger":
        planningStates.push(columnName);
        break;
      case "working":
        implementationStates.push(columnName);
        break;
      case "human-review":
        switch (mode) {
          case "plan-and-pr":
            humanReviewStates.push(columnName);
            break;
          case "plan-only":
            humanReviewStates.push(columnName);
            break;
          case "pr-only":
            awaitingMergeStates.push(columnName);
            break;
          case "none":
            // In "none" mode, review columns are treated as implementation
            implementationStates.push(columnName);
            break;
        }
        break;
      case "done":
        completedStates.push(columnName);
        break;
      case "ignored":
        // Ignored columns don't map to any phase
        break;
    }
  }

  return {
    planningStates,
    humanReviewStates,
    implementationStates,
    awaitingMergeStates,
    completedStates,
  };
}

// ── 3.3: Mapping → WorkflowLifecycleConfig conversion ───────────────────────

export function toWorkflowLifecycleConfig(
  stateFieldName: string,
  roles: Record<string, ColumnRole>,
  mode: HumanReviewMode
): WorkflowLifecycleConfig {
  const phases = buildPhaseMapping(roles, mode);

  // Transition targets: where issues move when a phase completes
  const planningCompleteState = resolveTransitionTarget(
    phases,
    "planning",
    mode
  );
  const implementationCompleteState = resolveTransitionTarget(
    phases,
    "implementation",
    mode
  );
  const mergeCompleteState =
    phases.completedStates[0] ?? phases.awaitingMergeStates[0] ?? "Done";

  return {
    stateFieldName,
    planningStates: phases.planningStates,
    humanReviewStates: phases.humanReviewStates,
    implementationStates: phases.implementationStates,
    awaitingMergeStates: phases.awaitingMergeStates,
    completedStates: phases.completedStates,
    planningCompleteState,
    implementationCompleteState,
    mergeCompleteState,
  };
}

function resolveTransitionTarget(
  phases: PhaseMapping,
  fromPhase: "planning" | "implementation",
  mode: HumanReviewMode
): string {
  if (fromPhase === "planning") {
    // After planning: go to human-review (if exists) or implementation
    if (
      (mode === "plan-and-pr" || mode === "plan-only") &&
      phases.humanReviewStates.length > 0
    ) {
      return phases.humanReviewStates[0]!;
    }
    return phases.implementationStates[0] ?? "In Progress";
  }

  // After implementation: go to awaiting-merge (if exists) or completed
  if (
    (mode === "plan-and-pr" || mode === "pr-only") &&
    phases.awaitingMergeStates.length > 0
  ) {
    return phases.awaitingMergeStates[0]!;
  }
  return phases.completedStates[0] ?? "Done";
}

// ── 3.4: Mapping validation ─────────────────────────────────────────────────

export type MappingValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export function validateMapping(
  roles: Record<string, ColumnRole>
): MappingValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const roleEntries = Object.entries(roles);
  const triggerColumns = roleEntries.filter(([, r]) => r === "trigger");
  const workingColumns = roleEntries.filter(([, r]) => r === "working");
  const doneColumns = roleEntries.filter(([, r]) => r === "done");
  const reviewColumns = roleEntries.filter(([, r]) => r === "human-review");

  // Required roles
  if (triggerColumns.length === 0) {
    errors.push(
      "Missing required role: 'trigger' — at least one column must trigger work."
    );
  }
  if (workingColumns.length === 0) {
    errors.push(
      "Missing required role: 'working' — at least one column must represent active work."
    );
  }
  if (doneColumns.length === 0) {
    errors.push(
      "Missing required role: 'done' — at least one column must represent completion."
    );
  }

  // Warnings for unusual setups
  if (triggerColumns.length > 1) {
    warnings.push(
      `Multiple trigger columns: ${triggerColumns.map(([n]) => n).join(", ")}. ` +
        "All will be treated as planning states."
    );
  }
  if (doneColumns.length > 1) {
    warnings.push(
      `Multiple done columns: ${doneColumns.map(([n]) => n).join(", ")}. ` +
        "All will be treated as completed states."
    );
  }
  if (reviewColumns.length > 2) {
    warnings.push(
      `${reviewColumns.length} review columns detected. ` +
        "Consider simplifying to one or two review stages."
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}
