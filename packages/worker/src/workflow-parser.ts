import {
  DEFAULT_WORKFLOW_LIFECYCLE,
  type WorkflowLifecycleConfig
} from "./workflow-lifecycle.js";

export type ParsedWorkflow = {
  githubProjectId: string;
  promptGuidelines: string;
  allowedRepositories: string[];
  agentCommand: string;
  hookPath: string;
  lifecycle: WorkflowLifecycleConfig;
};

export function parseWorkflowMarkdown(markdown: string): ParsedWorkflow {
  const githubProjectId = matchRequired(markdown, /Project ID:\s*(.+)/);
  const promptGuidelines = matchSection(markdown, "Prompt Guidelines");
  const allowedRepositories = matchSection(markdown, "Repository Allowlist")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
  const agentCommand = stripCode(matchRequired(markdown, /Agent command:\s*`([^`]+)`/));
  const hookPath = stripCode(matchRequired(markdown, /Hook:\s*`([^`]+)`/));
  const lifecycle = parseWorkflowLifecycle(markdown);

  if (!allowedRepositories.length) {
    throw new Error("WORKFLOW.md must define at least one allowed repository.");
  }

  return {
    githubProjectId,
    promptGuidelines,
    allowedRepositories,
    agentCommand,
    hookPath,
    lifecycle
  };
}

function matchRequired(markdown: string, pattern: RegExp): string {
  const match = markdown.match(pattern);

  if (!match?.[1]) {
    throw new Error(`WORKFLOW.md is missing required content for pattern: ${pattern}`);
  }

  return match[1].trim();
}

function matchSection(markdown: string, heading: string): string {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`## ${escapedHeading}\\n\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = markdown.match(pattern);

  if (!match?.[1]) {
    throw new Error(`WORKFLOW.md is missing the "${heading}" section.`);
  }

  return match[1].trim();
}

function stripCode(value: string): string {
  return value.replace(/^`|`$/g, "").trim();
}

function parseWorkflowLifecycle(markdown: string): WorkflowLifecycleConfig {
  const section = matchOptionalSection(markdown, "Approval Lifecycle");

  if (!section) {
    return DEFAULT_WORKFLOW_LIFECYCLE;
  }

  return {
    stateFieldName:
      matchOptional(section, /State field:\s*(.+)/) ??
      DEFAULT_WORKFLOW_LIFECYCLE.stateFieldName,
    planningStates: readLifecycleList(
      section,
      "Planning-active states",
      DEFAULT_WORKFLOW_LIFECYCLE.planningStates
    ),
    humanReviewStates: readLifecycleList(
      section,
      "Human-review states",
      DEFAULT_WORKFLOW_LIFECYCLE.humanReviewStates
    ),
    implementationStates: readLifecycleList(
      section,
      "Implementation-active states",
      DEFAULT_WORKFLOW_LIFECYCLE.implementationStates
    ),
    awaitingMergeStates: readLifecycleList(
      section,
      "Awaiting-merge states",
      DEFAULT_WORKFLOW_LIFECYCLE.awaitingMergeStates
    ),
    completedStates: readLifecycleList(
      section,
      "Completed states",
      DEFAULT_WORKFLOW_LIFECYCLE.completedStates
    ),
    planningCompleteState:
      matchOptional(section, /Planning complete ->\s*(.+)/) ??
      DEFAULT_WORKFLOW_LIFECYCLE.planningCompleteState,
    implementationCompleteState:
      matchOptional(section, /Implementation complete ->\s*(.+)/) ??
      DEFAULT_WORKFLOW_LIFECYCLE.implementationCompleteState,
    mergeCompleteState:
      matchOptional(section, /Merge complete ->\s*(.+)/) ??
      DEFAULT_WORKFLOW_LIFECYCLE.mergeCompleteState
  };
}

function readLifecycleList(
  section: string,
  label: string,
  fallback: string[]
): string[] {
  const block = matchOptional(section, new RegExp(`${escapeForPattern(label)}:\\n([\\s\\S]*?)(?=\\n- |$)`));

  if (!block) {
    return fallback;
  }

  const values = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());

  return values.length ? values : fallback;
}

function matchOptional(markdown: string, pattern: RegExp): string | null {
  const match = markdown.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchOptionalSection(markdown: string, heading: string): string | null {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`## ${escapedHeading}\\n\\n([\\s\\S]*?)(?=\\n## |$)`);
  const match = markdown.match(pattern);

  return match?.[1]?.trim() ?? null;
}
