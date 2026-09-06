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
  type WorkflowDiagnostic,
  type WorkflowCodexConfig,
  type WorkflowPriorityConfig,
  type WorkflowRuntimeConfig,
  type WorkflowRuntimeKind,
  resolveWorkflowRuntimeCommand,
} from "./config.js";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DEFAULT_WORKFLOW_LIFECYCLE,
  normalizeWorkflowState,
  type WorkflowLifecycleConfig,
} from "./lifecycle.js";
import { normalizeLabels } from "./normalization.js";
import { isCustomRuntimeReservedAuthEnvironmentName } from "../runtime/custom-child-env.js";

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
  /** Absolute or relative path of the selected WORKFLOW.md, when known. */
  workflowPath?: string;
  /** Test seam for deterministic home-directory expansion. */
  homeDir?: string;
};

export type WorkflowConfigTrackerAdapter = {
  validateProviderConfig?: (
    provider: Record<string, unknown>,
    context?: { rawProvider: Record<string, unknown> }
  ) => WorkflowValidationError[];
  defaultLifecycle?: () => WorkflowLifecycleConfig;
  /** Non-secret credential variable names reserved by the selected tracker. */
  secretEnvironmentNames?: () => string[];
};

export type WorkflowValidationErrorCode =
  | "workflow_parse_error"
  | "workflow_front_matter_not_a_map"
  | "workflow_deprecated_key"
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

/**
 * Parses a legacy workflow only to render an operator migration. Runtime and
 * validation callers must use parseWorkflowMarkdown, which rejects flat keys.
 */
export function parseWorkflowMarkdownForMigration(
  markdown: string,
  env: NodeJS.ProcessEnv = process.env,
  options: ParseWorkflowOptions = {}
): ParsedWorkflow {
  try {
    return parseWorkflowMarkdownInternal(markdown, env, options, true);
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
  options: ParseWorkflowOptions,
  allowDeprecatedTrackerKeys = false
): ParsedWorkflow {
  const compatibilityMode = options.compatibilityMode ?? "strict";
  const frontMatterMatch = markdown.match(
    /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)([\s\S]*)$/
  );

  if (!frontMatterMatch) {
    if (/^---(?:\r?\n|$)/.test(markdown)) {
      throw new WorkflowValidationError(
        "workflow_parse_error",
        "front_matter",
        "WORKFLOW.md has unterminated YAML front matter."
      );
    }
    if (
      compatibilityMode === "legacy" &&
      markdown.startsWith("## Prompt Guidelines")
    ) {
      return parseLegacyWorkflowMarkdown(markdown);
    }
    return parseWorkflowConfig(
      {},
      markdown.trim(),
      env,
      options,
      allowDeprecatedTrackerKeys
    );
  }

  const [, rawFrontMatter = "", rawPromptTemplate = ""] = frontMatterMatch;
  const frontMatter = parseFrontMatter(rawFrontMatter);
  return parseWorkflowConfig(
    frontMatter,
    rawPromptTemplate.trim(),
    env,
    options,
    allowDeprecatedTrackerKeys
  );
}

