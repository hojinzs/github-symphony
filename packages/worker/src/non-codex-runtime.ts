import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { finished } from "node:stream/promises";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeCredentialBrokerResponse,
  AgentRuntimeEnv,
  AgentRuntimeEvent,
  AgentRuntimeEventHandler,
  AgentRuntimeEventSubscription,
  WorkflowDefinition,
} from "@gh-symphony/core";
import { extractEnvForClaude } from "@gh-symphony/core";
import {
  createClaudePrintRuntimeAdapter,
  type ClaudeRuntimeDependencies,
  type ClaudePrintRuntimeAdapter,
  type ClaudeRuntimeTurnResult,
} from "@gh-symphony/runtime-claude";

export type WorkerNonCodexRuntimeContext = {
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  runtimeRoot?: string;
  runtimeDirectory?: string;
  onSpawned?: (child: ChildProcess) => void;
  claudeDependencies?: ClaudeRuntimeDependencies;
  customDependencies?: {
    spawnImpl?: CustomCommandSpawnLike;
  };
};

export type WorkerNonCodexRuntimeAdapter =
  | ClaudePrintRuntimeAdapter
  | CustomCommandWorkerRuntimeAdapter;

export type WorkerNonCodexTurnResult =
  | ClaudeRuntimeTurnResult
  | CustomCommandTurnResult;

export type CustomCommandTurnInput = {
  prompt: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type CustomCommandTurnResult = {
  command: string;
  args: string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  result: "success" | "process-error";
  errorMessage?: string;
};

export type CustomCommandSpawnLike = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
) => ChildProcess;

export class CustomCommandWorkerRuntimeAdapter implements AgentRuntimeAdapter<
  void,
  CustomCommandTurnInput,
  CustomCommandTurnResult,
  AgentRuntimeEvent
> {
  private activeChild: ChildProcess | null = null;

  constructor(
    private readonly config: {
      workingDirectory: string;
      command: string;
      args: readonly string[];
      env?: NodeJS.ProcessEnv;
      authEnvKey?: string;
      onSpawned?: (child: ChildProcess) => void;
    },
    private readonly dependencies: {
      spawnImpl?: CustomCommandSpawnLike;
    } = {}
  ) {}

  prepare(): void {}

  async spawnTurn(
    input: CustomCommandTurnInput
  ): Promise<CustomCommandTurnResult> {
    const command = this.config.command;
    const args = [...this.config.args];
    const cwd = input.cwd ?? this.config.workingDirectory;
    const child = (this.dependencies.spawnImpl ?? spawn)(command, args, {
      cwd,
      env: {
        ...this.config.env,
        ...input.env,
        SYMPHONY_RENDERED_PROMPT: input.prompt,
      },
      stdio: "pipe",
    });
    this.activeChild = child;
    this.config.onSpawned?.(child);

    let stdout = "";
    let stderr = "";
    let spawnError: string | undefined;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      spawnError = error.message;
    });

    if (child.stdin && !child.stdin.destroyed) {
      child.stdin.end(input.prompt);
    }

    const { exitCode, signal } = await waitForChildExit(child);
    await Promise.all([
      child.stdout ? finished(child.stdout).catch(() => undefined) : undefined,
      child.stderr ? finished(child.stderr).catch(() => undefined) : undefined,
    ]);
    this.activeChild = null;

    const result =
      exitCode === 0 && signal === null && !spawnError
        ? "success"
        : "process-error";

    return {
      command,
      args,
      cwd,
      stdout,
      stderr,
      exitCode,
      signal,
      result,
      errorMessage: spawnError,
    };
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

  shutdown(): void {
    this.stopActiveChild();
  }

  cancel(): void {
    this.stopActiveChild();
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

export function createWorkerNonCodexRuntimeAdapter(
  workflow: WorkflowDefinition,
  context: WorkerNonCodexRuntimeContext
): WorkerNonCodexRuntimeAdapter {
  const runtime = workflow.runtime;

  if (!runtime || runtime.kind === "codex-app-server") {
    throw new Error(
      "Worker non-Codex runtime adapter requested for a Codex runtime."
    );
  }

  switch (runtime.kind) {
    case "claude-print":
      return createClaudePrintRuntimeAdapter(
        {
          workingDirectory: context.workingDirectory,
          runtimeRoot: context.runtimeRoot,
          runtimeDirectory: context.runtimeDirectory,
          command: runtime.command,
          args: runtime.args,
          env: context.env,
          authEnvKey: runtime.auth.env ?? undefined,
          isolation: {
            bare: runtime.isolation.bare,
            strictMcpConfig: runtime.isolation.strictMcpConfig,
          },
        },
        {
          ...context.claudeDependencies,
          onSpawned: context.onSpawned,
        }
      );
    case "custom":
      return new CustomCommandWorkerRuntimeAdapter(
        {
          workingDirectory: context.workingDirectory,
          command: runtime.command,
          args: runtime.args,
          env: context.env,
          authEnvKey: runtime.auth.env ?? undefined,
          onSpawned: context.onSpawned,
        },
        context.customDependencies
      );
  }
}

function waitForChildExit(
  child: ChildProcess
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ exitCode, signal });
    };

    child.once("exit", settle);
    child.once("error", () => settle(1, null));
  });
}
