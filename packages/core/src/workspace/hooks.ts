import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { resolve } from "node:path";

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
  /** The hook kind being executed. */
  kind: HookKind;
  /** Absolute path to the hook script. */
  scriptPath: string;
  /** Working directory for the hook process (usually the issue workspace). */
  cwd: string;
  /** Environment variables passed to the hook process. */
  env: Record<string, string>;
  /** Timeout in milliseconds. 0 or negative means no timeout. */
  timeoutMs: number;
};

const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/**
 * Execute a single workspace lifecycle hook as a child process.
 *
 * The hook script is executed via `bash` with a timeout. If the script
 * exits with a non-zero code, the result is `failure`. If it exceeds the
 * timeout, the process is killed and the result is `timeout`.
 *
 * If the script path does not exist or is not executable, the hook is
 * silently skipped with outcome `skipped`.
 */
export async function executeHook(
  options: HookExecutionOptions
): Promise<HookResult> {
  const { kind, scriptPath, cwd, env, timeoutMs } = options;
  const resolvedPath = resolve(scriptPath);
  const start = Date.now();

  const accessible = await isExecutable(resolvedPath);
  if (!accessible) {
    return {
      kind,
      outcome: "skipped",
      exitCode: null,
      durationMs: Date.now() - start,
      error: null,
    };
  }

  return new Promise<HookResult>((resolveResult) => {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const child = spawn("bash", [resolvedPath], {
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

/**
 * Build the standard hook environment variables for a workspace lifecycle hook.
 */
export function buildHookEnv(context: {
  workspaceId: string;
  workspaceKey: string;
  issueSubjectId: string;
  issueIdentifier: string;
  workspacePath: string;
  repositoryPath: string;
  runId?: string;
  phase?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    SYMPHONY_WORKSPACE_ID: context.workspaceId,
    SYMPHONY_ISSUE_WORKSPACE_KEY: context.workspaceKey,
    SYMPHONY_ISSUE_SUBJECT_ID: context.issueSubjectId,
    SYMPHONY_ISSUE_IDENTIFIER: context.issueIdentifier,
    SYMPHONY_WORKSPACE_PATH: context.workspacePath,
    SYMPHONY_REPOSITORY_PATH: context.repositoryPath,
  };

  if (context.runId) {
    env.SYMPHONY_RUN_ID = context.runId;
  }
  if (context.phase) {
    env.SYMPHONY_RUN_PHASE = context.phase;
  }

  return env;
}

/**
 * Resolve the hook script path from the workflow configuration for a given hook kind.
 *
 * Returns `null` if the hook is not configured.
 */
export function resolveHookScript(
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

/**
 * Execute a workspace lifecycle hook with standard defaults.
 *
 * Returns a `HookResult` describing the outcome. If the hook is not configured
 * (null script path), returns a `skipped` result.
 */
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
  const scriptRelative = resolveHookScript(options.hooks, options.kind);

  if (!scriptRelative) {
    return {
      kind: options.kind,
      outcome: "skipped",
      exitCode: null,
      durationMs: 0,
      error: null,
    };
  }

  const scriptPath = resolve(options.repositoryPath, scriptRelative);

  return executeHook({
    kind: options.kind,
    scriptPath,
    cwd: options.repositoryPath,
    env: options.env,
    timeoutMs: options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
  });
}

/** Default hook timeout in milliseconds. */
export { DEFAULT_HOOK_TIMEOUT_MS };

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