function parseWorkflowConfig(
  frontMatter: Record<string, WorkflowFrontMatterNode>,
  promptTemplate: string,
  env: NodeJS.ProcessEnv,
  options: ParseWorkflowOptions,
  allowDeprecatedTrackerKeys: boolean
): ParsedWorkflow {
  const tracker = readObject(frontMatter, "tracker");
  const polling = readObject(frontMatter, "polling");
  const workspace = readObject(frontMatter, "workspace");
  const server = readObject(frontMatter, "server");
  const hooks = readObject(frontMatter, "hooks");
  const agent = readObject(frontMatter, "agent");
  const runtimeNode = readOptionalRuntimeObject(frontMatter);
  const hasRuntime = runtimeNode !== null;
  const codex = readObject(frontMatter, "codex");

  const trackerKind = readOptionalString(tracker, "kind", "tracker.kind");
  const supportedTrackerKinds =
    options.supportedTrackerKinds ?? DEFAULT_SUPPORTED_TRACKER_KINDS;
  if (trackerKind && !supportedTrackerKinds.includes(trackerKind)) {
    throw new WorkflowValidationError(
      "workflow_validation_error",
      "tracker.kind",
      `Unsupported workflow tracker.kind "${trackerKind}". Supported values: ${supportedTrackerKinds.join(", ")}.`
    );
  }
  const trackerAdapter = trackerKind
    ? (options.resolveTrackerAdapter?.(trackerKind) ?? options.trackerAdapter)
    : options.trackerAdapter;
  const deprecatedKeys = findDeprecatedTrackerKeys(tracker);
  if (deprecatedKeys.length > 0 && !allowDeprecatedTrackerKeys) {
    throwDeprecatedTrackerKeysError(deprecatedKeys);
  }
  const provider = readProviderConfig(tracker);
  if (allowDeprecatedTrackerKeys) {
    promoteDeprecatedTrackerKeys(tracker, provider);
  }
  const resolvedProvider = resolveProviderEnvironmentValues(
    provider,
    env,
    "tracker.provider"
  );
  const defaultLifecycle = trackerAdapter?.defaultLifecycle?.();
  // Keep existing workflows usable while tracker adapters adopt defaultLifecycle.
  // This disables the required-lifecycle path until every supported adapter
  // owns its lifecycle defaults; adapter-provided defaults still take precedence.
  const legacyLifecycle = DEFAULT_WORKFLOW_LIFECYCLE;
  const activeStates =
    readProviderStringList(provider, "active_states", {
      rejectCommaString: true,
    }) ??
    readStringList(tracker, "active_states", { rejectCommaString: true }) ??
    defaultLifecycle?.activeStates ??
    legacyLifecycle.activeStates;
  const terminalStates =
    readProviderStringList(provider, "terminal_states", {
      rejectCommaString: true,
    }) ??
    readStringList(tracker, "terminal_states", { rejectCommaString: true }) ??
    defaultLifecycle?.terminalStates ??
    legacyLifecycle.terminalStates;
  const blockerCheckStates =
    readNormalizedStringList(provider, "blocker_check_states") ??
    (activeStates[0] ? [activeStates[0]] : []);
  const planningStates =
    readNormalizedStringList(provider, "planning_states") ??
    defaultLifecycle?.planningStates ??
    DEFAULT_WORKFLOW_TRACKER.planningStates;
  const requiredLabels =
    readRequiredLabelList(tracker) ?? DEFAULT_WORKFLOW_TRACKER.requiredLabels;
  const stateFieldName =
    readNormalizedOptionalString(provider, "state_field", env) ??
    defaultLifecycle?.stateFieldName ??
    legacyLifecycle.stateFieldName;
  throwProviderValidationErrors(
    trackerAdapter?.validateProviderConfig?.(resolvedProvider, {
      rawProvider: provider,
    }) ?? []
  );

  const stateConcurrency = readMaxConcurrentAgentsByState(
    agent,
    "max_concurrent_agents_by_state",
    "agent.max_concurrent_agents_by_state"
  );

  const approvalPolicy = readOptionalString(
    codex,
    "approval_policy",
    "codex.approval_policy"
  );
  if (approvalPolicy !== null && approvalPolicy !== "never") {
    throw new WorkflowValidationError(
      "workflow_validation_error",
      "codex.approval_policy",
      'Workflow front matter field "codex.approval_policy" supports only "never" because approval requests cannot be handled.'
    );
  }
  const codexConfig = {
    command:
      readOptionalNonEmptyString(codex, "command", env, "codex.command") ??
      DEFAULT_AGENT_COMMAND,
    approvalPolicy,
    threadSandbox: readOptionalString(codex, "thread_sandbox"),
    turnSandboxPolicy: readOptionalString(codex, "turn_sandbox_policy"),
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
  const runtime = hasRuntime
    ? parseRuntimeConfig(runtimeNode, codexConfig, env, options)
    : null;
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
        readNormalizedOptionalString(provider, "endpoint", env) ??
        (trackerKind === "linear" ? DEFAULT_LINEAR_GRAPHQL_URL : null),
      apiKey: readNormalizedOptionalSecret(provider, "api_key", env),
      projectSlug: readNormalizedOptionalString(provider, "project_slug", env),
      pickupLabels: readPickupLabelsConfig(provider),
      requiredLabels,
      activeStates,
      terminalStates,
      projectId: readNormalizedOptionalString(provider, "project_id", env),
      stateFieldName,
      priority: readPriorityConfig(provider),
      priorityFieldName: readNormalizedOptionalString(
        provider,
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
    server: {
      port: readOptionalPort(server, "port", "server.port"),
    },
    workspace: {
      root: readOptionalPath(workspace, "root", env, "workspace.root", options),
    },
    hooks: {
      afterCreate: readOptionalString(hooks, "after_create"),
      beforeRun: readOptionalString(hooks, "before_run"),
      afterRun: readOptionalString(hooks, "after_run"),
      beforeRemove: readOptionalString(hooks, "before_remove"),
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
      maxConcurrentAgentsByState: stateConcurrency.limits,
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
      requiredLabels,
    },
    format: "front-matter",
    githubProjectId: readNormalizedOptionalString(provider, "project_id", env),
    agentCommand,
    hookPath: readOptionalString(hooks, "after_create"),
    maxConcurrentByState: stateConcurrency.limits,
    diagnostics: stateConcurrency.diagnostics,
  };

  return parsed;
}

/** Resolve provider values before adapter validation, as required by the spec. */
function resolveProviderEnvironmentValues(
  provider: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  path = "tracker.provider"
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(provider).map(([key, value]) => {
      const valuePath = `${path}.${key}`;
      if (typeof value === "string") {
        return [key, resolveEnvironmentValue(value, env, valuePath)];
      }
      if (Array.isArray(value)) {
        return [
          key,
          value.map((entry, index) =>
            typeof entry === "string"
              ? resolveEnvironmentValue(entry, env, `${valuePath}[${index}]`)
              : entry
          ),
        ];
      }
      if (value && typeof value === "object") {
        return [
          key,
          resolveProviderEnvironmentValues(
            value as Record<string, unknown>,
            env,
            valuePath
          ),
        ];
      }
      return [key, value];
    })
  );
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

function findDeprecatedTrackerKeys(
  tracker: Record<string, WorkflowFrontMatterNode>
): string[] {
  return DEPRECATED_TRACKER_PROVIDER_KEYS.filter((key) => key in tracker);
}

function throwDeprecatedTrackerKeysError(keys: readonly string[]): never {
  const paths = keys.map((key) => `tracker.${key}`);
  throw new WorkflowValidationError(
    "workflow_deprecated_key",
    paths[0] ?? "tracker",
    `Deprecated workflow key(s) ${paths.join(", ")} are not supported in this major release. Move them under tracker.provider. Run 'gh-symphony doctor' for a copyable provider block.`
  );
}

function promoteDeprecatedTrackerKeys(
  tracker: Record<string, WorkflowFrontMatterNode>,
  provider: Record<string, unknown>
): void {
  for (const key of DEPRECATED_TRACKER_PROVIDER_KEYS) {
    if (tracker[key] === undefined || tracker[key] === null) {
      continue;
    }
    if (!(key in provider)) {
      provider[key] = tracker[key];
    }
  }
}

function readProviderOptionalString(
  provider: Record<string, unknown>,
  key: string
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
  return value;
}

function readNormalizedOptionalString(
  provider: Record<string, unknown>,
  key: string,
  env: NodeJS.ProcessEnv
): string | null {
  const value = readProviderOptionalString(provider, key);
  return value === null
    ? null
    : resolveEnvironmentValue(value, env, `tracker.provider.${key}`);
}

function readNormalizedOptionalSecret(
  provider: Record<string, unknown>,
  key: string,
  env: NodeJS.ProcessEnv
): string | null {
  const path = `tracker.provider.${key}`;
  const value = readProviderOptionalString(provider, key);
  return value === null ? null : resolveEnvironmentValue(value, env, path);
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
  provider: Record<string, unknown>,
  key: string,
  options: { rejectCommaString?: boolean } = {}
): string[] | undefined {
  return readProviderStringList(provider, key, options);
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
  provider: Record<string, unknown>
): ParsedWorkflow["tracker"]["pickupLabels"] {
  const value = provider.pickup_labels;
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
    include: normalizeLabels(readStringList(input, "include") ?? []),
    exclude: normalizeLabels(readStringList(input, "exclude") ?? []),
  };
}

