import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  readAgentCredentialCache,
  shouldReuseAgentCredentialCache,
  writeAgentCredentialCache,
  type AgentRuntimeAdapter,
  type AgentRuntimeCredentialBrokerResponse,
  type AgentEvent,
  type AgentRuntimeEvent,
} from "@gh-symphony/core";
import { resolveGitHubGraphQLMcpServerEntryPoint } from "@gh-symphony/tool-github-graphql";

const DEFAULT_GITHUB_GRAPHQL_API_URL = "https://api.github.com/graphql";
const DEFAULT_GITHUB_GIT_HOST = "github.com";
const DEFAULT_GITHUB_GIT_USERNAME = "x-access-token";
const STAGED_CODEX_HOME_DIRNAME = ".codex-agent";
const DIRECT_AGENT_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT",
] as const;

export type RuntimeToolDefinition = {
  name: "github_graphql";
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

export type CodexRuntimeConfig = {
  projectId: string;
  workingDirectory: string;
  githubToken?: string;
  githubTokenBrokerUrl?: string;
  githubTokenBrokerSecret?: string;
  githubTokenCachePath?: string;
  agentEnv?: Record<string, string>;
  agentCredentialBrokerUrl?: string;
  agentCredentialBrokerSecret?: string;
  agentCredentialCachePath?: string;
  githubProjectId?: string;
  githubGraphqlApiUrl?: string;
  extraEnv?: NodeJS.ProcessEnv;
  /** Shell command to launch codex app-server. Leading "bash -lc " is stripped if present, since the runtime always wraps in bash -lc. */
  agentCommand?: string;
};

export type CodexRuntimePlan = {
  cwd: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  tools: [RuntimeToolDefinition];
};

export class AgentRuntimeResolutionError extends Error {}

export type CodexRuntimePrepareContext = void;

export type CodexRuntimeTurnInput = void;

export type CodexRuntimeTurnResult = {
  plan: CodexRuntimePlan;
  child: ChildProcess;
};

export type CodexRuntimeCredentialBrokerResponse =
  AgentRuntimeCredentialBrokerResponse;

export type CodexRuntimeEvent = AgentRuntimeEvent;

export type CodexRuntimeDependencies = {
  fetchImpl?: typeof fetch;
  writeFileImpl?: typeof writeFile;
  mkdirImpl?: typeof mkdir;
  copyFileImpl?: typeof copyFile;
  spawnImpl?: SpawnLike;
};

type SpawnLike = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
) => ChildProcess;

