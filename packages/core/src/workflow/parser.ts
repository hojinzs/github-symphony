import {
  DEFAULT_AGENT_COMMAND,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_LINEAR_GRAPHQL_URL,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_MAX_FAILURE_RETRIES,
  DEFAULT_MAX_RETRY_BACKOFF_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_WORKFLOW_DEFINITION,
  DEFAULT_WORKFLOW_TRACKER,
  type ParsedWorkflow,
  type WorkflowPriorityConfig,
  type WorkflowRuntimeConfig,
  type WorkflowRuntimeKind,
  resolveWorkflowRuntimeCommand,
} from "./config.js";
import {
  DEFAULT_WORKFLOW_LIFECYCLE,
  type WorkflowLifecycleConfig,
} from "./lifecycle.js";

type WorkflowFrontMatterNode =
  | string
  | number
  | boolean
  | null
  | WorkflowFrontMatterNode[]
  | { [key: string]: WorkflowFrontMatterNode };

export type ParseWorkflowOptions = {
  compatibilityMode?: "strict" | "legacy";
  supportedTrackerKinds?: readonly string[];
  /**
   * Compatibility injection for callers that already know the adapter.
   * Prefer resolveTrackerAdapter in production, where tracker.kind selects it.
   */
  trackerAdapter?: WorkflowConfigTrackerAdapter;
  /** Resolves the adapter-owned workflow hooks for the parsed tracker kind. */
  resolveTrackerAdapter?: (
    kind: string
  ) => WorkflowConfigTrackerAdapter | undefined;
};

export type WorkflowConfigTrackerAdapter = {
  validateProviderConfig?: (
    provider: Record<string, unknown>
  ) => WorkflowValidationError[];
  defaultLifecycle?: () => WorkflowLifecycleConfig;
};

export type WorkflowValidationErrorCode =
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "workflow_validation_error";

/** A stable, machine-readable error raised while reading WORKFLOW.md. */
export class WorkflowValidationError extends Error {
  constructor(
    public readonly code: WorkflowValidationErrorCode,
    public readonly path: string,
    message: string
  ) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

/** Compatibility list for consumers that do not own a tracker-adapter registry. */
export const DEFAULT_SUPPORTED_TRACKER_KINDS = [
  "github-project",
  "linear",
  "file",
] as const;

export function parseWorkflowMarkdown(
  markdown: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ParseWorkflowOptions = {}
): ParsedWorkflow {
  try {
    return parseWorkflowMarkdownInternal(markdown, env, options);
  } catch (error) {
    if (error instanceof WorkflowValidationError) {
      throw error;
    }
    const message =
      error instanceof Error ? error.message : "Invalid workflow definition.";
    throw new WorkflowValidationError(
      "workflow_validation_error",
      "front_matter",
      message
    );
  }
}

function parseWorkflowMarkdownInternal(
  markdown: string,
  env: NodeJS.ProcessEnv,
  options: ParseWorkflowOptions
): ParsedWorkflow {
  const compatibilityMode = options.compatibilityMode ?? "strict";
  const frontMatterMatch = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!frontMatterMatch) {
    if (compatibilityMode === "legacy") {
      return parseLegacyWorkflowMarkdown(markdown);
    }
    throw new WorkflowValidationError(
      "workflow_parse_error",
      "front_matter",
      "WORKFLOW.md must use YAML front matter."
    );
  }

  const [, rawFrontMatter, rawPromptTemplate = ""] = frontMatterMatch;
  const frontMatter = parseFrontMatter(rawFrontMatter);
  const promptTemplate = rawPromptTemplate.trim();

  const tracker = readRequiredObject(frontMatter, "tracker");
  const polling = readObject(frontMatter, "polling");
  const workspace = readObject(frontMatter, "workspace");
  const hooks = readObject(frontMatter, "hooks");
  const agent = readObject(frontMatter, "agent");
  const runtimeNode = readOptionalRuntimeObject(frontMatter);
  const hasRuntime = runtimeNode !== null;
  const codex = hasRuntime
    ? readObject(frontMatter, "codex")
    : readRequiredObject(frontMatter, "codex");

