import type { WorkflowLifecycleConfig } from "@gh-symphony/core";
import { generateStatusMap } from "../mapping/smart-defaults.js";
import type { StateMapping } from "../config.js";

export type GenerateWorkflowInput = {
  projectId: string;
  stateFieldName: string;
  mappings: Record<string, StateMapping>;
  lifecycle: WorkflowLifecycleConfig;
  repositories: Array<{ owner: string; name: string }>;
  runtime: string;
  pollIntervalMs?: number;
  concurrency?: number;
  blockedByFieldName?: string;
};

export function generateWorkflowMarkdown(input: GenerateWorkflowInput): string {
  const frontMatter = buildFrontMatter(input);
  const promptBody = buildPromptBody(input.mappings);
  return `---\n${frontMatter}---\n${promptBody}\n`;
}

function buildFrontMatter(input: GenerateWorkflowInput): string {
  const lines: string[] = [];

  lines.push(`github_project_id: ${input.projectId}`);

  if (input.repositories.length > 0) {
    lines.push("allowed_repositories:");
    for (const repo of input.repositories) {
      lines.push(`  - ${repo.owner}/${repo.name}`);
    }
  }

  lines.push("lifecycle:");
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

  if (input.blockedByFieldName) {
    lines.push(`  blocked_by_field: "${input.blockedByFieldName}"`);
  }

  const agentCommand = resolveAgentCommand(input.runtime);
  lines.push("runtime:");
  lines.push(`  agent_command: ${agentCommand}`);

  lines.push("hooks:");
  lines.push("  after_create: hooks/after_create.sh");

  lines.push("scheduler:");
  lines.push(
    `  poll_interval_ms: ${input.pollIntervalMs ?? 30000}`
  );

  lines.push("retry:");
  lines.push("  base_delay_ms: 1000");
  lines.push("  max_delay_ms: 30000");

  return lines.join("\n") + "\n";
}

function resolveAgentCommand(runtime: string): string {
  switch (runtime) {
    case "codex":
      return "bash -lc codex app-server";
    case "claude-code":
      return "bash -lc claude-code";
    default:
      return runtime;
  }
}

function buildPromptBody(mappings: Record<string, StateMapping>): string {
  const statusMap = generateStatusMap(mappings);
  const template = `${statusMap}

## Agent Instructions

You are an AI coding agent working on issue {{issue.identifier}}: "{{issue.title}}".

**Repository:** {{issue.repository}}
**Current state:** {{issue.state}}

### Task

{{issue.description}}

### Guidelines

{{guidelines}}

### Workflow

1. Read the issue description carefully and understand the requirements.
2. Explore the codebase to understand the relevant code structure.
3. Implement the changes following the project's coding conventions.
4. Write or update tests to cover the changes.
5. Ensure all existing tests pass.
6. Create a pull request with a clear description of the changes.`;

  return template;
}