function readRequiredLabelList(
  tracker: Record<string, WorkflowFrontMatterNode>
): string[] | undefined {
  const value = tracker.required_labels;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new WorkflowValidationError(
      "workflow_validation_error",
      "tracker.required_labels",
      'Workflow front matter field "tracker.required_labels" must be an array of strings.'
    );
  }

  // §5.3.1 requires blank configured labels to remain unsatisfied. The shared
  // normalizeLabels helper drops blanks, so it is intentionally not used here.
  return (value as string[]).map((label) => label.trim().toLowerCase());
}

function readPriorityConfig(
  provider: Record<string, unknown>
): WorkflowPriorityConfig | null {
  const priorityValue = provider.priority;
  if (priorityValue === undefined || priorityValue === null) {
    return null;
  }

  if (Array.isArray(priorityValue) || typeof priorityValue !== "object") {
    throw new Error(
      'Workflow front matter field "tracker.provider.priority" must be an object when provided.'
    );
  }
  const priority = priorityValue as Record<string, WorkflowFrontMatterNode>;
  const source = readRequiredString(priority, "source");
  const keys = new Set(Object.keys(priority));

  if (source === "project-field") {
    rejectPriorityKeys(keys, ["source", "field", "values"], source);
    const field = readRequiredString(priority, "field");
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
    diagnostics: [],
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
  codex: WorkflowCodexConfig,
  env: NodeJS.ProcessEnv,
  options: ParseWorkflowOptions
): WorkflowRuntimeConfig {
  const kind = readRuntimeKind(runtime);
  const isolation = readObject(runtime, "isolation", "runtime.isolation");
  const auth = readObject(runtime, "auth", "runtime.auth");
  const timeouts = readObject(runtime, "timeouts", "runtime.timeouts");
  const turnTimeoutMs = readOptionalIntegerLike(timeouts, "turn_timeout_ms");
  const readTimeoutMs = readOptionalIntegerLike(timeouts, "read_timeout_ms");
  const stallTimeoutMs = readOptionalIntegerLike(timeouts, "stall_timeout_ms");
  const configuredCommand = readOptionalString(runtime, "command");
  const command = configuredCommand ?? defaultRuntimeCommand(kind);

  if (!command) {
    throw new Error(
      'Workflow front matter field "runtime.command" is required for runtime.kind "custom".'
    );
  }

  const inheritEnvironment =
    readOptionalBoolean(
      isolation,
      "inherit_environment",
      "runtime.isolation.inherit_environment"
    ) ?? false;
  if (inheritEnvironment && kind !== "custom") {
    throw new WorkflowValidationError(
      "workflow_validation_error",
      "runtime.isolation.inherit_environment",
      'Workflow front matter field "runtime.isolation.inherit_environment" is supported only for runtime.kind "custom".'
    );
  }

  const authEnv = readOptionalString(auth, "env");
  if (
    kind === "custom" &&
    authEnv &&
    isCustomRuntimeReservedAuthEnvironmentName(
      authEnv,
      env,
      options.trackerAdapter?.secretEnvironmentNames?.() ?? []
    )
  ) {
    throw new WorkflowValidationError(
      "workflow_validation_error",
      "runtime.auth.env",
      `Workflow front matter field "runtime.auth.env" cannot use reserved credential environment name "${authEnv}".`
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
      inheritEnvironment,
    },
    auth: {
      env: authEnv,
    },
    timeouts: {
      turnTimeoutMs: turnTimeoutMs ?? codex.turnTimeoutMs,
      readTimeoutMs: readTimeoutMs ?? codex.readTimeoutMs,
      stallTimeoutMs: stallTimeoutMs ?? codex.stallTimeoutMs,
    },
    timeoutSources: {
      turnTimeoutMs:
        turnTimeoutMs === null ? "codex/defaults" : "runtime.timeouts",
      readTimeoutMs:
        readTimeoutMs === null ? "codex/defaults" : "runtime.timeouts",
      stallTimeoutMs:
        stallTimeoutMs === null ? "codex/defaults" : "runtime.timeouts",
    },
  };
}

function readRuntimeKind(
  runtime: Record<string, WorkflowFrontMatterNode>
): WorkflowRuntimeKind {
  const kind = readRequiredString(runtime, "kind");
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

function readOptionalString(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string,
  path = key
): string | null {
  const value = input[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Workflow front matter field "${path}" must be a string.`);
  }
  return value;
}

function readOptionalPath(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string,
  env: NodeJS.ProcessEnv,
  path: string,
  options: ParseWorkflowOptions
): string | null {
  const value = readOptionalString(input, key, path);
  if (value === null) {
    return null;
  }
  const expanded = resolvePathEnvironmentValue(value, env, path);
  const normalized = expandHomeDirectory(expanded, options.homeDir);
  return resolve(
    options.workflowPath ? dirname(options.workflowPath) : process.cwd(),
    normalized
  );
}

function expandHomeDirectory(value: string, homeDir = homedir()): string {
  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homeDir, value.slice(2));
  }
  return value;
}

function readOptionalWorkflowString(
  input: Record<string, WorkflowFrontMatterNode>,
  primaryKey: string,
  fallbackKey: string,
  _env: NodeJS.ProcessEnv
): string | null {
  return (
    readOptionalString(input, primaryKey) ??
    readOptionalString(input, fallbackKey)
  );
}

function readRequiredString(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string,
  path = key
): string {
  const value = readOptionalString(input, key, path);
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

function readOptionalPort(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string,
  path: string
): number | null {
  const value = readOptionalIntegerLike(input, key, path);
  if (value !== null && (value < 0 || value > 65_535)) {
    throw new WorkflowValidationError(
      "workflow_validation_error",
      path,
      `Workflow front matter field "${path}" must be a port number between 0 and 65535.`
    );
  }
  return value;
}

function readOptionalNonEmptyString(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string,
  _env: NodeJS.ProcessEnv,
  path: string
): string | null {
  const value = readOptionalString(input, key, path);
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

function readMaxConcurrentAgentsByState(
  input: Record<string, WorkflowFrontMatterNode>,
  key: string,
  path = key
): { limits: Record<string, number>; diagnostics: WorkflowDiagnostic[] } {
  const value = input[key];
  if (value === undefined || value === null) {
    return { limits: {}, diagnostics: [] };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Workflow front matter field "${path}" must be an object.`);
  }

  const result: Record<string, number> = {};
  const sourcePaths: Record<string, string> = {};
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const [entryKey, entryValue] of Object.entries(value)) {
    const entryPath = formatWorkflowMapEntryPath(path, entryKey);
    if (typeof entryValue !== "number" || !Number.isInteger(entryValue)) {
      diagnostics.push({
        code: "state_concurrency_entry_ignored",
        path: entryPath,
        reason: "must be a positive YAML integer",
        remediation:
          "Use a whole number greater than zero, or remove the entry.",
      });
      continue;
    }
    if (entryValue <= 0) {
      diagnostics.push({
        code: "state_concurrency_entry_ignored",
        path: entryPath,
        reason: "must be greater than zero",
        remediation:
          "Use a whole number greater than zero, or remove the entry.",
      });
      continue;
    }

    const normalizedKey = normalizeWorkflowState(entryKey);
    if (normalizedKey) {
      const previousPath = sourcePaths[normalizedKey];
      if (previousPath) {
        diagnostics.push({
          code: "state_concurrency_entry_ignored",
          path: previousPath,
          reason: `duplicates ${entryPath} after state-name normalization`,
          remediation:
            "Remove one of the entries that normalize to the same state name.",
        });
      }
      result[normalizedKey] = entryValue;
      sourcePaths[normalizedKey] = entryPath;
    } else {
      diagnostics.push({
        code: "state_concurrency_entry_ignored",
        path: entryPath,
        reason: "state name is blank after normalization",
        remediation: "Use a non-blank state name, or remove the entry.",
      });
    }
  }
  return { limits: result, diagnostics };
}

