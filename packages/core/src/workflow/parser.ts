import {
  DEFAULT_AGENT_COMMAND,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_MAX_RETRY_BACKOFF_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_WORKFLOW_DEFINITION,
  DEFAULT_WORKFLOW_TRACKER,
  type ParsedWorkflow,
} from "./config.js";

type WorkflowFrontMatterNode =
  | string
  | number
  | boolean
  | null
  | WorkflowFrontMatterNode[]
  | { [key: string]: WorkflowFrontMatterNode };

export type ParseWorkflowOptions = {
  compatibilityMode?: "strict" | "legacy";
};

export function parseWorkflowMarkdown(
  markdown: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ParseWorkflowOptions = {}
): ParsedWorkflow {
  const compatibilityMode = options.compatibilityMode ?? "strict";
  const frontMatterMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!frontMatterMatch) {
    if (compatibilityMode === "legacy") {
      return parseLegacyWorkflowMarkdown(markdown);
    }
    throw new Error("WORKFLOW.md must use YAML front matter.");
  }

  const [, rawFrontMatter, rawPromptTemplate = ""] = frontMatterMatch;
  const frontMatter = parseFrontMatter(rawFrontMatter);
  const promptTemplate = rawPromptTemplate.trim();

  const tracker = readRequiredObject(frontMatter, "tracker");
  const polling = readObject(frontMatter, "polling");
  const workspace = readObject(frontMatter, "workspace");
  const hooks = readObject(frontMatter, "hooks");
  const agent = readObject(frontMatter, "agent");
  const codex = readRequiredObject(frontMatter, "codex");

  const trackerKind = readRequiredString(tracker, "kind", env);
  const activeStates =
    readStringList(tracker, "active_states") ??
    DEFAULT_WORKFLOW_TRACKER.activeStates;
  const terminalStates =
    readStringList(tracker, "terminal_states") ??
    DEFAULT_WORKFLOW_TRACKER.terminalStates;
  const blockerCheckStates =
    readStringList(tracker, "blocker_check_states") ??
    DEFAULT_WORKFLOW_TRACKER.blockerCheckStates;

  const maxConcurrentAgentsByState = readNumberMap(
    agent,
    "max_concurrent_agents_by_state"
  );

  const command =
    readOptionalString(codex, "command", env) ?? DEFAULT_AGENT_COMMAND;

  const parsed: ParsedWorkflow = {
    promptTemplate,
    continuationGuidance: readOptionalWorkflowString(
      frontMatter,
      "continuationGuidance",
      "continuation_guidance",
      env
    ),
    tracker: {
      kind: trackerKind,
      endpoint: readOptionalString(tracker, "endpoint", env),
      apiKey: readOptionalString(tracker, "api_key", env),
      projectSlug: readOptionalString(tracker, "project_slug", env),
      activeStates,
      terminalStates,
      projectId: readOptionalString(tracker, "project_id", env),
      stateFieldName:
        readOptionalString(tracker, "state_field", env) ??
        DEFAULT_WORKFLOW_TRACKER.stateFieldName,
      priorityFieldName: readOptionalString(tracker, "priority_field", env),
      blockerCheckStates,
    },
    polling: {
      intervalMs:
        readOptionalIntegerLike(polling, "interval_ms") ??
        DEFAULT_POLL_INTERVAL_MS,
    },
    workspace: {
      root: readOptionalString(workspace, "root", env),
    },
    hooks: {
      afterCreate: readOptionalString(hooks, "after_create", env),
      beforeRun: readOptionalString(hooks, "before_run", env),
      afterRun: readOptionalString(hooks, "after_run", env),
      beforeRemove: readOptionalString(hooks, "before_remove", env),
      timeoutMs:
        readOptionalIntegerLike(hooks, "timeout_ms") ?? DEFAULT_HOOK_TIMEOUT_MS,
    },
    agent: {
      maxConcurrentAgents:
        readOptionalIntegerLike(agent, "max_concurrent_agents") ??
        DEFAULT_MAX_CONCURRENT_AGENTS,
      maxRetryBackoffMs:
        readOptionalIntegerLike(agent, "max_retry_backoff_ms") ??
        DEFAULT_MAX_RETRY_BACKOFF_MS,
      maxConcurrentAgentsByState,
      maxTurns:
        readOptionalIntegerLike(agent, "max_turns") ?? DEFAULT_MAX_TURNS,
      retryBaseDelayMs:
        readOptionalIntegerLike(agent, "retry_base_delay_ms") ??
        DEFAULT_BASE_DELAY_MS,
    },
    codex: {
      command,
      approvalPolicy: readOptionalString(codex, "approval_policy", env),
      threadSandbox: readOptionalString(codex, "thread_sandbox", env),
      turnSandboxPolicy: readOptionalString(codex, "turn_sandbox_policy", env),
      turnTimeoutMs:
        readOptionalIntegerLike(codex, "turn_timeout_ms") ??
        DEFAULT_TURN_TIMEOUT_MS,
      readTimeoutMs:
        readOptionalIntegerLike(codex, "read_timeout_ms") ??
        DEFAULT_READ_TIMEOUT_MS,
      stallTimeoutMs:
        readOptionalIntegerLike(codex, "stall_timeout_ms") ??
        DEFAULT_STALL_TIMEOUT_MS,
    },
    lifecycle: {
      stateFieldName:
        readOptionalString(tracker, "state_field", env) ??
        DEFAULT_WORKFLOW_TRACKER.stateFieldName,
      activeStates,
      terminalStates,
      blockerCheckStates,
    },
    format: "front-matter",
    githubProjectId: readOptionalString(tracker, "project_id", env),
    agentCommand: command,
    hookPath: readOptionalString(hooks, "after_create", env),
    maxConcurrentByState: maxConcurrentAgentsByState,
  };

  return parsed;
}

