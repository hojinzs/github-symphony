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
  DEFAULT_CLAUDE_PRINT_ARGS,
  DEFAULT_CODEX_APP_SERVER_ARGS,
  isClaudeRuntime,
  normalizeInitRuntime,
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
  lifecycle: WorkflowLifecycleConfig & { blockerCheckStates?: string[] };
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

type YamlFrontMatterNode =
  | string
  | number
  | boolean
  | null
  | YamlQuotedString
  | YamlFrontMatterNode[]
  | { [key: string]: YamlFrontMatterNode };

type YamlQuotedString = {
  readonly __yamlQuotedString: true;
  readonly value: string;
};

function buildFrontMatter(input: GenerateWorkflowInput): string {
  const tracker = buildTrackerFrontMatter(input);
  const restFrontMatter: Record<string, YamlFrontMatterNode> = {
    polling: {
      interval_ms: input.pollIntervalMs ?? 30000,
    },
    workspace: {
      root: ".runtime/symphony-workspaces",
    },
    hooks: {
      after_create: DEFAULT_AFTER_CREATE_HOOK_PATH,
    },
    agent: {
      max_concurrent_agents: 10,
      max_retry_backoff_ms: 30000,
      retry_base_delay_ms: 10000,
    },
    runtime: buildRuntimeFrontMatterConfig(input.runtime),
  };

  return `${stringifyYamlFrontMatter({ tracker })}${buildTrackerFrontMatterComments(input)}${stringifyYamlFrontMatter(restFrontMatter)}`;
}

function buildTrackerFrontMatter(
  input: GenerateWorkflowInput
): Record<string, YamlFrontMatterNode> {
  const provider: Record<string, YamlFrontMatterNode> = {};
  const tracker: Record<string, YamlFrontMatterNode> = {
    kind: input.tracker?.kind ?? "github-project",
  };
  if (input.tracker?.kind === "linear") {
    provider.endpoint =
      input.tracker.endpoint ?? "https://api.linear.app/graphql";
    provider.api_key = input.tracker.apiKey ?? "$LINEAR_API_KEY";
    provider.project_slug = input.tracker.projectSlug;
  } else {
    provider.project_id = input.projectId;
    provider.state_field = input.stateFieldName;
    const priority = buildPriorityFrontMatter(input);
    if (priority) {
      provider.priority = priority;
    }
  }

  if (input.lifecycle.activeStates.length > 0) {
    tracker.active_states = input.lifecycle.activeStates;
  }

  if (input.lifecycle.terminalStates.length > 0) {
    tracker.terminal_states = input.lifecycle.terminalStates;
  }

  tracker.provider = provider;

  if (input.tracker?.kind === "linear") {
    const include = input.tracker.pickupLabels?.include ?? [];
    const exclude = input.tracker.pickupLabels?.exclude ?? [];
    if (include.length > 0 || exclude.length > 0) {
      const pickupLabels: Record<string, YamlFrontMatterNode> = {};
      if (include.length > 0) {
        pickupLabels.include = include;
      }
      if (exclude.length > 0) {
        pickupLabels.exclude = exclude;
      }
      provider.pickup_labels = pickupLabels;
    }
  }

  provider.blocker_check_states = input.lifecycle.blockerCheckStates ?? [];
  provider.planning_states = input.lifecycle.planningStates;

  return tracker;
}

function buildRuntimeFrontMatterConfig(
  runtime: string
): Record<string, YamlFrontMatterNode> {
  const normalized = normalizeInitRuntime(runtime);
  const base = {
    isolation: {
      bare: false,
      strict_mcp_config: false,
    },
  };

  if (normalized === "codex-app-server") {
    return {
      kind: "codex-app-server",
      command: "codex",
      args: [...DEFAULT_CODEX_APP_SERVER_ARGS],
      ...base,
      timeouts: {
        read_timeout_ms: 5000,
        turn_timeout_ms: 3600000,
        stall_timeout_ms: 300000,
      },
    };
  }

  if (normalized === "claude-print") {
    return {
      kind: "claude-print",
      command: "claude",
      args: [...DEFAULT_CLAUDE_PRINT_ARGS],
      ...base,
      timeouts: {
        read_timeout_ms: 5000,
        turn_timeout_ms: 3600000,
        stall_timeout_ms: 900000,
      },
    };
  }

  return {
    kind: "custom",
    command: runtime,
    ...base,
    timeouts: {
      read_timeout_ms: 5000,
      turn_timeout_ms: 3600000,
      stall_timeout_ms: 300000,
    },
  };
}

