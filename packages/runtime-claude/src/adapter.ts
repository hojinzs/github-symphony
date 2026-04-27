import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeCredentialBrokerResponse,
  AgentRuntimeEnv,
  AgentRuntimeEvent,
  AgentRuntimeEventHandler,
  AgentRuntimeEventSubscription,
} from "@gh-symphony/core";
import { extractEnvForClaude } from "@gh-symphony/core";
import {
  buildClaudePrintArgv,
  type ClaudePrintArgvOptions,
  type ClaudeRuntimeIsolationOptions,
  type ClaudeRuntimeSessionOptions,
} from "./argv.js";
import {
  composeClaudeMcpConfig,
  type ClaudeMcpCompositionResult,
  type ClaudeMcpTokenEnvironment,
} from "./mcp-compose.js";
import {
  spawnClaudeTurn,
  type ClaudeSpawnDependencies,
  type ClaudeSpawnTurnResult,
  type ClaudeWireMessage,
} from "./spawn.js";

export type ClaudeRuntimeConfig = {
  workingDirectory: string;
  runtimeDirectory?: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: readonly string[];
  isolation?: ClaudeRuntimeIsolationOptions;
  inheritProcessEnv?: boolean;
};

export type ClaudeRuntimePrepareContext = {
  runId?: string;
};

export type ClaudeRuntimeTurnInput = {
  messages: ClaudeWireMessage | readonly ClaudeWireMessage[];
  session?: ClaudeRuntimeSessionOptions;
  isolation?: ClaudeRuntimeIsolationOptions;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  extraArgs?: readonly string[];
};

export type ClaudeRuntimeTurnResult = ClaudeSpawnTurnResult;

export type ClaudeRuntimeEvent = AgentRuntimeEvent;

export class ClaudeRuntimeNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeRuntimeNotImplementedError";
  }
}

export class ClaudePrintRuntimeAdapter
  implements
    AgentRuntimeAdapter<
      ClaudeRuntimePrepareContext,
      ClaudeRuntimeTurnInput,
      ClaudeRuntimeTurnResult,
      ClaudeRuntimeEvent
    >
{
  private activeChild: ChildProcess | null = null;
  private preparedMcpConfig: ClaudeMcpCompositionResult | null = null;

  constructor(
    private readonly config: ClaudeRuntimeConfig,
    private readonly dependencies: ClaudeSpawnDependencies = {}
  ) {}

  async prepare(_context: ClaudeRuntimePrepareContext): Promise<void> {
    await this.cleanupPreparedMcpConfig();
    this.preparedMcpConfig = await composeClaudeMcpConfig(
      this.config.workingDirectory,
      this.config.isolation?.strictMcpConfig === true,
      buildClaudeMcpTokenEnvironment({
        inheritProcessEnv: this.config.inheritProcessEnv === true,
        configEnv: this.config.env,
        runtimeDirectory: this.config.runtimeDirectory,
      })
    );
  }

  async spawnTurn(input: ClaudeRuntimeTurnInput): Promise<ClaudeRuntimeTurnResult> {
    if (this.activeChild) {
      throw new Error(
        "TODO(#8): Claude print runtime adapter supports only one in-flight turn."
      );
    }

    const argv = buildClaudePrintArgv(
      this.buildArgvOptions(input)
    );

    try {
      return await spawnClaudeTurn(
        {
          command: input.command ?? this.config.command,
          args: argv,
          cwd: input.cwd ?? this.config.workingDirectory,
          env: buildClaudeSpawnEnv({
            inheritProcessEnv: this.config.inheritProcessEnv === true,
            configEnv: this.config.env,
            inputEnv: input.env,
          }),
          stdinMessages: input.messages,
        },
        {
          ...this.dependencies,
          onSpawned: (child) => {
            this.activeChild = child;
            this.dependencies.onSpawned?.(child);
          },
        }
      );
    } finally {
      this.activeChild = null;
    }
  }

  onEvent(
    _handler: AgentRuntimeEventHandler<ClaudeRuntimeEvent>
  ): AgentRuntimeEventSubscription {
    throw new ClaudeRuntimeNotImplementedError(
      "TODO(#9): Claude stream-json event mapping is not implemented yet."
    );
  }

  resolveCredentials(
    brokerResponse: AgentRuntimeCredentialBrokerResponse
  ): AgentRuntimeEnv {
    return extractEnvForClaude(brokerResponse.env);
  }

  async shutdown(): Promise<void> {
    this.stopActiveChild();
    await this.cleanupPreparedMcpConfig();
  }

  async cancel(_reason?: string): Promise<void> {
    // TODO(#8,#9): replace direct process termination with session-aware
    // cancellation once Claude runtime turn orchestration is wired end-to-end.
    this.stopActiveChild();
    await this.cleanupPreparedMcpConfig();
  }

  private buildArgvOptions(input: ClaudeRuntimeTurnInput): ClaudePrintArgvOptions {
    const isolation = {
      ...this.config.isolation,
      ...input.isolation,
    };
    const configuredExtraArgs = input.extraArgs ?? this.config.extraArgs ?? [];

    if (this.preparedMcpConfig) {
      return {
        session: input.session,
        // prepare() owns MCP argv injection through extraArgv; suppress the
        // isolation flag here so buildClaudePrintArgv does not add it twice.
        isolation: {
          ...isolation,
          strictMcpConfig: false,
          mcpConfigPath: undefined,
        },
        extraArgs: [
          ...this.preparedMcpConfig.extraArgv,
          ...configuredExtraArgs,
        ],
      };
    }

    if (isolation.strictMcpConfig && !isolation.mcpConfigPath) {
      throw new Error(
        "Claude strict MCP config requires prepare() or an explicit mcpConfigPath."
      );
    }

    return {
      session: input.session,
      isolation,
      extraArgs: configuredExtraArgs,
    };
  }

  private stopActiveChild(): void {
    if (!this.activeChild || this.activeChild.killed) {
      this.activeChild = null;
      return;
    }

    this.activeChild.kill("SIGTERM");
    this.activeChild = null;
  }

  private async cleanupPreparedMcpConfig(): Promise<void> {
    const cleanupPath = this.preparedMcpConfig?.cleanupPath;
    this.preparedMcpConfig = null;

    if (!cleanupPath) {
      return;
    }

    await rm(cleanupPath, { force: true });
  }
}