export const CODEX_PROTOCOL_EVENT_NAMES = {
  turnStarted: "turn/started",
  turnCompleted: "turn/completed",
  turnFailed: "turn/failed",
  turnCancelled: "turn/cancelled",
  toolCallRequested: "dynamic_tool_call_request",
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
    | "githubToken"
    | "githubTokenBrokerUrl"
    | "githubTokenBrokerSecret"
    | "githubTokenCachePath"
    | "githubProjectId"
    | "githubGraphqlApiUrl"
  >
): RuntimeToolDefinition {
  return {
    name: "github_graphql",
    description:
      "Execute GitHub GraphQL queries for the active workspace so the agent can mutate project and issue state directly.",
    command: "node",
    args: [resolveGitHubGraphQLMcpServerEntryPoint()],
    env: {
      GITHUB_GRAPHQL_API_URL:
        config.githubGraphqlApiUrl ?? DEFAULT_GITHUB_GRAPHQL_API_URL,
      ...(config.githubToken
        ? {
            GITHUB_GRAPHQL_TOKEN: config.githubToken,
          }
        : {}),
      ...(config.githubTokenBrokerUrl
        ? {
            GITHUB_TOKEN_BROKER_URL: config.githubTokenBrokerUrl,
          }
        : {}),
      ...(config.githubTokenBrokerSecret
        ? {
            GITHUB_TOKEN_BROKER_SECRET: config.githubTokenBrokerSecret,
          }
        : {}),
      ...(config.githubTokenCachePath
        ? {
            GITHUB_TOKEN_CACHE_PATH: config.githubTokenCachePath,
          }
        : {}),
      ...(config.githubProjectId
        ? {
            GITHUB_PROJECT_ID: config.githubProjectId,
          }
        : {}),
    },
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

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function hasOwn(
  record: Record<string, unknown>,
  key: string
): boolean {
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
    "info",
    "msg",
    "event",
    "data",
    "result",
    "payload",
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
        reason: "turn_input_required: agent requires user input",
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
          shouldEmitUpdate: false,
        },
      });
    }

    if (hasNestedRateLimitPayload(params)) {
      events.push({
        name: "agent.rateLimit",
        payload: {
          observabilityEvent: method,
          params,
          shouldEmitUpdate: false,
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

export function resolveStagedCodexHome(workingDirectory: string): string {
  return join(workingDirectory, STAGED_CODEX_HOME_DIRNAME);
}

export function resolvePreparedAgentEnvironment(
  workingDirectory: string,
  env?: Record<string, string | undefined>
): Record<string, string> {
  // Point codex to an isolated config dir so personal MCPs (playwright,
  // chrome-devtools, context7, etc.) from the operator's ~/.codex/config.toml
  // are not loaded and do not confuse the implementation agent.
  const preparedEnv = Object.fromEntries(
    DIRECT_AGENT_ENV_KEYS.flatMap((key) => {
      const value = env?.[key];
      return typeof value === "string" && value.length > 0 ? [[key, value]] : [];
    })
  );

  return {
    ...preparedEnv,
    CODEX_HOME: resolveStagedCodexHome(workingDirectory),
  };
}

/**
 * Build the `codex app-server` launch plan after `stageCodexHome()` has prepared
 * the staged `CODEX_HOME` directory for the target working directory.
 */
export function buildCodexRuntimePlan(
  config: CodexRuntimeConfig
): CodexRuntimePlan {
  const tool = createGitHubGraphQLToolDefinition(config);
  const gitCredentialHelper = createGitCredentialHelperEnvironment(config);

  const shellCmd = (() => {
    const cmd = config.agentCommand ?? "codex app-server";
    return cmd.startsWith("bash -lc ") ? cmd.slice("bash -lc ".length) : cmd;
  })();
  const agentEnv = resolvePreparedAgentEnvironment(
    config.workingDirectory,
    config.agentEnv
  );

  return {
    cwd: config.workingDirectory,
    command: "bash",
    args: ["-lc", shellCmd],
    env: {
      ...process.env,
      ...config.extraEnv,
      ...config.agentEnv,
      CODEX_PROJECT_ID: config.projectId,
      GITHUB_PROJECT_ID: config.githubProjectId ?? "",
      GITHUB_GRAPHQL_TOOL_NAME: tool.name,
      GITHUB_GRAPHQL_TOOL_COMMAND: [tool.command, ...tool.args].join(" "),
      ...agentEnv,
      ...gitCredentialHelper,
      ...tool.env,
    },
    tools: [tool],
  };
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

export class CodexRuntimeAdapter
  implements
    AgentRuntimeAdapter<
      CodexRuntimePrepareContext,
      CodexRuntimeTurnInput,
      CodexRuntimeTurnResult,
      CodexRuntimeEvent,
      CodexRuntimeCredentialBrokerResponse
    >
{
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

    const agentEnv = await resolveAgentRuntimeEnvironment(
      this.config,
      this.dependencies,
      this
    );
    await stageCodexHome(this.config, this.dependencies);
    this.plan = buildCodexRuntimePlan({
      ...this.config,
      agentEnv,
    });
  }

  async spawnTurn(_input?: CodexRuntimeTurnInput): Promise<CodexRuntimeTurnResult> {
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

  resolveCredentials(
    brokerResponse: CodexRuntimeCredentialBrokerResponse
  ): Record<string, string> {
    return resolvePreparedAgentEnvironment(
      this.config.workingDirectory,
      brokerResponse.env
    );
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
  config: Pick<
    CodexRuntimeConfig,
    | "githubToken"
    | "githubTokenBrokerUrl"
    | "githubTokenBrokerSecret"
    | "githubTokenCachePath"
  >
): Record<string, string> {
  return {
    GITHUB_GIT_HOST: DEFAULT_GITHUB_GIT_HOST,
    GITHUB_GIT_USERNAME: DEFAULT_GITHUB_GIT_USERNAME,
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
    ...(config.githubTokenBrokerUrl
      ? {
          GITHUB_TOKEN_BROKER_URL: config.githubTokenBrokerUrl,
        }
      : {}),
    ...(config.githubTokenBrokerSecret
      ? {
          GITHUB_TOKEN_BROKER_SECRET: config.githubTokenBrokerSecret,
        }
      : {}),
    ...(config.githubTokenCachePath
      ? {
          GITHUB_TOKEN_CACHE_PATH: config.githubTokenCachePath,
        }
      : {}),
  };
}

export async function resolveAgentRuntimeEnvironment(
  config: Pick<
    CodexRuntimeConfig,
    | "workingDirectory"
    | "agentEnv"
    | "agentCredentialBrokerUrl"
    | "agentCredentialBrokerSecret"
    | "agentCredentialCachePath"
  >,
  dependencies: {
    fetchImpl?: typeof fetch;
    readFileImpl?: typeof readFile;
    writeFileImpl?: typeof writeFile;
    now?: Date;
  } = {},
  adapter?: Pick<
    AgentRuntimeAdapter<
      CodexRuntimePrepareContext,
      CodexRuntimeTurnInput,
      CodexRuntimeTurnResult,
      CodexRuntimeEvent,
      CodexRuntimeCredentialBrokerResponse
    >,
    "resolveCredentials"
  >
): Promise<Record<string, string>> {
  if (config.agentEnv) {
    return resolveRuntimeCredentials(config, { env: config.agentEnv }, adapter);
  }

  if (!config.agentCredentialBrokerUrl || !config.agentCredentialBrokerSecret) {
    return resolvePreparedAgentEnvironment(config.workingDirectory);
  }

  const now = dependencies.now ?? new Date();
  const readFileImpl = dependencies.readFileImpl ?? readFile;
  const cachedCredentials = config.agentCredentialCachePath
    ? await readAgentCredentialCache(config.agentCredentialCachePath, readFileImpl)
    : null;

  if (cachedCredentials && shouldReuseAgentCredentialCache(cachedCredentials, now)) {
    return resolveRuntimeCredentials(config, cachedCredentials, adapter);
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const response = await fetchImpl(config.agentCredentialBrokerUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.agentCredentialBrokerSecret}`,
    },
  });
  const payload = (await response.json()) as AgentRuntimeCredentialBrokerResponse & {
    error?: string;
    expires_at?: string;
  };
  const resolvedEnv =
    payload.env && response.ok
      ? adapter
        ? adapter.resolveCredentials({
            env: payload.env,
            expires_at: payload.expires_at,
          })
        : resolvePreparedAgentEnvironment(config.workingDirectory, payload.env)
      : null;

  if (
    !response.ok ||
    !payload.env ||
    Object.keys(payload.env).length === 0 ||
    !resolvedEnv
  ) {
    throw new AgentRuntimeResolutionError(
      payload.error ??
        `Agent credential broker request failed with status ${response.status}.`
    );
  }

  if (config.agentCredentialCachePath) {
    const writeFileImpl = dependencies.writeFileImpl ?? writeFile;
    await writeAgentCredentialCache(
      config.agentCredentialCachePath,
      payload,
      writeFileImpl,
      now
    );
  }

  return resolvedEnv;
}

function resolveRuntimeCredentials(
  config: Pick<CodexRuntimeConfig, "workingDirectory">,
  brokerResponse: CodexRuntimeCredentialBrokerResponse,
  adapter?: Pick<
    AgentRuntimeAdapter<
      CodexRuntimePrepareContext,
      CodexRuntimeTurnInput,
      CodexRuntimeTurnResult,
      CodexRuntimeEvent,
      CodexRuntimeCredentialBrokerResponse
    >,
    "resolveCredentials"
  >
): Record<string, string> {
  return adapter
    ? adapter.resolveCredentials(brokerResponse)
    : resolvePreparedAgentEnvironment(config.workingDirectory, brokerResponse.env);
}

async function stageCodexHome(
  config: Pick<CodexRuntimeConfig, "workingDirectory">,
  dependencies: Pick<
    CodexRuntimeDependencies,
    "mkdirImpl" | "writeFileImpl" | "copyFileImpl"
  > = {}
): Promise<void> {
  const codexHomeDir = resolveStagedCodexHome(config.workingDirectory);
  const mkdirImpl = dependencies.mkdirImpl ?? mkdir;
  await mkdirImpl(codexHomeDir, { recursive: true });
  const writeFileImpl = dependencies.writeFileImpl ?? writeFile;
  await writeFileImpl(
    join(codexHomeDir, "config.toml"),
    "# Isolated agent config \u2014 no personal MCP servers\n",
    "utf8"
  );

  const realCodexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const copyFileImpl = dependencies.copyFileImpl ?? copyFile;
  try {
    await copyFileImpl(
      join(realCodexHome, "auth.json"),
      join(codexHomeDir, "auth.json")
    );
  } catch {
    // auth.json may not exist (e.g. when OPENAI_API_KEY is used instead)
  }
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
