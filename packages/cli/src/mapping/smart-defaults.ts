import type { WorkflowLifecycleConfig } from "@gh-symphony/core";
import type { StateRole, StateMapping } from "../config.js";

// ── 3.1: Smart defaults pattern matching ─────────────────────────────────────

const ROLE_PATTERNS: Array<{ role: StateRole; pattern: RegExp }> = [
  {
    role: "active",
    pattern:
      /^(todo|to.do|to-do|ready|queued|open|new|triage|in.progress|working|active|doing|in.development|developing|wip)$/i,
  },
  {
    role: "wait",
    pattern:
      /^(review|in.review|pr.review|needs.review|plan.review|awaiting.review|code.review|icebox|someday|later|blocked|on.hold|paused|deferred|draft|backlog)$/i,
  },
  {
    role: "terminal",
    pattern:
      /^(done|completed?|closed|merged|shipped|resolved|finished|won.?t.do|cancelled)$/i,
  },
];

export type StateRoleMapping = {
  columnName: string;
  role: StateRole | null;
  confidence: "high" | "low";
};

export function inferStateRole(columnName: string): StateRoleMapping {
  const normalized = columnName.trim();

  for (const { role, pattern } of ROLE_PATTERNS) {
    if (pattern.test(normalized)) {
      return { columnName: normalized, role, confidence: "high" };
    }
  }

  return { columnName: normalized, role: null, confidence: "low" };
}

export function inferAllStateRoles(columnNames: string[]): StateRoleMapping[] {
  return columnNames.map(inferStateRole);
}

// ── 3.2: Mapping → WorkflowLifecycleConfig conversion ───────────────────────

export function toWorkflowLifecycleConfig(
  stateFieldName: string,
  mappings: Record<string, StateMapping>
): WorkflowLifecycleConfig {
  const activeStates: string[] = [];
  const terminalStates: string[] = [];
  const blockerCheckStates: string[] = [];

  for (const [columnName, mapping] of Object.entries(mappings)) {
    switch (mapping.role) {
      case "active":
        activeStates.push(columnName);
        break;
      case "terminal":
        terminalStates.push(columnName);
        break;
      case "wait":
        // Wait states are neither active nor terminal
        break;
    }
  }

  // Default blocker check: first active state (typically "Todo"-like)
  if (activeStates.length > 0) {
    blockerCheckStates.push(activeStates[0]!);
  }

  return {
    stateFieldName,
    activeStates,
    terminalStates,
    blockerCheckStates,
  };
}

// ── 3.4: Mapping validation ─────────────────────────────────────────────────

export type MappingValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

export function validateStateMapping(
  mappings: Record<string, StateMapping>
): MappingValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const entries = Object.entries(mappings);
  const activeEntries = entries.filter(([, m]) => m.role === "active");
  const terminalEntries = entries.filter(([, m]) => m.role === "terminal");

  // Required: at least one active and one terminal
  if (activeEntries.length === 0) {
    errors.push(
      "Missing required role: 'active' — at least one state must be active."
    );
  }
  if (terminalEntries.length === 0) {
    errors.push(
      "Missing required role: 'terminal' — at least one state must be terminal."
    );
  }

  // Warnings
  if (terminalEntries.length > 1) {
    warnings.push(
      `Multiple terminal states: ${terminalEntries.map(([n]) => n).join(", ")}. ` +
        "All will be treated as terminal states."
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── 3.5: Status Map generation ──────────────────────────────────────────────

export function generateStatusMap(
  mappings: Record<string, StateMapping>
): string {
  const lines: string[] = ["## Status Map", ""];

  for (const [columnName, mapping] of Object.entries(mappings)) {
    const rolePart = `[${mapping.role}]`;
    const goalPart = mapping.goal ? ` — ${mapping.goal}` : "";
    lines.push(`- **${columnName}** ${rolePart}${goalPart}`);
  }

  return lines.join("\n");
}
