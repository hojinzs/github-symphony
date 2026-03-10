import {
  DEFAULT_AGENT_COMMAND,
  DEFAULT_HOOK_PATH,
  DEFAULT_MAX_TURNS,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_WORKFLOW_DEFINITION,
  DEFAULT_WORKFLOW_HOOKS,
  DEFAULT_WORKFLOW_RETRY,
  DEFAULT_WORKFLOW_RUNTIME,
  DEFAULT_WORKFLOW_SCHEDULER,
  type ParsedWorkflow
} from "./config.js";
import { DEFAULT_WORKFLOW_LIFECYCLE } from "./lifecycle.js";

type WorkflowFrontMatterNode =
  | string
  | number
  | boolean
  | null
  | WorkflowFrontMatterNode[]
  | { [key: string]: WorkflowFrontMatterNode };

/**
 * Parse a WORKFLOW.md file into a typed workflow definition.
 *
 * Supports two formats:
 *  1. **YAML front matter + prompt body** (canonical) — `format: "front-matter"`
 *  2. **Legacy sectioned markdown** (compatibility) — `format: "legacy-sectioned"`
 *
 * The legacy format is auto-detected when no YAML front matter delimiter (`---`)
 * is found. Existing workspaces with section-based WORKFLOW.md files continue to
 * work without modification. Operators should migrate to the YAML front matter
 * format; the legacy parser will be removed in a future version.
 */
export function parseWorkflowMarkdown(
  markdown: string,
  env: NodeJS.ProcessEnv = process.env
): ParsedWorkflow {
  const frontMatterMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!frontMatterMatch) {
    return parseLegacyWorkflowMarkdown(markdown);
  }

  const [, rawFrontMatter, rawPromptTemplate = ""] = frontMatterMatch;
  const frontMatter = parseFrontMatter(rawFrontMatter);
  const allowedRepositories = readStringArray(frontMatter, "allowed_repositories") ?? [];
  const githubProjectId = readOptionalString(frontMatter, "github_project_id", env);
  const promptTemplate = rawPromptTemplate.trim();
  const runtimeConfig = readObject(frontMatter, "runtime");
  const hooksConfig = readObject(frontMatter, "hooks");
  const lifecycleConfig = readObject(frontMatter, "lifecycle");
  const transitionsConfig = readObject(lifecycleConfig, "transitions");
  const schedulerConfig = readObject(frontMatter, "scheduler");
  const retryConfig = readObject(frontMatter, "retry");
  const maxConcurrentByPhaseRaw = readObject(frontMatter, "max_concurrent_by_phase");
  const maxConcurrentByPhase: Record<string, number> = {};
  for (const [phaseKey, phaseVal] of Object.entries(maxConcurrentByPhaseRaw)) {
    if (typeof phaseVal === "number") {
      maxConcurrentByPhase[phaseKey] = phaseVal;
    }
  }
  const agentCommand =
    readOptionalString(runtimeConfig, "agent_command", env) ?? DEFAULT_AGENT_COMMAND;
  const hookPath =
    readOptionalString(hooksConfig, "after_create", env) ?? DEFAULT_HOOK_PATH;

  return {
    githubProjectId,
    promptTemplate,
    promptGuidelines: promptTemplate,
    allowedRepositories,
    runtime: {
      agentCommand,
      hooks: {
        afterCreate: hookPath,
        beforeRun: readOptionalString(hooksConfig, "before_run", env),
        afterRun: readOptionalString(hooksConfig, "after_run", env),
        beforeRemove: readOptionalString(hooksConfig, "before_remove", env)
      },
      maxTurns:
        readOptionalNumber(runtimeConfig, "max_turns") ?? DEFAULT_MAX_TURNS,
      readTimeoutMs:
        readOptionalNumber(runtimeConfig, "read_timeout_ms") ?? DEFAULT_READ_TIMEOUT_MS,
      turnTimeoutMs:
        readOptionalNumber(runtimeConfig, "turn_timeout_ms") ?? DEFAULT_TURN_TIMEOUT_MS,
    },
    scheduler: {
      pollIntervalMs:
        readOptionalNumber(schedulerConfig, "poll_interval_ms") ??
        DEFAULT_WORKFLOW_SCHEDULER.pollIntervalMs
    },
    retry: {
      baseDelayMs:
        readOptionalNumber(retryConfig, "base_delay_ms") ?? DEFAULT_WORKFLOW_RETRY.baseDelayMs,
      maxDelayMs:
        readOptionalNumber(retryConfig, "max_delay_ms") ?? DEFAULT_WORKFLOW_RETRY.maxDelayMs
    },
    lifecycle: {
      stateFieldName:
        readOptionalString(lifecycleConfig, "state_field", env) ??
        DEFAULT_WORKFLOW_LIFECYCLE.stateFieldName,
      planningStates:
        readStringArray(lifecycleConfig, "planning_active") ??
        DEFAULT_WORKFLOW_LIFECYCLE.planningStates,
      humanReviewStates:
        readStringArray(lifecycleConfig, "human_review") ??
        DEFAULT_WORKFLOW_LIFECYCLE.humanReviewStates,
      implementationStates:
        readStringArray(lifecycleConfig, "implementation_active") ??
        DEFAULT_WORKFLOW_LIFECYCLE.implementationStates,
      awaitingMergeStates:
        readStringArray(lifecycleConfig, "awaiting_merge") ??
        DEFAULT_WORKFLOW_LIFECYCLE.awaitingMergeStates,
      completedStates:
        readStringArray(lifecycleConfig, "completed") ??
        DEFAULT_WORKFLOW_LIFECYCLE.completedStates,
      planningCompleteState:
        readOptionalString(transitionsConfig, "planning_complete", env) ??
        DEFAULT_WORKFLOW_LIFECYCLE.planningCompleteState,
      implementationCompleteState:
        readOptionalString(transitionsConfig, "implementation_complete", env) ??
        DEFAULT_WORKFLOW_LIFECYCLE.implementationCompleteState,
      mergeCompleteState:
        readOptionalString(transitionsConfig, "merge_complete", env) ??
        DEFAULT_WORKFLOW_LIFECYCLE.mergeCompleteState
    },
    maxConcurrentByPhase,
    format: "front-matter",
    agentCommand,
    hookPath
  };
}

