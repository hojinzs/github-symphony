import type { ChildProcess } from "node:child_process";
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
  spawnClaudeTurn,
  type ClaudeSpawnDependencies,
  type ClaudeSpawnTurnResult,
  type ClaudeWireMessage,
} from "./spawn.js";

export type ClaudeRuntimeConfig = {
  workingDirectory: string;
  command?: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  extraArgs?: readonly string[];
  isolation?: ClaudeRuntimeIsolationOptions;
  authEnvKey?: string;
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

  constructor(
    private readonly config: ClaudeRuntimeConfig,
    private readonly dependencies: ClaudeSpawnDependencies = {}
  ) {}

  prepare(_context: ClaudeRuntimePrepareContext): void {
    // TODO(#7,#8,#10): MCP composition, session persistence, and preflight
    // checks will populate this hook once the worker-side runtime wiring lands.
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
    return extractEnvForClaude(brokerResponse.env, this.config.authEnvKey);
  }

  shutdown(): void {
    this.stopActiveChild();
  }

  cancel(_reason?: string): void {
    // TODO(#8,#9): replace direct process termination with session-aware
    // cancellation once Claude runtime turn orchestration is wired end-to-end.
    this.stopActiveChild();
  }

  private buildArgvOptions(input: ClaudeRuntimeTurnInput): ClaudePrintArgvOptions {
    return {
      baseArgs: this.config.args,
      session: input.session,
      isolation: {
        ...this.config.isolation,
        ...input.isolation,
      },
      extraArgs: input.extraArgs ?? this.config.extraArgs,
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
}

export function createClaudePrintRuntimeAdapter(
  config: ClaudeRuntimeConfig,
  dependencies: ClaudeSpawnDependencies = {}
): ClaudePrintRuntimeAdapter {
  return new ClaudePrintRuntimeAdapter(config, dependencies);
}

export function resolveClaudeCredentials(
  brokerResponse: AgentRuntimeCredentialBrokerResponse,
  envKey?: string
): AgentRuntimeEnv {
  return extractEnvForClaude(brokerResponse.env, envKey);
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
