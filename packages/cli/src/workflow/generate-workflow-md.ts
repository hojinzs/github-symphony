import type { WorkflowLifecycleConfig } from "@gh-symphony/core";
import type { StateMapping } from "../config.js";

export type GenerateWorkflowInput = {
  projectId: string;
  stateFieldName: string;
  mappings: Record<string, StateMapping>;
  lifecycle: WorkflowLifecycleConfig;
  runtime: string;
  pollIntervalMs?: number;
  concurrency?: number;
};

export function generateWorkflowMarkdown(input: GenerateWorkflowInput): string {
  const frontMatter = buildFrontMatter(input);
  const promptBody = buildPromptBody(input.mappings);
  return `---\n${frontMatter}---\n${promptBody}\n`;
}

function buildFrontMatter(input: GenerateWorkflowInput): string {
  const lines: string[] = [];

  lines.push("tracker:");
  lines.push("  kind: github-project");
  lines.push(`  project_id: ${input.projectId}`);
  lines.push(`  state_field: ${input.stateFieldName}`);

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

  if (input.lifecycle.blockerCheckStates.length > 0) {
    lines.push("  blocker_check_states:");
    for (const state of input.lifecycle.blockerCheckStates) {
      lines.push(`    - ${state}`);
    }
  }

  const agentCommand = resolveAgentCommand(input.runtime);
  lines.push("polling:");
  lines.push(`  interval_ms: ${input.pollIntervalMs ?? 30000}`);

  lines.push("workspace:");
  lines.push("  root: .runtime/symphony-workspaces");

  lines.push("hooks:");
  lines.push("  after_create: hooks/after_create.sh");

  lines.push("agent:");
  lines.push("  max_concurrent_agents: 10");
  lines.push("  max_retry_backoff_ms: 30000");
  lines.push("  retry_base_delay_ms: 10000");

  lines.push("codex:");
  lines.push(`  command: ${agentCommand}`);
  lines.push("  read_timeout_ms: 5000");
  lines.push("  turn_timeout_ms: 3600000");

  return lines.join("\n") + "\n";
}

function resolveAgentCommand(runtime: string): string {
  switch (runtime) {
    case "codex":
      return "codex app-server";
    case "claude-code":
      return "claude-code";
    default:
      return runtime;
  }
}

function buildPromptBody(mappings: Record<string, StateMapping>): string {
  const statusMap = generateStatusMapWithDescriptions(mappings);
  const template = `${statusMap}

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

  return template;
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