  const trackerKind = readRequiredString(tracker, "kind", env, "tracker.kind");
  const supportedTrackerKinds =
    options.supportedTrackerKinds ?? DEFAULT_SUPPORTED_TRACKER_KINDS;
  if (!supportedTrackerKinds.includes(trackerKind)) {
    throw new WorkflowValidationError(
      "workflow_validation_error",
      "tracker.kind",
      `Unsupported workflow tracker.kind "${trackerKind}". Supported values: ${supportedTrackerKinds.join(", ")}.`
    );
  }
  const trackerAdapter =
    options.resolveTrackerAdapter?.(trackerKind) ?? options.trackerAdapter;
  const provider = readProviderConfig(tracker);
  const explicitProviderKeys = new Set(Object.keys(provider));
  const deprecatedKeys = promoteDeprecatedTrackerKeys(tracker, provider);
  const defaultLifecycle = trackerAdapter?.defaultLifecycle?.();
  // Keep existing workflows usable while tracker adapters adopt defaultLifecycle.
  // This disables the required-lifecycle path until every supported adapter
  // owns its lifecycle defaults; adapter-provided defaults still take precedence.
  const legacyLifecycle = DEFAULT_WORKFLOW_LIFECYCLE;
  const activeStates =
    readNormalizedStringList(
      tracker,
      provider,
      explicitProviderKeys,
      "active_states",
      { rejectCommaString: true }
    ) ??
    defaultLifecycle?.activeStates ??
    legacyLifecycle.activeStates;
  const terminalStates =
    readNormalizedStringList(
      tracker,
      provider,
      explicitProviderKeys,
      "terminal_states",
      { rejectCommaString: true }
    ) ??
    defaultLifecycle?.terminalStates ??
    legacyLifecycle.terminalStates;
  const blockerCheckStates =
    readNormalizedStringList(
      tracker,
      provider,
      explicitProviderKeys,
      "blocker_check_states"
    ) ??
    (activeStates[0] ? [activeStates[0]] : []);
  const planningStates =
    readNormalizedStringList(
      tracker,
      provider,
      explicitProviderKeys,
      "planning_states"
    ) ??
    defaultLifecycle?.planningStates ??
    DEFAULT_WORKFLOW_TRACKER.planningStates;
  const stateFieldName =
    readNormalizedOptionalString(
      tracker,
      provider,
      explicitProviderKeys,
      "state_field",
      env
    ) ??
    defaultLifecycle?.stateFieldName ??
    legacyLifecycle.stateFieldName;
  throwProviderValidationErrors(
    trackerAdapter?.validateProviderConfig?.(provider) ?? []
  );

  const maxConcurrentAgentsByState = readNumberMap(
    agent,
    "max_concurrent_agents_by_state",
    "agent.max_concurrent_agents_by_state",
    { positive: true }
  );

