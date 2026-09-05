import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgentChildEnvironmentAssignments,
  buildAgentInputRequiredReason,
  CUSTOM_RUNTIME_RESERVED_AUTH_ENVIRONMENT_NAMES,
  DEFAULT_LINEAR_GRAPHQL_URL,
  prepareAgentChildHome,
  resolveAgentChildHome,
  stageDockerCliPlugins,
  stageJsonCredentialFile,
  stageGitUserIdentity,
  collectMcpSecretEnvironmentNames,
  stripCredentialEnvironmentForAgentChild,
  type AgentRuntimeAdapter,
  type AgentEvent,
  type AgentRuntimeEvent,
} from "@gh-symphony/core";
import { createGitHubGraphQLMcpServerEntry } from "@gh-symphony/tool-github-graphql";
import { createLinearGraphQLMcpServerEntry } from "@gh-symphony/tool-linear-graphql";

const DEFAULT_GITHUB_GIT_HOST = "github.com";
const DEFAULT_GITHUB_GIT_USERNAME = "x-access-token";
const DIRECT_AGENT_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT",
] as const;

export type RuntimeToolDefinition = {
  name: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: boolean;
  };
};

/**
 * The subset of a provider-native tool definition that is safe to advertise
 * to the Codex app-server. Credentials and process-launch details deliberately
 * stay on the host side of the runtime boundary.
 */
export type CodexDynamicToolSpec = {
  type: "function";
  name: string;
  description: string;
  inputSchema: RuntimeToolDefinition["inputSchema"];
};

export function createCodexDynamicToolSpecs(
  tools: readonly RuntimeToolDefinition[]
): CodexDynamicToolSpec[] {
  return tools.map(({ name, description, inputSchema }) => ({
    type: "function",
    name,
    description,
    inputSchema,
  }));
}

export type CodexRuntimeConfig = {
  projectId: string;
  workingDirectory: string;
  githubToken?: string;
  githubTokenBrokerUrl?: string;
  githubTokenBrokerSecret?: string;
  githubTokenCachePath?: string;
  agentEnv?: Record<string, string>;
  githubProjectId?: string;
  githubGraphqlApiUrl?: string;
  enableLinearGraphqlTool?: boolean;
  linearApiKey?: string;
  linearAuthorization?: string;
  linearGraphqlUrl?: string;
  extraEnv?: NodeJS.ProcessEnv;
  /** Command line to launch codex app-server. Parsed into argv and spawned without a shell. */
  agentCommand?: string;
  /** Run-scoped orchestrator context required by worker skills such as /gh-project. */
  orchestratorUrl?: string;
  orchestratorRunId?: string;
  orchestratorToken?: string;
  projectDirectory?: string;
  trustRepoConfig?: boolean;
  trackerSecretEnvironmentNames?: readonly string[];
  trackerKind?: string;
};

export type CodexRuntimePlan = {
  cwd: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  tools: RuntimeToolDefinition[];
  dynamicTools: CodexDynamicToolSpec[];
};

export class AgentRuntimeResolutionError extends Error {}

export type CodexRuntimePrepareContext = void;

export type CodexRuntimeTurnInput = void;

export type CodexRuntimeTurnResult = {
  plan: CodexRuntimePlan;
  child: ChildProcess;
};

export type CodexRuntimeEvent = AgentRuntimeEvent;

export type CodexRuntimeDependencies = {
  spawnImpl?: SpawnLike;
};

type SpawnLike = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
) => ChildProcess;

const SAFE_RUNTIME_ENV_KEYS = new Set([
  "CI",
  "CODEX_HOME",
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "PWD",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
]);

const ALLOWED_CODEX_AGENT_COMMANDS = new Set(["codex"]);

export const CODEX_PROTOCOL_EVENT_NAMES = {
  turnStarted: "turn/started",
  turnCompleted: "turn/completed",
  turnFailed: "turn/failed",
  turnCancelled: "turn/cancelled",
  toolCallRequested: "item/tool/call",
  inputRequired: "item/tool/requestUserInput",
  rateLimit: "turn/rate_limit",
  messageDelta: "item/message/delta",
} as const;