function formatWorkflowMapEntryPath(path: string, entryKey: string): string {
  return entryKey !== entryKey.trim()
    ? `${path}[${JSON.stringify(entryKey)}]`
    : `${path}.${entryKey}`;
}

export function resolveEnvironmentValue(
  value: string,
  env: NodeJS.ProcessEnv,
  path: string
): string {
  if (value.startsWith("env:")) {
    const name = value.slice("env:".length);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new WorkflowValidationError(
        "workflow_validation_error",
        path,
        `Workflow front matter field "${path}" has invalid environment variable name ${name}.`
      );
    }
    const resolved = env[name];
    if (!resolved) {
      throw new WorkflowValidationError(
        "workflow_validation_error",
        path,
        `Workflow front matter field "${path}" requires environment variable ${name}.`
      );
    }
    return resolved;
  }

  const match = value.match(
    /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/
  );
  if (!match) {
    return value;
  }

  const name = match[1] ?? match[2]!;
  const resolved = env[name];
  if (!resolved) {
    throw new WorkflowValidationError(
      "workflow_validation_error",
      path,
      `Workflow front matter field "${path}" requires environment variable ${name}.`
    );
  }
  return resolved;
}

function resolvePathEnvironmentValue(
  value: string,
  env: NodeJS.ProcessEnv,
  path: string
): string {
  if (value.startsWith("env:")) {
    return resolveEnvironmentValue(value, env, path);
  }

  return value.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_, bracedName: string | undefined, plainName: string | undefined) => {
      const name = bracedName ?? plainName!;
      const resolved = env[name];
      if (!resolved) {
        throw new WorkflowValidationError(
          "workflow_validation_error",
          path,
          `Workflow front matter field "${path}" requires environment variable ${name}.`
        );
      }
      return resolved;
    }
  );
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