  const runtime = hasRuntime ? parseRuntimeConfig(runtimeNode, env) : null;
  const codexConfig = {
    command:
      readOptionalNonEmptyString(codex, "command", env, "codex.command") ??
      DEFAULT_AGENT_COMMAND,
    approvalPolicy: readOptionalString(codex, "approval_policy", env),
    threadSandbox: readOptionalString(codex, "thread_sandbox", env),
    turnSandboxPolicy: readOptionalString(codex, "turn_sandbox_policy", env),
    turnTimeoutMs:
      readOptionalIntegerLike(
        codex,
        "turn_timeout_ms",
        "codex.turn_timeout_ms"
      ) ?? DEFAULT_TURN_TIMEOUT_MS,
    readTimeoutMs:
      readOptionalIntegerLike(
        codex,
        "read_timeout_ms",
        "codex.read_timeout_ms"
      ) ?? DEFAULT_READ_TIMEOUT_MS,
    stallTimeoutMs:
      readOptionalIntegerLike(
        codex,
        "stall_timeout_ms",
        "codex.stall_timeout_ms"
      ) ?? DEFAULT_STALL_TIMEOUT_MS,
  };
  const agentCommand = resolveWorkflowRuntimeCommand({
    runtime,
    codex: codexConfig,
  });

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
      provider,
      deprecatedKeys,
      endpoint:
        readNormalizedOptionalString(
          tracker,
          provider,
          explicitProviderKeys,
          "endpoint",
          env
        ) ?? (trackerKind === "linear" ? DEFAULT_LINEAR_GRAPHQL_URL : null),
      apiKey: readNormalizedOptionalString(
        tracker,
        provider,
        explicitProviderKeys,
        "api_key",
        env
      ),
      projectSlug: readNormalizedOptionalString(
        tracker,
        provider,
        explicitProviderKeys,
        "project_slug",
        env
      ),
      pickupLabels: readPickupLabelsConfig(
        tracker,
        provider,
        explicitProviderKeys
      ),
      activeStates,
      terminalStates,
      projectId: readNormalizedOptionalString(
        tracker,
        provider,
        explicitProviderKeys,
        "project_id",
        env
      ),
      stateFieldName,
      priority: readPriorityConfig(
        tracker,
        provider,
        explicitProviderKeys,
        env
      ),
      priorityFieldName: readNormalizedOptionalString(
        tracker,
        provider,
        explicitProviderKeys,
        "priority_field",
        env
      ),
      blockerCheckStates,
      planningStates,
    },
    polling: {
      intervalMs:
        readOptionalIntegerLike(
          polling,
          "interval_ms",
          "polling.interval_ms"
        ) ?? DEFAULT_POLL_INTERVAL_MS,
    },
    repository: readOptionalExtensionObject(frontMatter, "repository"),
    workspace: {
      root: readOptionalString(workspace, "root", env),
    },
    hooks: {
      afterCreate: readOptionalString(hooks, "after_create", env),
      beforeRun: readOptionalString(hooks, "before_run", env),
      afterRun: readOptionalString(hooks, "after_run", env),
      beforeRemove: readOptionalString(hooks, "before_remove", env),
      timeoutMs:
        readOptionalPositiveInteger(hooks, "timeout_ms", "hooks.timeout_ms") ??
        DEFAULT_HOOK_TIMEOUT_MS,
    },
    agent: {
      maxConcurrentAgents:
        readOptionalPositiveInteger(
          agent,
          "max_concurrent_agents",
          "agent.max_concurrent_agents"
        ) ?? DEFAULT_MAX_CONCURRENT_AGENTS,
      maxRetryBackoffMs:
        readOptionalIntegerLike(
          agent,
          "max_retry_backoff_ms",
          "agent.max_retry_backoff_ms"
        ) ?? DEFAULT_MAX_RETRY_BACKOFF_MS,
      maxConcurrentAgentsByState,
      maxFailureRetries:
        readOptionalIntegerLike(
          agent,
          "max_failure_retries",
          "agent.max_failure_retries"
        ) ?? DEFAULT_MAX_FAILURE_RETRIES,
      maxTurns:
        readOptionalPositiveInteger(agent, "max_turns", "agent.max_turns") ??
        DEFAULT_MAX_TURNS,
      retryBaseDelayMs:
        readOptionalIntegerLike(
          agent,
          "retry_base_delay_ms",
          "agent.retry_base_delay_ms"
        ) ?? DEFAULT_BASE_DELAY_MS,
    },
    runtime,
    codex: codexConfig,
    lifecycle: {
      stateFieldName,
      activeStates,
      terminalStates,
      planningStates,
    },
    format: "front-matter",
    githubProjectId: readOptionalString(tracker, "project_id", env),
    agentCommand,
    hookPath: readOptionalString(hooks, "after_create", env),
    maxConcurrentByState: maxConcurrentAgentsByState,
  };

  return parsed;
}

const DEPRECATED_TRACKER_PROVIDER_KEYS = [
  "api_key",
  "project_slug",
  "project_id",
  "endpoint",
  "state_field",
  "priority",
  "priority_field",
  "pickup_labels",
  "blocker_check_states",
  "planning_states",
] as const;

function readProviderConfig(
  tracker: Record<string, WorkflowFrontMatterNode>
): Record<string, unknown> {
  if (tracker.provider === undefined || tracker.provider === null) {
    return {};
  }
  if (typeof tracker.provider !== "object" || Array.isArray(tracker.provider)) {
    throw new Error(
      'Workflow front matter field "tracker.provider" must be an object when provided.'
    );
  }
  return { ...tracker.provider };
}

function promoteDeprecatedTrackerKeys(
  tracker: Record<string, WorkflowFrontMatterNode>,
  provider: Record<string, unknown>
): string[] {
  const deprecatedKeys: string[] = [];
  for (const key of DEPRECATED_TRACKER_PROVIDER_KEYS) {
    if (tracker[key] === undefined || tracker[key] === null) {
      continue;
    }
    deprecatedKeys.push(key);
    if (!(key in provider)) {
      provider[key] = tracker[key];
    }
  }
  return deprecatedKeys;
}

