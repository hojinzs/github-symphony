import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeCredentialBrokerResponse,
  AgentRuntimeEvent,
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

export function resolveStagedCodexHome(workingDirectory: string): string {
  return join(workingDirectory, STAGED_CODEX_HOME_DIRNAME);
}

export function resolvePreparedAgentEnvironment(
  workingDirectory: string,
  env?: Record<string, string | undefined>
): Record<string, string> {
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
      // Point codex to an isolated config dir so personal MCPs (playwright,
      // chrome-devtools, context7, etc.) from the operator's ~/.codex/config.toml
      // are not loaded and do not confuse the implementation agent.
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
  }

  async cancel(_reason?: string): Promise<void> {
    terminateChildProcess(this.child);
    this.child = null;
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
  dependencies: Pick<
    CodexRuntimeDependencies,
    "fetchImpl" | "writeFileImpl"
  > = {},
  adapter?: Pick<CodexRuntimeAdapter, "resolveCredentials">
): Promise<Record<string, string>> {
  if (config.agentEnv) {
    return resolvePreparedAgentEnvironment(
      config.workingDirectory,
      config.agentEnv
    );
  }

  if (!config.agentCredentialBrokerUrl || !config.agentCredentialBrokerSecret) {
    return resolvePreparedAgentEnvironment(config.workingDirectory);
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const response = await fetchImpl(config.agentCredentialBrokerUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.agentCredentialBrokerSecret}`,
    },
  });
  const payload = (await response.json()) as {
    env?: Record<string, string>;
    error?: string;
    expires_at?: string;
  };
  const resolvedEnv =
    payload.env && response.ok
      ? (
          adapter ??
          createCodexRuntimeAdapter({
            projectId: "runtime-codex",
            workingDirectory: config.workingDirectory,
          })
        ).resolveCredentials({
          env: payload.env,
          expires_at: payload.expires_at,
        })
      : null;

  if (!response.ok || !resolvedEnv || Object.keys(resolvedEnv).length === 0) {
    throw new AgentRuntimeResolutionError(
      payload.error ??
        `Agent credential broker request failed with status ${response.status}.`
    );
  }

  if (config.agentCredentialCachePath) {
    const writeFileImpl = dependencies.writeFileImpl ?? writeFile;
    await writeFileImpl(
      config.agentCredentialCachePath,
      JSON.stringify(payload),
      "utf8"
    );
  }

  return resolvedEnv;
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