function buildPriorityFrontMatter(
  input: Pick<GenerateWorkflowInput, "priority" | "includePriorityTemplates">
): Record<string, YamlFrontMatterNode> | null {
  if (!input.priority) {
    return null;
  }

  if (input.priority.source === "project-field") {
    return {
      source: "project-field",
      field: yamlQuotedString(input.priority.field),
      values: input.priority.values,
    };
  }

  if (input.priority.source === "labels") {
    return {
      source: "labels",
      labels: input.priority.labels,
    };
  }

  return {
    source: "disabled",
  };
}

function buildTrackerFrontMatterComments(
  input: Pick<GenerateWorkflowInput, "priority" | "includePriorityTemplates">
): string {
  if (!input.priority) {
    return "";
  }

  const comments =
    input.priority.source === "disabled"
      ? [
          "    # Priority dispatch is disabled until an operator chooses one explicit source.",
        ]
      : [
          "    # Priority is explicit. Numbers below are editable policy (lower = higher priority).",
        ];
  comments.push(
    "    # See docs/adr/2026-05-18_explicit-dispatch-priority-mappings.md"
  );

  if (input.priority.source === "disabled" && input.includePriorityTemplates) {
    comments.push(
      "",
      "    # Optional template: project-field priority source.",
      "    # priority:",
      "    #   source: project-field",
      "    #   field: Priority",
      "    #   values:",
      "    #     Urgent: 0",
      "    #     High: 1",
      "",
      "    # Optional template: labels priority source.",
      "    # priority:",
      "    #   source: labels",
      "    #   labels:",
      "    #     P0: 0",
      "    #     P1: 1"
    );
  }

  return `${comments.join("\n")}\n`;
}

function stringifyYamlFrontMatter(
  input: Record<string, YamlFrontMatterNode>
): string {
  return `${stringifyYamlObject(input, 0).join("\n")}\n`;
}

function stringifyYamlObject(
  input: Record<string, YamlFrontMatterNode>,
  indent: number
): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const prefix = " ".repeat(indent);
    if (isYamlNestedValue(value)) {
      if (Array.isArray(value) && value.length === 0) {
        lines.push(`${prefix}${formatYamlKey(key)}: []`);
        continue;
      }
      lines.push(`${prefix}${formatYamlKey(key)}:`);
      lines.push(...stringifyYamlNode(value, indent + 2));
      continue;
    }
    lines.push(`${prefix}${formatYamlKey(key)}: ${formatYamlScalar(value)}`);
  }
  return lines;
}

function formatYamlKey(value: string): string {
  if (
    /^[a-z_][a-z0-9_]*$/.test(value) &&
    !/^(?:true|false|null)$/.test(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function stringifyYamlNode(
  value: YamlFrontMatterNode,
  indent: number
): string[] {
  const prefix = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return [`${prefix}[]`];
    }
    return value.flatMap((entry) => {
      if (isYamlNestedValue(entry)) {
        return [`${prefix}-`, ...stringifyYamlNode(entry, indent + 2)];
      }
      return [`${prefix}- ${formatYamlScalar(entry)}`];
    });
  }
  if (isYamlObject(value)) {
    return stringifyYamlObject(value, indent);
  }
  return [`${prefix}${formatYamlScalar(value)}`];
}

function isYamlNestedValue(value: YamlFrontMatterNode): boolean {
  return Array.isArray(value) || isYamlObject(value);
}

function isYamlObject(
  value: YamlFrontMatterNode
): value is Record<string, YamlFrontMatterNode> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isYamlQuotedString(value)
  );
}

function formatYamlScalar(value: YamlFrontMatterNode): string {
  if (isYamlQuotedString(value)) {
    return JSON.stringify(value.value);
  }
  if (typeof value === "string") {
    return shouldQuoteYamlScalar(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  throw new Error("Nested YAML values must be serialized by the caller.");
}

function shouldQuoteYamlScalar(value: string): boolean {
  const firstChar = value[0] ?? "";
  return (
    value.length === 0 ||
    /^\s|\s$/.test(value) ||
    /[\n\r]/.test(value) ||
    /(^|\s)#/.test(value) ||
    /:\s/.test(value) ||
    /^(?:null|true|false|-?\d+)$/.test(value) ||
    "[]{},&*!|>'\"%@`".includes(firstChar)
  );
}

function yamlQuotedString(value: string): YamlQuotedString {
  return {
    __yamlQuotedString: true,
    value,
  };
}

function isYamlQuotedString(
  value: YamlFrontMatterNode
): value is YamlQuotedString {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "__yamlQuotedString" in value
  );
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