function readProviderOptionalString(
  provider: Record<string, unknown>,
  key: string,
  env: NodeJS.ProcessEnv
): string | null {
  const value = provider[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new WorkflowValidationError(
      "workflow_validation_error",
      `tracker.provider.${key}`,
      `Workflow front matter field "tracker.provider.${key}" must be a string.`
    );
  }
  return resolveEnvironmentValue(value, env, `tracker.provider.${key}`);
}

function readNormalizedOptionalString(
  tracker: Record<string, WorkflowFrontMatterNode>,
  provider: Record<string, unknown>,
  explicitProviderKeys: ReadonlySet<string>,
  key: string,
  env: NodeJS.ProcessEnv
): string | null {
  return explicitProviderKeys.has(key)
    ? readProviderOptionalString(provider, key, env)
    : readOptionalString(tracker, key, env, `tracker.${key}`);
}

function readProviderStringList(
  provider: Record<string, unknown>,
  key: string,
  options: { rejectCommaString?: boolean } = {}
): string[] | undefined {
  const value = provider[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    if (options.rejectCommaString && value.includes(",")) {
      throw new WorkflowValidationError(
        "workflow_validation_error",
        `tracker.provider.${key}`,
        `Workflow front matter field "tracker.provider.${key}" must be an array of strings; comma-separated strings are not supported.`
      );
    }
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new WorkflowValidationError(
      "workflow_validation_error",
      `tracker.provider.${key}`,
      `Workflow front matter field "tracker.provider.${key}" must be an array of strings.`
    );
  }
  return value;
}

function readNormalizedStringList(
  tracker: Record<string, WorkflowFrontMatterNode>,
  provider: Record<string, unknown>,
  explicitProviderKeys: ReadonlySet<string>,
  key: string,
  options: { rejectCommaString?: boolean } = {}
): string[] | undefined {
  return explicitProviderKeys.has(key)
    ? readProviderStringList(provider, key, options)
    : readStringList(tracker, key, options);
}

function throwProviderValidationErrors(
  errors: WorkflowValidationError[]
): void {
  if (errors.length === 0) {
    return;
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  const [first, ...remaining] = errors;
  throw new WorkflowValidationError(
    first.code,
    first.path,
    `${first.message} (${remaining.length} additional provider validation ${remaining.length === 1 ? "error" : "errors"}: ${remaining.map((error) => error.message).join("; ")})`
  );
}

function readPickupLabelsConfig(
  tracker: Record<string, WorkflowFrontMatterNode>,
  provider: Record<string, unknown>,
  explicitProviderKeys: ReadonlySet<string>
): ParsedWorkflow["tracker"]["pickupLabels"] {
  const value =
    (explicitProviderKeys.has("pickup_labels")
      ? provider.pickup_labels
      : undefined) ??
    tracker.pickup_labels ??
    tracker.pickupLabels;
  if (value === undefined || value === null) {
    return DEFAULT_WORKFLOW_TRACKER.pickupLabels;
  }
  if (Array.isArray(value) || typeof value !== "object") {
    throw new Error(
      'Workflow front matter field "tracker.pickup_labels" must be an object when provided.'
    );
  }

  const input = value as Record<string, WorkflowFrontMatterNode>;
  return {
    include: readStringList(input, "include") ?? [],
    exclude: readStringList(input, "exclude") ?? [],
  };
}

function readPriorityConfig(
  tracker: Record<string, WorkflowFrontMatterNode>,
  provider: Record<string, unknown>,
  explicitProviderKeys: ReadonlySet<string>,
  env: NodeJS.ProcessEnv
): WorkflowPriorityConfig | null {
  const priorityValue =
    (explicitProviderKeys.has("priority") ? provider.priority : undefined) ??
    tracker.priority;
  if (priorityValue === undefined || priorityValue === null) {
    return null;
  }

  if (Array.isArray(priorityValue) || typeof priorityValue !== "object") {
    throw new Error(
      'Workflow front matter field "tracker.provider.priority" must be an object when provided.'
    );
  }
  const priority = priorityValue as Record<string, WorkflowFrontMatterNode>;
  const source = readRequiredString(priority, "source", env);
  const keys = new Set(Object.keys(priority));

  if (source === "project-field") {
    rejectPriorityKeys(keys, ["source", "field", "values"], source);
    const field = readRequiredString(priority, "field", env);
    const values = readNumberMap(priority, "values", "tracker.priority.values");
    if (Object.keys(values).length === 0) {
      throw new Error(
        'Workflow front matter field "tracker.priority.values" must be a non-empty object for tracker.priority.source "project-field".'
      );
    }
    return { source, field, values };
  }

  if (source === "labels") {
    rejectPriorityKeys(keys, ["source", "labels"], source);
    const labels = readNumberMap(priority, "labels", "tracker.priority.labels");
    if (Object.keys(labels).length === 0) {
      throw new Error(
        'Workflow front matter field "tracker.priority.labels" must be a non-empty object for tracker.priority.source "labels".'
      );
    }
    return { source, labels };
  }

  if (source === "disabled") {
    rejectPriorityKeys(keys, ["source"], source);
    return { source };
  }

  throw new Error(
    `Unsupported workflow tracker.priority.source "${source}". Supported values: project-field, labels, disabled.`
  );
}

function rejectPriorityKeys(
  keys: Set<string>,
  allowedKeys: string[],
  source: string
): void {
  const allowed = new Set(allowedKeys);
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new Error(
        `Workflow front matter field "tracker.priority.${key}" is not supported for tracker.priority.source "${source}".`
      );
    }
  }
}

