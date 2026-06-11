import type {
  WorkflowLifecycleConfig,
  WorkflowPriorityConfig,
} from "@gh-symphony/core";
import type { StateMapping } from "../config.js";
import type { DetectedEnvironment } from "../detection/environment-detector.js";
import { CLAUDE_RUNTIME_PROMPT_PREAMBLE } from "../prompts/runtime-claude-constraints.js";
import { DEFAULT_AFTER_CREATE_HOOK_PATH } from "./default-hooks.js";
import { buildRepositoryValidationGuidance } from "./repository-guidance.js";
import {
  buildRuntimeFrontMatter,
  isClaudeRuntime,
} from "./workflow-runtime.js";

export type GenerateWorkflowInput = {
  projectId: string;
  tracker?:
    | { kind: "github-project" }
    | {
        kind: "linear";
        endpoint?: string;
        apiKey?: string;
        projectSlug: string;
        pickupLabels?: {
          include?: string[];
          exclude?: string[];
        };
      };
  stateFieldName: string;
  priority: WorkflowPriorityConfig | null;
  includePriorityTemplates?: boolean;
  mappings: Record<string, StateMapping>;
  lifecycle: WorkflowLifecycleConfig;
  runtime: string;
  pollIntervalMs?: number;
  concurrency?: number;
  detectedEnvironment: Pick<
    DetectedEnvironment,
    | "packageManager"
    | "testCommand"
    | "lintCommand"
    | "buildCommand"
    | "monorepo"
  >;
};

export function generateWorkflowMarkdown(input: GenerateWorkflowInput): string {
  const frontMatter = buildFrontMatter(input);
  const promptBody = buildPromptBody(input);
  return `---\n${frontMatter}---\n${promptBody}\n`;
}

function buildFrontMatter(input: GenerateWorkflowInput): string {
  const lines: string[] = [];

  lines.push("tracker:");
  if (input.tracker?.kind === "linear") {
    lines.push("  kind: linear");
    lines.push(
      `  endpoint: ${input.tracker.endpoint ?? "https://api.linear.app/graphql"}`
    );
    lines.push(`  api_key: ${input.tracker.apiKey ?? "$LINEAR_API_KEY"}`);
    lines.push(`  project_slug: ${input.tracker.projectSlug}`);
  } else {
    lines.push("  kind: github-project");
    lines.push(`  project_id: ${input.projectId}`);
    lines.push(`  state_field: ${input.stateFieldName}`);
    lines.push(...buildPriorityFrontMatter(input));
  }

  if (input.lifecycle.activeStates.length > 0) {
    lines.push("  active_states:");
    for (const state of input.lifecycle.activeStates) {
      lines.push(`    - ${state}`);
    }
  }

  if (input.lifecycle.terminalStates.length > 0) {
    lines.push("  terminal_states:");
    for (const state of input.lifecycle.terminalStates) {
      lines.push(`    - ${state}`);
    }
  }

  if (input.tracker?.kind === "linear") {
    const include = input.tracker.pickupLabels?.include ?? [];
    const exclude = input.tracker.pickupLabels?.exclude ?? [];
    if (include.length > 0 || exclude.length > 0) {
      lines.push("  pickup_labels:");
      if (include.length > 0) {
        lines.push("    include:");
        for (const label of include) {
          lines.push(`      - ${label}`);
        }
      }
      if (exclude.length > 0) {
        lines.push("    exclude:");
        for (const label of exclude) {
          lines.push(`      - ${label}`);
        }
      }
    }
  }

  lines.push(
    ...buildStringListFrontMatter(
      "blocker_check_states",
      input.lifecycle.blockerCheckStates
    )
  );
  lines.push(
    ...buildStringListFrontMatter(
      "planning_states",
      input.lifecycle.planningStates
    )
  );

  lines.push("polling:");
  lines.push(`  interval_ms: ${input.pollIntervalMs ?? 30000}`);

  lines.push("workspace:");
  lines.push("  root: .runtime/symphony-workspaces");

  lines.push("hooks:");
  lines.push(`  after_create: ${DEFAULT_AFTER_CREATE_HOOK_PATH}`);

  lines.push("agent:");
  lines.push("  max_concurrent_agents: 10");
  lines.push("  max_retry_backoff_ms: 30000");
  lines.push("  retry_base_delay_ms: 10000");

  lines.push(...buildRuntimeFrontMatter(input.runtime));

  return lines.join("\n") + "\n";
}

function buildStringListFrontMatter(key: string, values: string[]): string[] {
  if (values.length === 0) {
    return [`  ${key}: []`];
  }

  return [`  ${key}:`, ...values.map((value) => `    - ${value}`)];
}

