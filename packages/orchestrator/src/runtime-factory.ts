import { join } from "node:path";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeCredentialBrokerResponse,
  AgentRuntimeEnv,
  AgentRuntimeEvent,
  AgentRuntimeEventHandler,
  AgentRuntimeEventSubscription,
  WorkflowDefinition,
  WorkflowRuntimeConfig,
} from "@gh-symphony/core";
import { extractEnvForClaude } from "@gh-symphony/core";
import {
  createCodexRuntimeAdapter,
  type CodexRuntimeAdapter,
  type CodexRuntimeDependencies,
} from "@gh-symphony/runtime-codex";
import {
  createClaudePrintRuntimeAdapter,
  spawnClaudeTurn,
  type ClaudePrintRuntimeAdapter,
  type ClaudeSpawnDependencies,
  type ClaudeSpawnTurnResult,
} from "@gh-symphony/runtime-claude";

export type WorkflowRuntimeFactoryContext = {
  projectId: string;
  workingDirectory: string;
  mcpConfigPath?: string;
  env?: NodeJS.ProcessEnv;
  codexDependencies?: CodexRuntimeDependencies;
  claudeDependencies?: ClaudeSpawnDependencies;
};

export type WorkflowRuntimeAdapter =
  | CodexRuntimeAdapter
  | ClaudePrintRuntimeAdapter
  | CustomCommandRuntimeAdapter;

export type CustomCommandRuntimeConfig = {
  workingDirectory: string;
  command: string;
  args: readonly string[];
  authEnvKey?: string;
  env?: NodeJS.ProcessEnv;
};

export type CustomRuntimeMessage = Record<string, unknown>;

export type CustomRuntimeTurnInput = {
  messages?: CustomRuntimeMessage | readonly CustomRuntimeMessage[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  command?: string;
  args?: readonly string[];
};

export class CustomCommandRuntimeAdapter
  implements
    AgentRuntimeAdapter<
      void,
      CustomRuntimeTurnInput,
      ClaudeSpawnTurnResult,
      AgentRuntimeEvent
    >
{
  constructor(
    private readonly config: CustomCommandRuntimeConfig,
    private readonly dependencies: ClaudeSpawnDependencies = {}
  ) {}

  prepare(): void {}

  spawnTurn(input: CustomRuntimeTurnInput): Promise<ClaudeSpawnTurnResult> {
    return spawnClaudeTurn(
      {
        command: input.command ?? this.config.command,
        args: input.args ?? this.config.args,
        cwd: input.cwd ?? this.config.workingDirectory,
        env: {
          ...this.config.env,
          ...input.env,
        },
        stdinMessages: input.messages ?? [],
      },
      this.dependencies
    );
  }

  onEvent(
    _handler: AgentRuntimeEventHandler<AgentRuntimeEvent>
  ): AgentRuntimeEventSubscription {
    return () => {};
  }

  resolveCredentials(
    brokerResponse: AgentRuntimeCredentialBrokerResponse
  ): AgentRuntimeEnv {
    if (!this.config.authEnvKey) {
      return {};
    }
    return extractEnvForClaude(brokerResponse.env, this.config.authEnvKey);
  }

  shutdown(): void {}

  cancel(): void {}
}

export function createWorkflowRuntimeAdapter(
  workflow: WorkflowDefinition,
  context: WorkflowRuntimeFactoryContext
): WorkflowRuntimeAdapter {
  const runtime = workflow.runtime;

  if (!runtime) {
    return createCodexRuntimeAdapter(
      {
        projectId: context.projectId,
        workingDirectory: context.workingDirectory,
        agentCommand: workflow.codex.command,
        extraEnv: context.env,
      },
      context.codexDependencies
    );
  }

  switch (runtime.kind) {
    case "codex-app-server":
      return createCodexRuntimeAdapter(
        {
          projectId: context.projectId,
          workingDirectory: context.workingDirectory,
          agentCommand: buildCommand(runtime),
          extraEnv: context.env,
        },
        context.codexDependencies
      );
    case "claude-print":
      return createClaudePrintRuntimeAdapter(
        {
          workingDirectory: context.workingDirectory,
          command: runtime.command,
          args: runtime.args.length > 0 ? runtime.args : undefined,
          env: context.env,
          authEnvKey: runtime.auth.env ?? undefined,
          isolation: {
            bare: runtime.isolation.bare,
            strictMcpConfig: runtime.isolation.strictMcpConfig,
            mcpConfigPath: runtime.isolation.strictMcpConfig
              ? (context.mcpConfigPath ?? defaultEphemeralMcpConfigPath(context))
              : undefined,
          },
        },
        context.claudeDependencies
      );
    case "custom":
      return new CustomCommandRuntimeAdapter(
        {
          workingDirectory: context.workingDirectory,
          command: runtime.command,
          args: runtime.args,
          env: context.env,
          authEnvKey: runtime.auth.env ?? undefined,
        },
        context.claudeDependencies
      );
  }
}

function buildCommand(runtime: WorkflowRuntimeConfig): string {
  if (runtime.args.length === 0) {
    return runtime.command;
  }
  return [runtime.command, ...runtime.args].join(" ");
}

function defaultEphemeralMcpConfigPath(
  context: Pick<WorkflowRuntimeFactoryContext, "workingDirectory">
): string {
  return join(context.workingDirectory, ".runtime", "mcp.json");
}