function parseLegacyWorkflowMarkdown(markdown: string): ParsedWorkflow {
  const promptGuidelines =
    matchOptionalSection(markdown, "Prompt Guidelines") ?? "";

  return {
    ...DEFAULT_WORKFLOW_DEFINITION,
    tracker: {
      ...DEFAULT_WORKFLOW_DEFINITION.tracker,
      activeStates: DEFAULT_WORKFLOW_LIFECYCLE.activeStates,
      terminalStates: DEFAULT_WORKFLOW_LIFECYCLE.terminalStates,
      stateFieldName: DEFAULT_WORKFLOW_LIFECYCLE.stateFieldName,
      blockerCheckStates: [DEFAULT_WORKFLOW_LIFECYCLE.activeStates[0]!],
      planningStates: DEFAULT_WORKFLOW_LIFECYCLE.planningStates,
    },
    lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
    promptTemplate: promptGuidelines,
    format: "legacy-sectioned",
  };
}

function parseFrontMatter(
  frontMatter: string
): Record<string, WorkflowFrontMatterNode> {
  const lines = frontMatter.replace(/\r\n/g, "\n").split("\n");
  let value: WorkflowFrontMatterNode;
  try {
    const root = lines.find(
      (line) => line.trim() && !line.trim().startsWith("#")
    );
    value =
      root &&
      findMappingSeparator(root.trim()) < 0 &&
      !root.trim().startsWith("- ")
        ? parseScalar(root)
        : parseBlock(lines, 0, 0)[0];
  } catch (error) {
    if (error instanceof WorkflowValidationError) {
      throw error;
    }
    throw new WorkflowValidationError(
      "workflow_parse_error",
      "front_matter",
      error instanceof Error ? error.message : "Invalid YAML front matter."
    );
  }

  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new WorkflowValidationError(
      "workflow_front_matter_not_a_map",
      "front_matter",
      "Workflow front matter must be a YAML object."
    );
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
    if (line.trim().startsWith("#")) {
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
      const itemText = stripYamlInlineComment(trimmed.slice(2)).trim();

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
    const separatorIndex = findMappingSeparator(trimmed);
    if (separatorIndex < 0) {
      throw new Error(`Invalid workflow front matter line "${trimmed}".`);
    }

    const rawKey = trimmed.slice(0, separatorIndex).trim();
    const parsedKey = parseScalar(rawKey);
    if (typeof parsedKey !== "string") {
      throw new Error(`Invalid workflow front matter key "${rawKey}".`);
    }
    const key = parsedKey;
    const remainder = stripYamlInlineComment(
      trimmed.slice(separatorIndex + 1)
    ).trim();
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

function findMappingSeparator(value: string): number {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ":") {
      return index;
    }
  }
  return -1;
}

function parseScalar(value: string): WorkflowFrontMatterNode {
  value = stripYamlInlineComment(value).trim();
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    return parseInlineArray(value);
  }
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      throw new Error(
        `Invalid quoted workflow front matter scalar "${value}".`
      );
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function stripYamlInlineComment(value: string): string {
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (quote) {
      if (quote === '"' && char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "#" && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
      return value.slice(0, index).trimEnd();
    }
  }

  return value;
}