function buildPriorityFrontMatter(
  input: Pick<GenerateWorkflowInput, "priority" | "includePriorityTemplates">
): string[] {
  const lines: string[] = [];
  if (!input.priority) {
    return lines;
  }

  if (input.priority.source === "disabled") {
    lines.push(
      "  # Priority dispatch is disabled until an operator chooses one explicit source."
    );
  } else {
    lines.push(
      "  # Priority is explicit. Numbers below are editable policy (lower = higher priority)."
    );
  }
  lines.push(
    "  # See docs/adr/2026-05-18_explicit-dispatch-priority-mappings.md"
  );
  lines.push("  priority:");

  if (input.priority.source === "project-field") {
    lines.push("    source: project-field");
    lines.push(`    field: ${formatYamlScalar(input.priority.field)}`);
    lines.push("    values:");
    for (const [name, value] of Object.entries(input.priority.values)) {
      lines.push(`      ${formatYamlKey(name)}: ${value}`);
    }
    return lines;
  }

  if (input.priority.source === "labels") {
    lines.push("    source: labels");
    lines.push("    labels:");
    for (const [name, value] of Object.entries(input.priority.labels)) {
      lines.push(`      ${formatYamlKey(name)}: ${value}`);
    }
    return lines;
  }

  lines.push("    source: disabled");
  if (input.includePriorityTemplates) {
    lines.push("");
    lines.push("  # Optional template: project-field priority source.");
    lines.push("  # priority:");
    lines.push("  #   source: project-field");
    lines.push("  #   field: Priority");
    lines.push("  #   values:");
    lines.push("  #     Urgent: 0");
    lines.push("  #     High: 1");
    lines.push("");
    lines.push("  # Optional template: labels priority source.");
    lines.push("  # priority:");
    lines.push("  #   source: labels");
    lines.push("  #   labels:");
    lines.push("  #     P0: 0");
    lines.push("  #     P1: 1");
  }
  return lines;
}

function formatYamlScalar(value: string): string {
  return JSON.stringify(value);
}

function formatYamlKey(value: string): string {
  return JSON.stringify(value);
}

function buildPromptBody(input: GenerateWorkflowInput): string {
  const statusMap = generateStatusMapWithDescriptions(input.mappings);
  const validationGuidance = buildRepositoryValidationGuidance(
    input.detectedEnvironment
  );
  const runtimePreamble = buildRuntimePromptPreamble(input.runtime);
  const templateBody = `${statusMap}

## Agent Instructions

You are an AI coding agent working on issue {{issue.identifier}}: "{{issue.title}}".

**Repository:** {{issue.repository}}
**Current state:** {{issue.state}}

### Task

{{issue.description}}

### Default Posture

1. This is an unattended orchestration session. Do not ask humans for follow-up actions.
2. Only abort early if there is a genuine blocker (missing required credentials or secrets).
3. In your final message, report only what was completed and any blockers. Do not include "next steps".

### Repository Validation Guidance

${validationGuidance.map((line, index) => `${index + 1}. ${line}`).join("\n")}

### Workflow

1. Read the issue description and understand the requirements.
2. Explore the codebase to understand the relevant code structure.
3. Implement the changes following the project's coding conventions.
4. Write or update tests to cover the changes.
5. Verify that all existing tests pass.
6. Create a PR with a clear description of the changes.

### Guardrails

- Do not edit the issue body for planning or progress tracking.
- If the issue is in a terminal state, do nothing and exit.
- If you find out-of-scope improvements, open a separate issue rather than expanding the current scope.

### Workpad Template

Create a workpad comment on the issue with the following structure to track progress:

\`\`\`md
## Workpad

### Plan

- [ ] 1. Task item

### Acceptance Criteria

- [ ] Criterion 1

### Validation

- [ ] Test: \`command\`

### Notes

- Progress notes
\`\`\``;

  return [runtimePreamble, templateBody].filter(Boolean).join("\n\n");
}

function buildRuntimePromptPreamble(runtime: string): string {
  return isClaudeRuntime(runtime) ? CLAUDE_RUNTIME_PROMPT_PREAMBLE : "";
}

function generateStatusMapWithDescriptions(
  mappings: Record<string, StateMapping>
): string {
  const roleDescriptions: Record<string, string> = {
    active: "Agent starts work immediately",
    wait: "PR created, awaiting human review",
    terminal: "Completed, agent exits",
  };

  const lines: string[] = ["## Status Map", ""];

  for (const [columnName, mapping] of Object.entries(mappings)) {
    const rolePart = `[${mapping.role}]`;
    const goalPart = mapping.goal ? ` — ${mapping.goal}` : "";
    const descPart = roleDescriptions[mapping.role]
      ? ` *(${roleDescriptions[mapping.role]})*`
      : "";
    lines.push(`- **${columnName}** ${rolePart}${goalPart}${descPart}`);
  }

  return lines.join("\n");
}
