import { join } from "node:path";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeCredentialBrokerResponse,
  AgentRuntimeEnv,
  AgentRuntimeEvent,
  AgentRuntimeEventHandler,
  AgentRuntimeEventSubscription,
  WorkflowDefinition,
} from "@gh-symphony/core";
import {
  extractEnvForClaude,
  resolveWorkflowRuntimeCommand,
} from "@gh-symphony/core";
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
  /**
   * Optional dependencies for codex-app-server. When omitted, the codex
   * adapter uses its production filesystem/process defaults.
   */
  codexDependencies?: CodexRuntimeDependencies;
  /**
   * Temporary shared process-spawn dependencies for claude-print and custom.
   * TODO(#254): rename/split once custom process spawning leaves the Claude
   * adapter layer.
   */
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

export type CustomRuntimeTurnInput = {
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

  // TODO(#254): replace ClaudeSpawnTurnResult with a generic turn result once
  // custom process spawning is separated from the Claude adapter layer.
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
        // Custom runtimes do not expose Claude wire-protocol stdin.
        stdinMessages: [],
      },
      this.dependencies
    );
  }

  onEvent(
    _handler: AgentRuntimeEventHandler<AgentRuntimeEvent>
  ): AgentRuntimeEventSubscription {
    // Custom runtimes currently expose only process-level turn results; they do
    // not emit structured runtime events.
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
          agentCommand: resolveWorkflowRuntimeCommand(workflow),
          extraEnv: context.env,
        },
        context.codexDependencies
      );
    case "claude-print":
      return createClaudePrintRuntimeAdapter(
        {
          workingDirectory: context.workingDirectory,
          command: runtime.command,
          args: runtime.args,
          env: context.env,
          authEnvKey: runtime.auth.env ?? undefined,
          isolation: {
            bare: runtime.isolation.bare,
            strictMcpConfig: runtime.isolation.strictMcpConfig,
            mcpConfigPath: resolveMcpConfigPath(runtime, context),
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

function resolveMcpConfigPath(
  runtime: NonNullable<WorkflowDefinition["runtime"]>,
  context: WorkflowRuntimeFactoryContext
): string | undefined {
  if (!runtime.isolation.strictMcpConfig) {
    return undefined;
  }

  return context.mcpConfigPath ?? defaultEphemeralMcpConfigPath(context);
}

function defaultEphemeralMcpConfigPath(
  context: Pick<WorkflowRuntimeFactoryContext, "workingDirectory">
): string {
  return join(context.workingDirectory, ".runtime", "mcp.json");
}