function parseInlineArray(value: string): WorkflowFrontMatterNode[] {
  const inner = value.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  return splitInlineArrayEntries(inner).map((entry) => parseScalar(entry));
}

function splitInlineArrayEntries(inner: string): string[] {
  const entries: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ",") {
      pushInlineArrayEntry(entries, current, "middle");
      current = "";
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error(
      "Workflow front matter inline array has an unterminated string."
    );
  }

  pushInlineArrayEntry(entries, current, "end");
  return entries;
}

function pushInlineArrayEntry(
  entries: string[],
  entry: string,
  position: "middle" | "end"
): void {
  const trimmed = entry.trim();
  if (!trimmed) {
    const reason =
      position === "end" ? "has a trailing comma" : "contains an empty item";
    throw new Error(`Workflow front matter inline array ${reason}.`);
  }
  entries.push(trimmed);
}

function parseRuntimeConfig(
  runtime: Record<string, WorkflowFrontMatterNode>,
  env: NodeJS.ProcessEnv
): WorkflowRuntimeConfig {
  const kind = readRuntimeKind(runtime, env);
  const isolation = readObject(runtime, "isolation", "runtime.isolation");
  const auth = readObject(runtime, "auth", "runtime.auth");
  const timeouts = readObject(runtime, "timeouts", "runtime.timeouts");
  const configuredCommand = readOptionalString(runtime, "command", env);
  const command = configuredCommand ?? defaultRuntimeCommand(kind);

  if (!command) {
    throw new Error(
      'Workflow front matter field "runtime.command" is required for runtime.kind "custom".'
    );
  }

  return {
    kind,
    command,
    args: readRuntimeArgs(runtime),
    isolation: {
      bare:
        readOptionalBoolean(isolation, "bare", "runtime.isolation.bare") ??
        false,
      strictMcpConfig:
        readOptionalBoolean(
          isolation,
          "strict_mcp_config",
          "runtime.isolation.strict_mcp_config"
        ) ?? false,
      trustRepoConfig:
        readOptionalBoolean(
          isolation,
          "trust_repo_config",
          "runtime.isolation.trust_repo_config"
        ) ?? false,
    },
    auth: {
      env: readOptionalString(auth, "env", env),
    },
    timeouts: {
      turnTimeoutMs:
        readOptionalIntegerLike(timeouts, "turn_timeout_ms") ??
        DEFAULT_TURN_TIMEOUT_MS,
      readTimeoutMs:
        readOptionalIntegerLike(timeouts, "read_timeout_ms") ??
        DEFAULT_READ_TIMEOUT_MS,
      stallTimeoutMs:
        readOptionalIntegerLike(timeouts, "stall_timeout_ms") ??
        DEFAULT_STALL_TIMEOUT_MS,
    },
  };
}

function readRuntimeKind(
  runtime: Record<string, WorkflowFrontMatterNode>,
  env: NodeJS.ProcessEnv
): WorkflowRuntimeKind {
  const kind = readRequiredString(runtime, "kind", env);
  if (
    kind === "codex-app-server" ||
    kind === "claude-print" ||
    kind === "custom"
  ) {
    return kind;
  }

  throw new Error(
    `Unsupported workflow runtime kind "${kind}". Supported values: codex-app-server, claude-print, custom.`
  );
}

function defaultRuntimeCommand(kind: WorkflowRuntimeKind): string | null {
  if (kind === "claude-print") {
    return DEFAULT_CLAUDE_COMMAND;
  }
  if (kind === "codex-app-server") {
    return DEFAULT_AGENT_COMMAND;
  }
  return null;
}

function readObject(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string,
  path = key
): Record<string, WorkflowFrontMatterNode> {
  const value = input[key];
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Workflow front matter field "${path}" must be an object.`);
  }
  return value as Record<string, WorkflowFrontMatterNode>;
}

function readOptionalRuntimeObject(
  input: Record<string, WorkflowFrontMatterNode>
): Record<string, WorkflowFrontMatterNode> | null {
  if (input.runtime === undefined || input.runtime === null) {
    return null;
  }
  return readObject(input, "runtime");
}

function readOptionalExtensionObject(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string
): Record<string, unknown> | null {
  if (input[key] === undefined || input[key] === null) {
    return null;
  }
  return readObject(input, key) as Record<string, unknown>;
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
  env: NodeJS.ProcessEnv,
  path = key
): string | null {
  const value = input[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Workflow front matter field "${path}" must be a string.`);
  }
  return resolveEnvironmentValue(value, env, path);
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
  env: NodeJS.ProcessEnv,
  path = key
): string {
  const value = readOptionalString(input, key, env, path);
  if (!value) {
    throw new Error(`Workflow front matter field "${path}" is required.`);
  }
  return value;
}