/**
 * @deprecated Legacy compatibility parser for section-based WORKFLOW.md files.
 *
 * This parser handles the original section-based format (## Prompt Guidelines,
 * ## Repository Allowlist, ## Approval Lifecycle, etc.). It is invoked
 * automatically by `parseWorkflowMarkdown` when no YAML front matter is detected.
 *
 * Migrate existing WORKFLOW.md files to YAML front matter format and remove this
 * fallback once all workspaces have been transitioned.
 */
function parseLegacyWorkflowMarkdown(markdown: string): ParsedWorkflow {
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
    ...DEFAULT_WORKFLOW_DEFINITION,
    githubProjectId,
    promptTemplate: promptGuidelines,
    promptGuidelines,
    allowedRepositories,
    runtime: {
      ...DEFAULT_WORKFLOW_RUNTIME,
      agentCommand,
      hooks: {
        ...DEFAULT_WORKFLOW_HOOKS,
        afterCreate: hookPath
      }
    },
    lifecycle,
    format: "legacy-sectioned",
    agentCommand,
    hookPath
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

function parseWorkflowLifecycle(markdown: string) {
  const section = matchOptionalSection(markdown, "Approval Lifecycle");

  if (!section) {
    return DEFAULT_WORKFLOW_LIFECYCLE;
  }

  return {
    stateFieldName:
      matchOptional(section, /State field:\s*(.+)/) ??
      DEFAULT_WORKFLOW_LIFECYCLE.stateFieldName,
    planningStates: readLegacyLifecycleList(
      section,
      "Planning-active states",
      DEFAULT_WORKFLOW_LIFECYCLE.planningStates
    ),
    humanReviewStates: readLegacyLifecycleList(
      section,
      "Human-review states",
      DEFAULT_WORKFLOW_LIFECYCLE.humanReviewStates
    ),
    implementationStates: readLegacyLifecycleList(
      section,
      "Implementation-active states",
      DEFAULT_WORKFLOW_LIFECYCLE.implementationStates
    ),
    awaitingMergeStates: readLegacyLifecycleList(
      section,
      "Awaiting-merge states",
      DEFAULT_WORKFLOW_LIFECYCLE.awaitingMergeStates
    ),
    completedStates: readLegacyLifecycleList(
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

function readLegacyLifecycleList(
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

function parseFrontMatter(frontMatter: string): Record<string, WorkflowFrontMatterNode> {
  const lines = frontMatter.replace(/\r\n/g, "\n").split("\n");
  const [value] = parseBlock(lines, 0, 0);

  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Workflow front matter must be a YAML object.");
  }

  return value as Record<string, WorkflowFrontMatterNode>;
}

function parseBlock(
  lines: string[],
  startIndex: number,
  indent: number
): [WorkflowFrontMatterNode, number] {
  let index = startIndex;
  let collectionType: "array" | "object" | null = null;
  const arrayValues: WorkflowFrontMatterNode[] = [];
  const objectValues: Record<string, WorkflowFrontMatterNode> = {};

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const lineIndent = countIndent(line);
    if (lineIndent < indent) {
      break;
    }
    if (lineIndent > indent) {
      throw new Error(`Invalid workflow front matter indentation near "${line.trim()}".`);
    }

    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      if (collectionType === "object") {
        throw new Error("Cannot mix array and object values in workflow front matter.");
      }
      collectionType = "array";
      const itemText = trimmed.slice(2).trim();
      if (itemText) {
        arrayValues.push(parseScalar(itemText));
        index += 1;
        continue;
      }

      const [child, nextIndex] = parseBlock(lines, index + 1, indent + 2);
      arrayValues.push(child);
      index = nextIndex;
      continue;
    }

    if (collectionType === "array") {
      throw new Error("Cannot mix object and array values in workflow front matter.");
    }
    collectionType = "object";
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex < 0) {
      throw new Error(`Invalid workflow front matter line "${trimmed}".`);
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const remainder = trimmed.slice(separatorIndex + 1).trim();
    if (remainder) {
      objectValues[key] = parseScalar(remainder);
      index += 1;
      continue;
    }

    const [child, nextIndex] = parseBlock(lines, index + 1, indent + 2);
    objectValues[key] = child;
    index = nextIndex;
  }

  return [collectionType === "array" ? arrayValues : objectValues, index];
}

function countIndent(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

function parseScalar(value: string): WorkflowFrontMatterNode {
  if (value === "null") {
    return null;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readObject(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string
): Record<string, WorkflowFrontMatterNode> {
  const value = input[key];
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Workflow front matter field "${key}" must be an object.`);
  }
  return value as Record<string, WorkflowFrontMatterNode>;
}

function readStringArray(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string
): string[] | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Workflow front matter field "${key}" must be an array of strings.`);
  }
  return value as string[];
}

function readOptionalString(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string,
  env: NodeJS.ProcessEnv
): string | null {
  const value = input[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Workflow front matter field "${key}" must be a string.`);
  }

  return resolveEnvironmentValue(value, env);
}

function readOptionalNumber(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string
): number | null {
  const value = input[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number") {
    throw new Error(`Workflow front matter field "${key}" must be a number.`);
  }
  return value;
}

function resolveEnvironmentValue(
  value: string,
  env: NodeJS.ProcessEnv
): string {
  const envTokenMatch = value.match(/^(?:env:)?([A-Z0-9_]+)$/);
  if (value.startsWith("env:") && envTokenMatch) {
    const resolved = env[envTokenMatch[1]];
    if (!resolved) {
      throw new Error(`Workflow front matter requires environment variable ${envTokenMatch[1]}.`);
    }
    return resolved;
  }

  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const resolved = env[name];
    if (!resolved) {
      throw new Error(`Workflow front matter requires environment variable ${name}.`);
    }
    return resolved;
  });
}