function parseLegacyWorkflowMarkdown(markdown: string): ParsedWorkflow {
  const promptGuidelines =
    matchOptionalSection(markdown, "Prompt Guidelines") ?? "";

  return {
    ...DEFAULT_WORKFLOW_DEFINITION,
    promptTemplate: promptGuidelines,
    format: "legacy-sectioned",
  };
}

function parseFrontMatter(
  frontMatter: string
): Record<string, WorkflowFrontMatterNode> {
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
      throw new Error(
        `Invalid workflow front matter indentation near "${line.trim()}".`
      );
    }

    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      if (collectionType === "object") {
        throw new Error(
          "Cannot mix array and object values in workflow front matter."
        );
      }
      collectionType = "array";
      const itemText = trimmed.slice(2).trim();

      if (itemText === "|" || itemText === "|-") {
        const [multiline, nextIndex] = parseMultilineScalar(
          lines,
          index + 1,
          indent + 2
        );
        arrayValues.push(multiline);
        index = nextIndex;
        continue;
      }

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
      throw new Error(
        "Cannot mix object and array values in workflow front matter."
      );
    }
    collectionType = "object";
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex < 0) {
      throw new Error(`Invalid workflow front matter line "${trimmed}".`);
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const remainder = trimmed.slice(separatorIndex + 1).trim();
    if (remainder === "|" || remainder === "|-") {
      const [multiline, nextIndex] = parseMultilineScalar(
        lines,
        index + 1,
        indent + 2
      );
      objectValues[key] = multiline;
      index = nextIndex;
      continue;
    }
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

function parseMultilineScalar(
  lines: string[],
  startIndex: number,
  indent: number
): [string, number] {
  let index = startIndex;
  const collected: string[] = [];

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      collected.push("");
      index += 1;
      continue;
    }

    const lineIndent = countIndent(line);
    if (lineIndent < indent) {
      break;
    }

    collected.push(line.slice(indent));
    index += 1;
  }

  return [collected.join("\n").trimEnd(), index];
}

function countIndent(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

function parseScalar(value: string): WorkflowFrontMatterNode {
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
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

function readRequiredObject(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string
): Record<string, WorkflowFrontMatterNode> {
  if (!(key in input)) {
    throw new Error(`Workflow front matter field "${key}" is required.`);
  }
  return readObject(input, key);
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

function readOptionalWorkflowString(
  input: Record<string, WorkflowFrontMatterNode>,
  primaryKey: string,
  fallbackKey: string,
  env: NodeJS.ProcessEnv
): string | null {
  return (
    readOptionalString(input, primaryKey, env) ??
    readOptionalString(input, fallbackKey, env)
  );
}

function readRequiredString(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string,
  env: NodeJS.ProcessEnv
): string {
  const value = readOptionalString(input, key, env);
  if (!value) {
    throw new Error(`Workflow front matter field "${key}" is required.`);
  }
  return value;
}

function readStringList(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string
): string[] | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(
      `Workflow front matter field "${key}" must be an array of strings or comma-separated string.`
    );
  }
  return value as string[];
}

function readOptionalIntegerLike(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string
): number | null {
  const value = input[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  throw new Error(`Workflow front matter field "${key}" must be an integer.`);
}

function readNumberMap(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string
): Record<string, number> {
  const value = input[key];
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Workflow front matter field "${key}" must be an object.`);
  }

  const result: Record<string, number> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "number") {
      result[entryKey] = entryValue;
      continue;
    }
    if (typeof entryValue === "string" && /^\d+$/.test(entryValue)) {
      result[entryKey] = Number.parseInt(entryValue, 10);
      continue;
    }
    throw new Error(
      `Workflow front matter field "${key}.${entryKey}" must be an integer.`
    );
  }
  return result;
}

function resolveEnvironmentValue(
  value: string,
  env: NodeJS.ProcessEnv
): string {
  const envTokenMatch = value.match(/^(?:env:)?([A-Z0-9_]+)$/);
  if (value.startsWith("env:") && envTokenMatch) {
    const resolved = env[envTokenMatch[1]];
    if (!resolved) {
      throw new Error(
        `Workflow front matter requires environment variable ${envTokenMatch[1]}.`
      );
    }
    return resolved;
  }

  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const resolved = env[name];
    if (!resolved) {
      throw new Error(
        `Workflow front matter requires environment variable ${name}.`
      );
    }
    return resolved;
  });
}

function matchOptionalSection(
  markdown: string,
  heading: string
): string | null {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `## ${escapedHeading}\\n\\n([\\s\\S]*?)(?=\\n## |$)`
  );
  const match = markdown.match(pattern);

  return match?.[1]?.trim() ?? null;
}