function readStringList(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string,
  options: { rejectCommaString?: boolean } = {}
): string[] | undefined {
  const value = input[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" && !options.rejectCommaString) {
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
      `Workflow front matter field "${key}" must be an array of strings${options.rejectCommaString ? "" : " or comma-separated string"}.`
    );
  }
  return value as string[];
}

function readRuntimeArgs(
  input: Record<string, WorkflowFrontMatterNode>
): string[] {
  const value = input.args;
  if (value === undefined || value === null) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(
      'Workflow front matter field "runtime.args" must be an array of strings.'
    );
  }
  return value as string[];
}

function readOptionalBoolean(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string,
  path = key
): boolean | null {
  const value = input[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Workflow front matter field "${path}" must be a boolean.`);
  }
  return value;
}

function readOptionalIntegerLike(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string,
  path = key
): number | null {
  const value = input[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  throw new WorkflowValidationError(
    "workflow_validation_error",
    path,
    `Workflow front matter field "${path}" must be an integer.`
  );
}

function readOptionalPositiveInteger(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string,
  path: string
): number | null {
  const value = readOptionalIntegerLike(input, key, path);
  if (value !== null && value <= 0) {
    throw new WorkflowValidationError(
      "workflow_validation_error",
      path,
      `Workflow front matter field "${path}" must be a positive integer.`
    );
  }
  return value;
}

function readOptionalNonEmptyString(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string,
  env: NodeJS.ProcessEnv,
  path: string
): string | null {
  const value = readOptionalString(input, key, env, path);
  if (value !== null && value.trim().length === 0) {
    throw new WorkflowValidationError(
      "workflow_validation_error",
      path,
      `Workflow front matter field "${path}" must be a non-empty string when provided.`
    );
  }
  return value;
}

function readNumberMap(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string,
  path = key,
  options: { positive?: boolean } = {}
): Record<string, number> {
  const value = input[key];
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Workflow front matter field "${path}" must be an object.`);
  }

  const result: Record<string, number> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "number" && Number.isInteger(entryValue)) {
      if (options.positive && entryValue <= 0) {
        throw new WorkflowValidationError(
          "workflow_validation_error",
          `${path}.${entryKey}`,
          `Workflow front matter field "${path}.${entryKey}" must be a positive integer.`
        );
      }
      result[entryKey] = entryValue;
      continue;
    }
    throw new WorkflowValidationError(
      "workflow_validation_error",
      `${path}.${entryKey}`,
      `Workflow front matter field "${path}.${entryKey}" must be an integer.`
    );
  }
  return result;
}

function resolveEnvironmentValue(
  value: string,
  env: NodeJS.ProcessEnv,
  path: string
): string {
  const envTokenMatch = value.match(/^(?:env:)?([A-Z0-9_]+)$/);
  if (value.startsWith("env:") && envTokenMatch) {
    const resolved = env[envTokenMatch[1]];
    if (!resolved) {
      throw new WorkflowValidationError(
        "workflow_validation_error",
        path,
        `Workflow front matter field "${path}" requires environment variable ${envTokenMatch[1]}.`
      );
    }
    return resolved;
  }

  const dollarEnvTokenMatch = value.match(/^\$([A-Z0-9_]+)$/);
  if (dollarEnvTokenMatch) {
    const resolved = env[dollarEnvTokenMatch[1]];
    if (!resolved) {
      throw new WorkflowValidationError(
        "workflow_validation_error",
        path,
        `Workflow front matter field "${path}" requires environment variable ${dollarEnvTokenMatch[1]}.`
      );
    }
    return resolved;
  }

  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const resolved = env[name];
    if (!resolved) {
      throw new WorkflowValidationError(
        "workflow_validation_error",
        path,
        `Workflow front matter field "${path}" requires environment variable ${name}.`
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
