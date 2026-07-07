import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

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
  envAllowlist?: readonly string[];
  timeoutMs: number;
};

const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

export async function executeHook(
  options: HookExecutionOptions
): Promise<HookResult> {
  const { kind, command, cwd, env, envAllowlist = [], timeoutMs } = options;
  const start = Date.now();
  const hookCommand = resolveHookCommandSpawn(command);
  if (!hookCommand.ok) {
    return {
      kind,
      outcome: "failure",
      exitCode: null,
      durationMs: Date.now() - start,
      error: hookCommand.error,
    };
  }

  return new Promise<HookResult>((resolveResult) => {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const child = spawn(hookCommand.command, hookCommand.args, {
      cwd,
      env: buildHookExecutionEnv(env, envAllowlist),
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
  projectId: string;
  workspaceKey: string;
  issueSubjectId: string;
  issueIdentifier: string;
  workspacePath: string;
  repositoryPath: string;
  runId?: string;
  state?: string;
}): Record<string, string> {
  const env: Record<string, string> = {
    SYMPHONY_PROJECT_ID: context.projectId,
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
  trusted?: boolean;
  envAllowlist?: readonly string[];
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

  if (!options.trusted) {
    return {
      kind: options.kind,
      outcome: "skipped",
      exitCode: null,
      durationMs: 0,
      error: `Workflow hook "${options.kind}" skipped because WORKFLOW.md hooks require explicit trust approval.`,
    };
  }

  return executeHook({
    kind: options.kind,
    command: hookCommand,
    cwd: options.repositoryPath,
    env: options.env,
    envAllowlist: options.envAllowlist,
    timeoutMs: options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
  });
}

const DEFAULT_HOOK_ENV_KEYS = new Set([
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "PWD",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
]);

const SHELL_METACHARACTER_PATTERN = /[;&|`$<>()[\]{}*?!#~="'\\\n\r]/;

export function buildHookExecutionEnv(
  env: Record<string, string>,
  allowlist: readonly string[] = []
): Record<string, string> {
  const allowed = new Set([...DEFAULT_HOOK_ENV_KEYS, ...allowlist]);
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      return (
        allowed.has(key) ||
        key.startsWith("SYMPHONY_") ||
        key.startsWith("LC_")
      );
    })
  );
}

function resolveHookCommandSpawn(
  command: string
): { ok: true; command: string; args: string[] } | { ok: false; error: string } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { ok: false, error: "Hook command is empty." };
  }
  if (/\s/.test(trimmed) || SHELL_METACHARACTER_PATTERN.test(trimmed)) {
    return {
      ok: false,
      error:
        "Workflow hooks must reference a script path without shell syntax or arguments.",
    };
  }
  if (isAbsolute(trimmed)) {
    return { ok: true, command: trimmed, args: [] };
  }
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return { ok: true, command: trimmed, args: [] };
  }
  if (trimmed.includes("/")) {
    return { ok: true, command: `./${trimmed}`, args: [] };
  }
  return { ok: true, command: `./${trimmed}`, args: [] };
}
