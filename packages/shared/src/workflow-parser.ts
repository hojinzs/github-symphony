import {
  DEFAULT_WORKFLOW_LIFECYCLE,
  type WorkflowLifecycleConfig
} from "./workflow-lifecycle.js";

export type ParsedWorkflow = {
  githubProjectId: string | null;
  promptGuidelines: string;
  allowedRepositories: string[];
  agentCommand: string;
  hookPath: string;
  lifecycle: WorkflowLifecycleConfig;
};

const DEFAULT_AGENT_COMMAND = "bash -lc codex app-server";
const DEFAULT_HOOK_PATH = "hooks/after_create.sh";

export function parseWorkflowMarkdown(markdown: string): ParsedWorkflow {
  const githubProjectId = matchOptional(markdown, /Project ID:\s*(.+)/);
  const promptGuidelines = matchOptionalSection(markdown, "Prompt Guidelines") ?? "";
  const allowedRepositories = parseAllowedRepositories(markdown);
  const agentCommand =
    stripCode(matchOptional(markdown, /Agent command:\s*`([^`]+)`/)) ??
    DEFAULT_AGENT_COMMAND;
  const hookPath =
    stripCode(matchOptional(markdown, /Hook:\s*`([^`]+)`/)) ?? DEFAULT_HOOK_PATH;
  const lifecycle = parseWorkflowLifecycle(markdown);

  return {
    githubProjectId,
    promptGuidelines,
    allowedRepositories,
    agentCommand,
    hookPath,
    lifecycle
  };
}

function parseAllowedRepositories(markdown: string): string[] {
  const section = matchOptionalSection(markdown, "Repository Allowlist");

  if (!section) {
    return [];
  }

  return section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());
}

function stripCode(value: string | null): string | null {
  if (!value) {
    return value;
  }

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
  const block = matchOptional(
    section,
    new RegExp(`${escapeForPattern(label)}:\\n([\\s\\S]*?)(?=\\n- |$)`)
  );

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