const CODEX_MESSAGE_DELTA_METHODS = new Set([
  CODEX_PROTOCOL_EVENT_NAMES.messageDelta,
  "codex/event/agent_message_content_delta",
  "codex/event/agent_message_delta",
  "item/agentMessage/delta",
]);

const CODEX_TOKEN_USAGE_METHODS = new Set([
  "thread/tokenUsage/updated",
  "total_token_usage",
  "codex/event/token_count",
]);

type CodexProtocolMessage = Record<string, unknown>;

export function createGitHubGraphQLToolDefinition(
  config: Pick<
    CodexRuntimeConfig,
    "githubToken" | "githubProjectId" | "githubGraphqlApiUrl"
  >
): RuntimeToolDefinition {
  const entry = createGitHubGraphQLMcpServerEntry(config);

  return {
    name: "github_graphql",
    description:
      "Execute GitHub GraphQL queries for the active workspace so the agent can mutate project and issue state directly.",
    command: entry.command,
    args: entry.args,
    env: entry.env,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "GraphQL query or mutation document.",
        },
        variables: {
          type: "object",
          description: "Variables for the GraphQL document.",
        },
        operationName: {
          type: "string",
          description: "Optional GraphQL operation name.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

export function createLinearGraphQLToolDefinition(
  config: Pick<
    CodexRuntimeConfig,
    "linearGraphqlUrl" | "linearAuthorization" | "linearApiKey"
  >
): RuntimeToolDefinition {
  const entry = createLinearGraphQLMcpServerEntry(config);

  return {
    name: "linear_graphql",
    description:
      "Execute a single Linear GraphQL query or mutation for the active Linear issue using runtime-managed auth.",
    command: entry.command,
    args: entry.args,
    env: entry.env,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Single GraphQL query or mutation document.",
        },
        variables: {
          type: "object",
          description: "Variables for the GraphQL document.",
        },
        operationName: {
          type: "string",
          description: "Optional GraphQL operation name.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

export function createMcpToolDefinition(
  name: string,
  server: { command: string; args?: string[]; env?: Record<string, string> }
): RuntimeToolDefinition {
  return {
    name,
    description: `Execute the configured ${name} MCP server.`,
    command: server.command,
    args: server.args ?? [],
    env: server.env ?? {},
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: true,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasNestedRateLimitPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const directKeys = [
    "limit",
    "remaining",
    "used",
    "reset",
    "resetAt",
    "resets_at",
    "reset_at",
  ];

  if (directKeys.some((key) => hasOwn(record, key))) {
    return true;
  }

  const preferredKeys = [
    "rate_limits",
    "rateLimits",
    "rate_limit",
    "rateLimit",
    "result",
  ];

  for (const key of preferredKeys) {
    if (hasOwn(record, key) && hasNestedRateLimitPayload(record[key])) {
      return true;
    }
  }

  return false;
}

export function getCodexObservabilityEventName(
  event: AgentEvent
): string | undefined {
  return event.payload.observabilityEvent;
}

export function normalizeCodexRuntimeEvents(
  message: CodexProtocolMessage
): AgentEvent[] {
  const method =
    typeof message.method === "string" ? message.method : undefined;
  if (!method) {
    return [];
  }

  const params = asRecord(message.params);
  const events: AgentEvent[] = [];

  if (method === CODEX_PROTOCOL_EVENT_NAMES.turnStarted) {
    events.push({
      name: "agent.turnStarted",
      payload: {
        observabilityEvent: method,
        params,
      },
    });
    return events;
  }

  if (method === CODEX_PROTOCOL_EVENT_NAMES.toolCallRequested) {
    events.push({
      name: "agent.toolCallRequested",
      payload: {
        observabilityEvent: method,
        params,
        callId: typeof params.callId === "string" ? params.callId : "",
        toolName: typeof params.tool === "string" ? params.tool : "",
        threadId: typeof params.threadId === "string" ? params.threadId : "",
        turnId: typeof params.turnId === "string" ? params.turnId : "",
        arguments: params.arguments,
      },
    });
    return events;
  }

  if (method === CODEX_PROTOCOL_EVENT_NAMES.inputRequired) {
    events.push({
      name: "agent.inputRequired",
      payload: {
        observabilityEvent: method,
        params,
        reason: buildAgentInputRequiredReason(params.prompt),
      },
    });
    return events;
  }

  if (CODEX_TOKEN_USAGE_METHODS.has(method)) {
    events.push({
      name: "agent.tokenUsageUpdated",
      payload: {
        observabilityEvent: method,
        params,
      },
    });
    return events;
  }

  if (CODEX_MESSAGE_DELTA_METHODS.has(method)) {
    events.push({
      name: "agent.messageDelta",
      payload: {
        observabilityEvent: method,
        params,
        delta: typeof params.delta === "string" ? params.delta : "",
        itemId: typeof params.item_id === "string" ? params.item_id : "",
      },
    });
    return events;
  }

  if (method === CODEX_PROTOCOL_EVENT_NAMES.rateLimit) {
    events.push({
      name: "agent.rateLimit",
      payload: {
        observabilityEvent: method,
        params,
      },
    });
    return events;
  }

  if (method === CODEX_PROTOCOL_EVENT_NAMES.turnCompleted) {
    if (hasOwn(params, "usage")) {
      events.push({
        name: "agent.tokenUsageUpdated",
        payload: {
          observabilityEvent: method,
          params: asRecord(params.usage),
          suppressUpdate: true,
        },
      });
    }

    if (hasNestedRateLimitPayload(params)) {
      events.push({
        name: "agent.rateLimit",
        payload: {
          observabilityEvent: method,
          params,
          suppressUpdate: true,
        },
      });
    }

    events.push({
      name: "agent.turnCompleted",
      payload: {
        observabilityEvent: method,
        params,
        inputRequired: params.inputRequired === true,
      },
    });
    return events;
  }

  if (method === CODEX_PROTOCOL_EVENT_NAMES.turnFailed) {
    events.push({
      name: "agent.turnFailed",
      payload: {
        observabilityEvent: method,
        params,
      },
    });
    return events;
  }

  if (method === CODEX_PROTOCOL_EVENT_NAMES.turnCancelled) {
    events.push({
      name: "agent.turnCancelled",
      payload: {
        observabilityEvent: method,
        params,
      },
    });
    return events;
  }

  if (method === "error") {
    events.push({
      name: "agent.error",
      payload: {
        observabilityEvent: method,
        params,
        error: JSON.stringify(params),
      },
    });
    return events;
  }

  return events;
}

export function resolvePreparedAgentEnvironment(
  env?: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    DIRECT_AGENT_ENV_KEYS.flatMap((key) => {
      const value = env?.[key];
      return typeof value === "string" && value.length > 0
        ? [[key, value]]
        : [];
    })
  );
}

export function parseAgentCommand(command: string): {
  command: string;
  args: string[];
} {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of command.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    if (";&|`$<>".includes(char)) {
      throw new AgentRuntimeResolutionError(
        `Unsupported shell metacharacter in agentCommand: ${char}`
      );
    }
    current += char;
  }

  if (escaped || quote) {
    throw new AgentRuntimeResolutionError("Unterminated agentCommand quoting.");
  }
  if (current) {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    throw new AgentRuntimeResolutionError("agentCommand must not be empty.");
  }
  const [binary, ...args] = tokens;
  if (!ALLOWED_CODEX_AGENT_COMMANDS.has(binary!)) {
    throw new AgentRuntimeResolutionError(
      `Unsupported agentCommand executable "${binary}". Allowed executables: ${[
        ...ALLOWED_CODEX_AGENT_COMMANDS,
      ].join(", ")}.`
    );
  }
  return { command: binary!, args };
}

function resolveRuntimeProcessEnv(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        (SAFE_RUNTIME_ENV_KEYS.has(entry[0]) || entry[0].startsWith("LC_"))
    )
  );
}

/**
 * Build the `codex app-server` launch plan for the target working directory.
 */
export function buildCodexRuntimePlan(
  config: CodexRuntimeConfig
): CodexRuntimePlan {
  const githubTool = createGitHubGraphQLToolDefinition({
    ...config,
    githubToken: config.githubToken,
  });
  const linearTool = config.enableLinearGraphqlTool
    ? createLinearGraphQLToolDefinition({
        linearGraphqlUrl: config.linearGraphqlUrl ?? DEFAULT_LINEAR_GRAPHQL_URL,
        linearAuthorization: config.linearAuthorization,
        linearApiKey: config.linearApiKey,
      })
    : undefined;
  const builtinTools = [githubTool, linearTool].filter(
    (tool): tool is RuntimeToolDefinition => tool !== undefined
  );
  const secretEnvironmentNames = [
    ...(config.trackerSecretEnvironmentNames ?? []),
    ...collectMcpSecretEnvironmentNames({
      repositoryDir: config.workingDirectory,
      projectDir: config.projectDirectory,
      trustRepoConfig: config.trustRepoConfig,
      secretEnvironmentNames: config.trackerSecretEnvironmentNames ?? [],
    }),
  ];
  const childHome = resolveAgentChildHome({
    workingDirectory: config.workingDirectory,
    runtimeDirectory: config.extraEnv?.WORKSPACE_RUNTIME_DIR,
  });

  const agentCommand = parseAgentCommand(
    config.agentCommand ?? "codex app-server"
  );
  const agentEnv = resolvePreparedAgentEnvironment(config.agentEnv);
  const orchestratorRunEnv = {
    ...(config.orchestratorUrl
      ? { SYMPHONY_ORCHESTRATOR_URL: config.orchestratorUrl }
      : {}),
    ...(config.orchestratorRunId
      ? { SYMPHONY_RUN_ID: config.orchestratorRunId }
      : {}),
    ...(config.orchestratorToken
      ? { SYMPHONY_ORCHESTRATOR_TOKEN: config.orchestratorToken }
      : {}),
  };
  const plan = {
    cwd: config.workingDirectory,
    command: agentCommand.command,
    args: agentCommand.args,
    env: {
      ...resolveRuntimeProcessEnv(),
      ...config.extraEnv,
      ...config.agentEnv,
      CODEX_PROJECT_ID: config.projectId,
      GITHUB_PROJECT_ID: config.githubProjectId ?? "",
      ...orchestratorRunEnv,
      ...agentEnv,
    } as NodeJS.ProcessEnv,
    tools: [],
    dynamicTools: createCodexDynamicToolSpecs(builtinTools),
  };

  const removedEnvironmentNames = new Set([
    ...secretEnvironmentNames,
    ...CUSTOM_RUNTIME_RESERVED_AUTH_ENVIRONMENT_NAMES,
    "LINEAR_GRAPHQL_URL",
  ]);
  for (const name of removedEnvironmentNames) {
    delete plan.env[name];
  }
  stripCredentialEnvironmentForAgentChild(plan.env);
  Object.assign(
    plan.env,
    buildAgentChildEnvironmentAssignments({
      childHome,
      sources: [process.env, config.extraEnv, config.agentEnv],
      excludeNames: removedEnvironmentNames,
    }),
    { CODEX_HOME: join(childHome, ".codex") }
  );

  return plan;
}

export function launchCodexAppServer(
  plan: CodexRuntimePlan,
  spawnImpl: SpawnLike = spawn
): ChildProcess {
  return spawnImpl(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    stdio: "pipe",
  });
}

