import { spawn } from "node:child_process";

/**
 * Hook kinds matching WORKFLOW.md `hooks` configuration keys.
 *
 * - `after_create`  — runs after the issue workspace is first created
 * - `before_run`    — runs before each worker execution starts
 * - `after_run`     — runs after each worker execution completes
 * - `before_remove` — runs before the issue workspace is deleted (fail-closed)
 */
export type HookKind =
  | "after_create"
  | "before_run"
  | "after_run"
  | "before_remove";

export type HookOutcome = "success" | "failure" | "timeout" | "skipped";

export type HookResult = {
  kind: HookKind;
  outcome: HookOutcome;
  exitCode: number | null;
  durationMs: number;
  error: string | null;
};

export type HookExecutionOptions = {
  kind: HookKind;
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
};

const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

export async function executeHook(
  options: HookExecutionOptions
): Promise<HookResult> {
  const { kind, command, cwd, env, timeoutMs } = options;
  const start = Date.now();
  const normalizedCommand = normalizeHookCommand(command);

  return new Promise<HookResult>((resolveResult) => {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const child = spawn("bash", ["-lc", normalizedCommand], {
      cwd,
      env: { ...process.env, ...env },
      stdio: "pipe",
    });

    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        // Give a grace period for SIGTERM, then force kill
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already exited
          }
        }, 5_000);
      }, timeoutMs);
    }

    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      const durationMs = Date.now() - start;
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

      if (timedOut) {
        resolveResult({
          kind,
          outcome: "timeout",
          exitCode: code,
          durationMs,
          error: `Hook "${kind}" timed out after ${timeoutMs}ms`,
        });
        return;
      }

      if (code !== 0) {
        resolveResult({
          kind,
          outcome: "failure",
          exitCode: code,
          durationMs,
          error: stderr || `Hook "${kind}" exited with code ${code}`,
        });
        return;
      }

      resolveResult({
        kind,
        outcome: "success",
        exitCode: 0,
        durationMs,
        error: null,
      });
    });

    child.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolveResult({
        kind,
        outcome: "failure",
        exitCode: null,
        durationMs: Date.now() - start,
        error: err.message,
      });
    });
  });
}

export function buildHookEnv(context: {
  tenantId: string;
  workspaceKey: string;
  issueSubjectId: string;
  issueIdentifier: string;
  workspacePath: string;
  repositoryPath: string;
  runId?: string;
  state?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    SYMPHONY_TENANT_ID: context.tenantId,
    SYMPHONY_ISSUE_WORKSPACE_KEY: context.workspaceKey,
    SYMPHONY_ISSUE_SUBJECT_ID: context.issueSubjectId,
    SYMPHONY_ISSUE_IDENTIFIER: context.issueIdentifier,
    SYMPHONY_WORKSPACE_PATH: context.workspacePath,
    SYMPHONY_REPOSITORY_PATH: context.repositoryPath,
  };

  if (context.runId) {
    env.SYMPHONY_RUN_ID = context.runId;
  }
  if (context.state) {
    env.SYMPHONY_ISSUE_STATE = context.state;
  }

  return env;
}

export function resolveHookCommand(
  hooks: {
    afterCreate: string | null;
    beforeRun: string | null;
    afterRun: string | null;
    beforeRemove: string | null;
  },
  kind: HookKind
): string | null {
  switch (kind) {
    case "after_create":
      return hooks.afterCreate;
    case "before_run":
      return hooks.beforeRun;
    case "after_run":
      return hooks.afterRun;
    case "before_remove":
      return hooks.beforeRemove;
  }
}

export async function executeWorkspaceHook(options: {
  kind: HookKind;
  hooks: {
    afterCreate: string | null;
    beforeRun: string | null;
    afterRun: string | null;
    beforeRemove: string | null;
  };
  repositoryPath: string;
  env: Record<string, string>;
  timeoutMs?: number;
}): Promise<HookResult> {
  const hookCommand = resolveHookCommand(options.hooks, options.kind);

  if (!hookCommand) {
    return {
      kind: options.kind,
      outcome: "skipped",
      exitCode: null,
      durationMs: 0,
      error: null,
    };
  }

  return executeHook({
    kind: options.kind,
    command: hookCommand,
    cwd: options.repositoryPath,
    env: options.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
  });
}

function normalizeHookCommand(command: string): string {
  const trimmed = command.trim();
  if (
    trimmed.includes("/") &&
    !trimmed.startsWith("/") &&
    !trimmed.startsWith("./") &&
    !trimmed.startsWith("../") &&
    !/\s/.test(trimmed)
  ) {
    return `bash ./${trimmed}`;
  }
  return command;
}