export function createClaudePrintRuntimeAdapter(
  config: ClaudeRuntimeConfig,
  dependencies: ClaudeSpawnDependencies = {}
): ClaudePrintRuntimeAdapter {
  return new ClaudePrintRuntimeAdapter(config, dependencies);
}

export function resolveClaudeCredentials(
  brokerResponse: AgentRuntimeCredentialBrokerResponse
): AgentRuntimeEnv {
  return extractEnvForClaude(brokerResponse.env);
}

const DEFAULT_INHERITED_ENV_KEYS = [
  "HOME",
  "LANG",
  "PATH",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERPROFILE",
] as const;

function buildClaudeSpawnEnv(options: {
  inheritProcessEnv: boolean;
  configEnv?: NodeJS.ProcessEnv;
  inputEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  if (options.inheritProcessEnv) {
    return {
      ...process.env,
      ...options.configEnv,
      ...options.inputEnv,
    };
  }

  const env: NodeJS.ProcessEnv = {};

  for (const key of DEFAULT_INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  Object.assign(env, options.configEnv, options.inputEnv);

  return env;
}

function buildClaudeMcpTokenEnvironment(options: {
  inheritProcessEnv: boolean;
  configEnv?: NodeJS.ProcessEnv;
  runtimeDirectory?: string;
}): ClaudeMcpTokenEnvironment {
  const source = options.inheritProcessEnv
    ? {
        ...process.env,
        ...options.configEnv,
      }
    : {
        ...options.configEnv,
      };

  return {
    GITHUB_GRAPHQL_TOKEN: source.GITHUB_GRAPHQL_TOKEN,
    GITHUB_GRAPHQL_API_URL: source.GITHUB_GRAPHQL_API_URL,
    GITHUB_TOKEN_BROKER_URL: source.GITHUB_TOKEN_BROKER_URL,
    GITHUB_TOKEN_BROKER_SECRET: source.GITHUB_TOKEN_BROKER_SECRET,
    GITHUB_TOKEN_CACHE_PATH: source.GITHUB_TOKEN_CACHE_PATH,
    GITHUB_PROJECT_ID: source.GITHUB_PROJECT_ID,
    WORKSPACE_RUNTIME_DIR:
      options.runtimeDirectory ?? source.WORKSPACE_RUNTIME_DIR,
  };
}