export class CodexRuntimeAdapter implements AgentRuntimeAdapter<
  CodexRuntimePrepareContext,
  CodexRuntimeTurnInput,
  CodexRuntimeTurnResult,
  CodexRuntimeEvent
> {
  // Event emission is intentionally deferred until the worker-owned loop is
  // neutralized in #4. Until then, keep handler registration compatible.
  private readonly handlers = new Set<(event: CodexRuntimeEvent) => void>();

  private plan: CodexRuntimePlan | null = null;

  private child: ChildProcess | null = null;

  constructor(
    private readonly config: CodexRuntimeConfig,
    private readonly dependencies: CodexRuntimeDependencies = {}
  ) {}

  async prepare(_context?: CodexRuntimePrepareContext): Promise<void> {
    if (this.plan) {
      return;
    }

    const agentEnv = await resolveAgentRuntimeEnvironment(this.config);
    this.plan = buildCodexRuntimePlan({
      ...this.config,
      agentEnv,
    });
    await prepareAgentChildHome(this.plan.env.HOME!);
    await stageGitUserIdentity({
      sourceHome: resolveHostHome(this.config),
      destination: join(this.plan.env.HOME!, ".gitconfig"),
    });
    await stageDockerCliPlugins({
      sourceHome: resolveHostHome(this.config),
      destination: join(this.plan.env.DOCKER_CONFIG!, "cli-plugins"),
    });
    if (!this.plan.env.OPENAI_API_KEY) {
      await stageJsonCredentialFile({
        source: join(resolveHostCodexHome(this.config), "auth.json"),
        destination: join(this.plan.env.CODEX_HOME!, "auth.json"),
      });
    }
  }

  async spawnTurn(
    _input?: CodexRuntimeTurnInput
  ): Promise<CodexRuntimeTurnResult> {
    if (!this.plan) {
      await this.prepare();
    }

    if (!this.plan) {
      throw new AgentRuntimeResolutionError(
        "Codex runtime plan was not prepared before spawnTurn."
      );
    }

    if (!hasRunningChild(this.child)) {
      this.child = launchCodexAppServer(
        this.plan,
        this.dependencies.spawnImpl ?? spawn
      );
    }

    return {
      plan: this.plan,
      child: this.child,
    };
  }

  onEvent(handler: (event: CodexRuntimeEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async shutdown(): Promise<void> {
    terminateChildProcess(this.child);
    this.child = null;
    this.handlers.clear();
  }

  async cancel(_reason?: string): Promise<void> {
    terminateChildProcess(this.child);
    this.child = null;
    this.handlers.clear();
  }

  getPreparedPlan(): CodexRuntimePlan | null {
    return this.plan;
  }
}

function resolveHostCodexHome(config: CodexRuntimeConfig): string {
  return (
    config.extraEnv?.CODEX_HOME ??
    process.env.CODEX_HOME ??
    join(resolveHostHome(config), ".codex")
  );
}

function resolveHostHome(config: CodexRuntimeConfig): string {
  return config.extraEnv?.HOME ?? process.env.HOME ?? homedir();
}

export function createCodexRuntimeAdapter(
  config: CodexRuntimeConfig,
  dependencies: CodexRuntimeDependencies = {}
): CodexRuntimeAdapter {
  return new CodexRuntimeAdapter(config, dependencies);
}

export async function prepareCodexRuntimePlan(
  config: CodexRuntimeConfig,
  dependencies: CodexRuntimeDependencies = {}
): Promise<CodexRuntimePlan> {
  const adapter = createCodexRuntimeAdapter(config, dependencies);
  await adapter.prepare();
  const plan = adapter.getPreparedPlan();

  if (!plan) {
    throw new AgentRuntimeResolutionError(
      "Codex runtime plan was not prepared."
    );
  }

  return plan;
}

export function createGitCredentialHelperEnvironment(
  config: Pick<CodexRuntimeConfig, "githubToken"> & {
    gitHost?: string;
    gitUsername?: string;
  }
): Record<string, string> {
  return {
    GITHUB_GIT_HOST: config.gitHost?.trim() || DEFAULT_GITHUB_GIT_HOST,
    GITHUB_GIT_USERNAME:
      config.gitUsername?.trim() || DEFAULT_GITHUB_GIT_USERNAME,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: `!node ${fileURLToPath(
      new URL("./git-credential-helper.js", import.meta.url)
    )}`,
    ...(config.githubToken
      ? {
          GITHUB_GRAPHQL_TOKEN: config.githubToken,
        }
      : {}),
  };
}

export async function resolveAgentRuntimeEnvironment(
  config: Pick<CodexRuntimeConfig, "workingDirectory" | "agentEnv">
): Promise<Record<string, string>> {
  return resolvePreparedAgentEnvironment(config.agentEnv);
}

function hasRunningChild(child: ChildProcess | null): child is ChildProcess {
  return child !== null && child.exitCode === null && child.signalCode === null;
}

function terminateChildProcess(child: ChildProcess | null): void {
  if (!hasRunningChild(child) || !child.pid) {
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // Ignore shutdown races.
  }
}
