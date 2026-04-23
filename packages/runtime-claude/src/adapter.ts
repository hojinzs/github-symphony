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
  env?: NodeJS.ProcessEnv;
  extraArgs?: readonly string[];
  isolation?: ClaudeRuntimeIsolationOptions;
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
  private readonly handlers = new Set<
    AgentRuntimeEventHandler<ClaudeRuntimeEvent>
  >();

  constructor(
    private readonly config: ClaudeRuntimeConfig,
    private readonly dependencies: ClaudeSpawnDependencies = {}
  ) {}

  prepare(_context: ClaudeRuntimePrepareContext): void {
    // TODO(#7,#8,#10): MCP composition, session persistence, and preflight
    // checks will populate this hook once the worker-side runtime wiring lands.
  }

  async spawnTurn(input: ClaudeRuntimeTurnInput): Promise<ClaudeRuntimeTurnResult> {
    const argv = buildClaudePrintArgv(
      this.buildArgvOptions(input)
    );

    return spawnClaudeTurn(
      {
        command: input.command ?? this.config.command,
        args: argv,
        cwd: input.cwd ?? this.config.workingDirectory,
        env: {
          ...process.env,
          ...this.config.env,
          ...input.env,
        },
        stdinMessages: input.messages,
      },
      this.dependencies
    );
  }

  onEvent(
    handler: AgentRuntimeEventHandler<ClaudeRuntimeEvent>
  ): AgentRuntimeEventSubscription {
    // TODO(#9): map Claude stream-json NDJSON to neutral AgentEvent payloads.
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  resolveCredentials(
    brokerResponse: AgentRuntimeCredentialBrokerResponse
  ): AgentRuntimeEnv {
    return extractEnvForClaude(brokerResponse.env);
  }

  shutdown(): void {
    this.handlers.clear();
  }

  cancel(_reason?: string): void {
    this.handlers.clear();
  }

  private buildArgvOptions(input: ClaudeRuntimeTurnInput): ClaudePrintArgvOptions {
    return {
      session: input.session,
      isolation: {
        ...this.config.isolation,
        ...input.isolation,
      },
      extraArgs: input.extraArgs ?? this.config.extraArgs,
    };
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
