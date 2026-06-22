import { writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import * as p from "@clack/prompts";
import type { GlobalOptions } from "../index.js";
import {
  daemonPidPath,
  httpStatusPath,
  orchestratorLogPath,
  writeJsonFile,
} from "../config.js";
import {
  OrchestratorService,
  acquireProjectLock,
  createStore,
  releaseProjectLock,
  resolveOrchestratorLogLevel,
  type OrchestratorLogLevel,
  type ProjectLockHandle,
} from "@gh-symphony/orchestrator";
import type {
  OrchestratorProjectConfig,
  ProjectStatusSnapshot,
} from "@gh-symphony/core";
import {
  DashboardFsReader,
  resolveDashboardResponse,
} from "@gh-symphony/dashboard";
import { startControlPlaneServer } from "@gh-symphony/control-plane";
import { resolveRuntimeRoot } from "../orchestrator-runtime.js";
import {
  handleMissingManagedProjectConfig,
  resolveManagedProjectConfig,
} from "../project-selection.js";
import { rejectRemovedProjectId } from "../removed-project-id.js";
import { bold, dim, green, red, yellow, cyan, setNoColor } from "../ansi.js";
import {
  formatGhAuthRemediation,
  GhAuthError,
  type GitHubAuthSource,
  resolveGitHubAuth,
  runGhAuthLogin,
  runGhAuthRefresh,
} from "../github/gh-auth.js";
import { GitHubApiError, GitHubScopeError } from "../github/client.js";
import { formatRepositoryDisplay } from "../format/repository.js";

function timestamp(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return dim(`${hh}:${mm}:${ss}`);
}

function logLine(icon: string, msg: string): void {
  process.stdout.write(`${timestamp()} ${icon} ${msg}\n`);
}

const REPO_START_COMMAND = "gh-symphony repo start";

type RepoStartAuthPreflightResult =
  | { ok: true; githubAuthSource?: GitHubAuthSource }
  | { ok: false };

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function displayGhAuthError(error: GhAuthError): void {
  const remediation = formatGhAuthRemediation(error, {
    retryCommand: REPO_START_COMMAND,
  });
  process.stderr.write(`${remediation.title}: ${remediation.message}\n`);
  process.stderr.write(`${remediation.hint}\n`);
}

function formatAuthSource(source: "env" | "gh"): string {
  return source === "env" ? "GITHUB_GRAPHQL_TOKEN" : "gh CLI";
}

function displayGitHubAuthSuccess(auth: {
  source: "env" | "gh";
  login: string;
}): void {
  process.stdout.write(
    `Authenticated via ${formatAuthSource(auth.source)} as ${auth.login}\n`
  );
}

async function resolveRepoStartGitHubAuth(input: {
  allowInteractiveRemediation: boolean;
}): Promise<RepoStartAuthPreflightResult> {
  try {
    const auth = await resolveGitHubAuth();
    process.env.GITHUB_GRAPHQL_TOKEN = auth.token;
    displayGitHubAuthSuccess(auth);
    return { ok: true, githubAuthSource: auth.source };
  } catch (error) {
    if (!(error instanceof GhAuthError)) {
      throw error;
    }

    displayGhAuthError(error);

    const remediation = formatGhAuthRemediation(error, {
      retryCommand: REPO_START_COMMAND,
    });
    const canRemediate =
      input.allowInteractiveRemediation &&
      isInteractiveTerminal() &&
      remediation.command !== undefined &&
      error.details.source !== "env";
    if (!canRemediate) {
      process.exitCode = 1;
      return { ok: false };
    }

    const shouldRun = await p.confirm({
      message: `Run '${remediation.command}' now?`,
      initialValue: true,
    });
    if (p.isCancel(shouldRun) || shouldRun !== true) {
      process.exitCode = 1;
      return { ok: false };
    }

    const result =
      error.code === "missing_scopes"
        ? runGhAuthRefresh({ interactive: true })
        : runGhAuthLogin({ interactive: true });
    process.stderr.write(`${result.summary}\n`);
    if (result.status !== "applied") {
      process.exitCode = 1;
      return { ok: false };
    }

    try {
      const auth = await resolveGitHubAuth();
      process.env.GITHUB_GRAPHQL_TOKEN = auth.token;
      displayGitHubAuthSuccess(auth);
      return { ok: true, githubAuthSource: auth.source };
    } catch (retryError) {
      if (retryError instanceof GhAuthError) {
        displayGhAuthError(retryError);
        process.exitCode = 1;
        return { ok: false };
      }
      throw retryError;
    }
  }
}

async function preflightRepoStartAuth(
  projectConfig: OrchestratorProjectConfig,
  input: { daemon: boolean }
): Promise<RepoStartAuthPreflightResult> {
  if (projectConfig.tracker.adapter === "github-project") {
    return resolveRepoStartGitHubAuth({
      allowInteractiveRemediation: !input.daemon,
    });
  }

  if (projectConfig.tracker.adapter === "linear") {
    if (process.env.LINEAR_API_KEY?.trim()) {
      return { ok: true };
    }
    process.stderr.write(
      "Linear authentication is required. Set LINEAR_API_KEY in the environment before running 'gh-symphony repo start'.\n"
    );
    process.exitCode = 1;
    return { ok: false };
  }

  return { ok: true };
}

function isGitHubAuthRuntimeError(error: unknown): error is Error {
  if (error instanceof GitHubScopeError) {
    return true;
  }
  if (error instanceof GhAuthError) {
    return error.code === "missing_scopes" || error.code === "invalid_token";
  }
  if (error instanceof GitHubApiError) {
    return error.status === 401;
  }
  if (error instanceof Error) {
    const maybeStatus = (error as { status?: unknown }).status;
    if (maybeStatus === 401) {
      return true;
    }
    const message = error.message.toLowerCase();
    return (
      message.includes("missing required github scopes") ||
      message.includes("missing required scopes") ||
      message.includes("missing required scope") ||
      message.includes("missing_scopes") ||
      message.includes("bad credentials") ||
      message.includes("invalid token") ||
      message.includes("authentication failed") ||
      message.includes("status 401") ||
      message.includes("401 unauthorized")
    );
  }
  return false;
}

function ghRuntimeErrorToAuthError(
  error: Error,
  source?: GitHubAuthSource
): GhAuthError {
  if (error instanceof GhAuthError) {
    return error;
  }
  if (error instanceof GitHubScopeError) {
    return new GhAuthError(
      "missing_scopes",
      `GitHub token is missing required scopes: ${error.requiredScopes.join(", ")}`,
      {
        missingScopes: [...error.requiredScopes],
        currentScopes: [...error.currentScopes],
        source,
      }
    );
  }
  if (
    error.message.toLowerCase().includes("missing required github scopes") ||
    error.message.toLowerCase().includes("missing required scopes") ||
    error.message.toLowerCase().includes("missing_scopes")
  ) {
    return new GhAuthError("missing_scopes", error.message, { source });
  }
  return new GhAuthError(
    "invalid_token",
    error.message || "GitHub token validation failed.",
    { source }
  );
}

function displayRuntimeAuthShutdown(
  error: Error,
  source?: GitHubAuthSource
): void {
  const authError = ghRuntimeErrorToAuthError(error, source);
  displayGhAuthError(authError);
  process.stderr.write(
    "Stopping repo start because GitHub authentication can no longer be validated.\n"
  );
}

function shouldElevateGitHubAuthRuntimeError(
  projectConfig: OrchestratorProjectConfig,
  error: unknown
): error is Error {
  return (
    projectConfig.tracker.adapter === "github-project" &&
    isGitHubAuthRuntimeError(error)
  );
}

type ForegroundShutdownOptions = {
  configDir: string;
  projectId: string;
  httpServer?: Server;
  projectLock?: ProjectLockHandle | null;
  service?: { shutdown(): Promise<void> };
  exit?: (code?: number) => never;
  releaseLock?: typeof releaseProjectLock;
};

type HttpBindingState = {
  host: string;
  port: number;
  endpoint: string;
};

const DEFAULT_HTTP_PORT = 4680;
const HTTP_HOST = "0.0.0.0";

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseStartArgs(args: string[]): {
  daemon: boolean;
  once: boolean;
  assignedOnly?: boolean;
  httpPort?: number;
  webPort?: number;
  logLevel?: string;
  error?: string;
} {
  const parsed: {
    daemon: boolean;
    once: boolean;
    assignedOnly?: boolean;
    httpPort?: number;
    webPort?: number;
    logLevel?: string;
    error?: string;
  } = {
    daemon: false,
    once: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--daemon" || arg === "-d") {
      parsed.daemon = true;
      continue;
    }
    if (arg === "--once") {
      parsed.once = true;
      continue;
    }
    if (arg === "--assigned-only") {
      parsed.assignedOnly = true;
      continue;
    }
    if (arg === "--http") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        parsed.httpPort = DEFAULT_HTTP_PORT;
        continue;
      }
      parsed.httpPort = parsePort(value, arg);
      i += 1;
      continue;
    }
    if (arg === "--web") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        parsed.webPort = DEFAULT_HTTP_PORT;
        continue;
      }
      parsed.webPort = parsePort(value, arg);
      i += 1;
      continue;
    }
    if (arg === "--log-level") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        parsed.error = `Option '${arg}' argument missing`;
        return parsed;
      }
      parsed.logLevel = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("-")) {
      parsed.error = `Unknown option '${arg}'`;
      return parsed;
    }
  }

  if (parsed.httpPort !== undefined && parsed.webPort !== undefined) {
    parsed.error = "Options '--http' and '--web' cannot be used together";
  }

  return parsed;
}

// ── Tick logging ──────────────────────────────────────────────────────────────

function logTickResult(
  snapshot: ProjectStatusSnapshot,
  prevSnapshot: ProjectStatusSnapshot | null,
  isFirst: boolean
): void {
  if (isFirst) {
    const healthColor =
      snapshot.health === "degraded"
        ? red
        : snapshot.health === "running"
          ? green
          : cyan;
    logLine(
      green("\u25CF"),
      `Repository ${bold(formatRepositoryDisplay(snapshot))} connected ${dim(
        "("
      )}${healthColor(snapshot.health)}${dim(")")}`
    );
    if (snapshot.summary.activeRuns > 0) {
      logLine(cyan("\u25B8"), `${snapshot.summary.activeRuns} active run(s)`);
    }
    return;
  }

  if (prevSnapshot && prevSnapshot.health !== snapshot.health) {
    const icon =
      snapshot.health === "degraded" ? red("\u25CF") : green("\u25CF");
    logLine(
      icon,
      `Health changed: ${prevSnapshot.health} \u2192 ${bold(snapshot.health)}`
    );
  }

  if (snapshot.lastError && snapshot.lastError !== prevSnapshot?.lastError) {
    logLine(red("\u2717"), red(snapshot.lastError));
  }

  if (!snapshot.lastError && prevSnapshot?.lastError) {
    logLine(green("\u2713"), green("Error cleared"));
  }

  const prevDispatched = prevSnapshot?.summary.dispatched ?? 0;
  if (snapshot.summary.dispatched > prevDispatched) {
    const delta = snapshot.summary.dispatched - prevDispatched;
    logLine(yellow("\u25B8"), `Dispatched ${bold(String(delta))} new run(s)`);
  }

  const prevRunIds = new Set(
    prevSnapshot?.activeRuns.map((run) => run.runId) ?? []
  );
  for (const run of snapshot.activeRuns) {
    if (!prevRunIds.has(run.runId)) {
      logLine(
        cyan("\u25B8"),
        `Run started: ${bold(run.issueIdentifier)} ${dim("state=")}${run.issueState} ${dim("status=")}${run.status}`
      );
    }
  }

  const currentRunIds = new Set(snapshot.activeRuns.map((run) => run.runId));
  for (const prevRun of prevSnapshot?.activeRuns ?? []) {
    if (!currentRunIds.has(prevRun.runId)) {
      logLine(
        green("\u2713"),
        `Run finished: ${bold(prevRun.issueIdentifier)} ${dim("(")}${prevRun.status}${dim(")")}`
      );
    }
  }

  const prevSuppressed = prevSnapshot?.summary.suppressed ?? 0;
  if (snapshot.summary.suppressed > prevSuppressed) {
    const delta = snapshot.summary.suppressed - prevSuppressed;
    logLine(
      dim("\u25CB"),
      dim(`${delta} issue(s) suppressed (already running or at limit)`)
    );
  }

  const prevRecovered = prevSnapshot?.summary.recovered ?? 0;
  if (snapshot.summary.recovered > prevRecovered) {
    const delta = snapshot.summary.recovered - prevRecovered;
    logLine(
      yellow("\u21BA"),
      `Recovered ${bold(String(delta))} stalled run(s)`
    );
  }

  const prevRetryCount = prevSnapshot?.retryQueue.length ?? 0;
  if (snapshot.retryQueue.length > prevRetryCount) {
    const delta = snapshot.retryQueue.length - prevRetryCount;
    logLine(yellow("\u25CC"), `${delta} run(s) queued for retry`);
  }

  const changed =
    snapshot.health !== prevSnapshot?.health ||
    snapshot.lastError !== prevSnapshot?.lastError ||
    snapshot.summary.dispatched !== prevSnapshot?.summary.dispatched ||
    snapshot.summary.suppressed !== prevSnapshot?.summary.suppressed ||
    snapshot.summary.recovered !== prevSnapshot?.summary.recovered ||
    snapshot.activeRuns.length !== (prevSnapshot?.activeRuns.length ?? 0) ||
    snapshot.retryQueue.length !== (prevSnapshot?.retryQueue.length ?? 0);

  if (!changed) {
    logLine(
      dim("\u00B7"),
      dim(
        `tick \u2014 ${snapshot.summary.activeRuns} active, ${snapshot.health}`
      )
    );
  }
}

function parsePort(value: string, optionName: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Option '${optionName}' must be an integer port number`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(
      `Option '${optionName}' must be a port number between 0 and 65535`
    );
  }

  return parsed;
}

function respondJson(
  response: ServerResponse,
  status: number,
  payload: unknown
): void {
  response.writeHead(status, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify(payload));
}

function formatBoundUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    return `http://${HTTP_HOST}`;
  }

  const host =
    address.address === "::" ||
    address.address === "::1" ||
    address.address === "0.0.0.0" ||
    address.address === "127.0.0.1"
      ? "localhost"
      : address.address;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return `http://${urlHost}:${address.port}`;
}

function logHttpRequestError(error: unknown): void {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`[start] HTTP request failed: ${message}\n`);
}

async function closeHttpServer(server?: Server): Promise<void> {
  if (!server) {
    return;
  }

  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

async function writeHttpBindingState(
  configDir: string,
  projectId: string,
  binding: HttpBindingState
): Promise<void> {
  await writeJsonFile(httpStatusPath(configDir, projectId), binding);
}

async function removeHttpBindingState(
  configDir: string,
  projectId: string
): Promise<void> {
  await rm(httpStatusPath(configDir, projectId), { force: true });
}

async function startHttpServer(input: {
  runtimeRoot: string;
  projectId: string;
  initialPort: number;
  service: { requestReconcile(): void };
}): Promise<{ server: Server; port: number; url: string }> {
  const reader = new DashboardFsReader(input.runtimeRoot);

  for (let port = input.initialPort; port <= 65_535; port += 1) {
    const server = createServer((request, response) => {
      void (async () => {
        try {
          const url = new URL(request.url ?? "/", `http://${HTTP_HOST}`);
          if (request.method === "POST" && url.pathname === "/api/v1/refresh") {
            request.resume();
            input.service.requestReconcile();
            respondJson(response, 202, { ok: true });
            return;
          }

          const resolved = await resolveDashboardResponse({
            pathname: url.pathname,
            method: request.method ?? "GET",
            reader,
          });
          respondJson(response, resolved.status, resolved.payload);
        } catch (error) {
          logHttpRequestError(error);
          if (!response.headersSent) {
            respondJson(response, 500, {
              error: "Internal server error",
            });
          } else {
            response.end();
          }
        }
      })();
    });

    try {
      await new Promise<void>((resolveReady, rejectReady) => {
        const handleListening = () => {
          cleanup();
          resolveReady();
        };
        const handleError = (error: NodeJS.ErrnoException) => {
          cleanup();
          rejectReady(error);
        };
        const cleanup = () => {
          server.off("listening", handleListening);
          server.off("error", handleError);
        };

        server.once("listening", handleListening);
        server.once("error", handleError);
        server.listen(port, HTTP_HOST);
      });

      return {
        server,
        port,
        url: formatBoundUrl(server),
      };
    } catch (error) {
      await closeHttpServer(server).catch(() => {});
      if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `Unable to bind HTTP server starting from port ${input.initialPort}`
  );
}

// ── Handler ───────────────────────────────────────────────────────────────────

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  setNoColor(options.noColor);
  let parsed: ReturnType<typeof parseStartArgs>;
  try {
    if (rejectRemovedProjectId(args)) {
      return;
    }
    parsed = parseStartArgs(args);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Invalid arguments"}\n`
    );
    process.exitCode = 2;
    return;
  }
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    process.stderr.write(
      "Usage: gh-symphony repo start [--daemon] [--once] [--assigned-only] [--http [port]] [--web [port]]\n"
    );
    process.exitCode = 2;
    return;
  }
  if (parsed.daemon && parsed.once) {
    process.stderr.write(
      "Options '--daemon' and '--once' cannot be used together\n"
    );
    process.exitCode = 2;
    return;
  }
  const projectConfig = await resolveManagedProjectConfig({
    configDir: options.configDir,
    requestedProjectId: undefined,
  });
  if (!projectConfig) {
    handleMissingManagedProjectConfig();
    return;
  }
  if (!hasConfiguredRepository(projectConfig)) {
    process.stderr.write(
      "No repository is configured in this project. Run 'gh-symphony repo init' from the target repository first.\n"
    );
    process.exitCode = 1;
    return;
  }

  const runtimeRoot = resolveRuntimeRoot(options.configDir);
  const projectId = projectConfig.projectId;
  let logLevel: OrchestratorLogLevel;
  try {
    logLevel = resolveOrchestratorLogLevel(
      parsed.logLevel ?? process.env.SYMPHONY_LOG_LEVEL
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Unsupported log level"}\n`
    );
    process.exitCode = 2;
    return;
  }

  const authPreflight = await preflightRepoStartAuth(projectConfig, {
    daemon: parsed.daemon,
  });
  if (!authPreflight.ok) {
    return;
  }

  if (parsed.daemon) {
    await startDaemon(
      options,
      projectId,
      parsed.logLevel,
      parsed.httpPort,
      parsed.webPort,
      parsed.assignedOnly === true
    );
    return;
  }

  // ── 5.1: Foreground mode with live logging ────────────────────────────────
  let projectLock: ProjectLockHandle | null = null;
  try {
    projectLock = await acquireProjectLock({
      runtimeRoot,
      projectId,
    });
    await removeHttpBindingState(options.configDir, projectId);

    const store = createStore(runtimeRoot);
    let prevSnapshot: ProjectStatusSnapshot | null = null;
    let isFirst = true;
    let requestShutdown: (() => void) | null = null;
    let authShutdownRequested = false;
    const service = new OrchestratorService(store, projectConfig, {
      logLevel,
      assignedOnly: parsed.assignedOnly,
      onTick: async (snapshot) => {
        try {
          if (authShutdownRequested) {
            return;
          }

          if (
            projectConfig.tracker.adapter === "github-project" &&
            snapshot.lastError
          ) {
            const runtimeError = new Error(snapshot.lastError);
            if (isGitHubAuthRuntimeError(runtimeError)) {
              authShutdownRequested = true;
              displayRuntimeAuthShutdown(
                runtimeError,
                authPreflight.githubAuthSource
              );
              process.exitCode = 1;
              requestShutdown?.();
              return;
            }
          }

          logTickResult(snapshot, prevSnapshot, isFirst);

          if (!isFirst) {
            const currentRunIds = new Set(
              snapshot.activeRuns.map((run) => run.runId)
            );
            for (const prevRun of prevSnapshot?.activeRuns ?? []) {
              if (!currentRunIds.has(prevRun.runId)) {
                await tailWorkerLog(
                  runtimeRoot,
                  projectId,
                  prevRun.runId,
                  prevRun.issueIdentifier
                );
              }
            }
          }

          prevSnapshot = snapshot;
          isFirst = false;
        } catch (error) {
          if (shouldElevateGitHubAuthRuntimeError(projectConfig, error)) {
            authShutdownRequested = true;
            displayRuntimeAuthShutdown(error, authPreflight.githubAuthSource);
            process.exitCode = 1;
            requestShutdown?.();
            return;
          }
          logLine(
            red("\u2717"),
            red(
              `Tick error: ${error instanceof Error ? error.message : "Unknown error"}`
            )
          );
        }
      },
    });
    let shuttingDown = false;
    let shutdownPromise: Promise<never> | null = null;
    let keepHttpAliveResolve: (() => void) | null = null;
    let httpServer:
      | Awaited<ReturnType<typeof startControlPlaneServer>>
      | Awaited<ReturnType<typeof startHttpServer>>
      | null = null;
    const shutdown = async () => {
      if (shuttingDown) {
        return shutdownPromise;
      }
      shuttingDown = true;
      keepHttpAliveResolve?.();
      keepHttpAliveResolve = null;
      const heldLock = projectLock;
      projectLock = null;
      shutdownPromise = shutdownForegroundOrchestrator({
        configDir: options.configDir,
        projectId,
        httpServer: httpServer?.server,
        projectLock: heldLock,
        service,
      });
      return shutdownPromise;
    };
    const handleSigint = () => {
      void shutdown();
    };
    const handleSigterm = () => {
      void shutdown();
    };
    requestShutdown = () => {
      void shutdown();
    };
    process.on("SIGINT", handleSigint);
    process.on("SIGTERM", handleSigterm);

    try {
      httpServer =
        parsed.webPort !== undefined
          ? await startControlPlaneServer({
              host: HTTP_HOST,
              port: parsed.webPort,
              runtimeRoot,
              onRefreshRequest: () => service.requestReconcile(),
            })
          : parsed.httpPort !== undefined
            ? await startHttpServer({
                runtimeRoot,
                projectId,
                initialPort: parsed.httpPort,
                service,
              })
            : null;
      if (httpServer) {
        try {
          await writeHttpBindingState(options.configDir, projectId, {
            host: HTTP_HOST,
            port: httpServer.port,
            endpoint: httpServer.url,
          });
        } catch (error) {
          logLine(
            yellow("\u26A0"),
            yellow(
              `Failed to persist HTTP binding state (http.json): ${
                error instanceof Error ? error.message : "Unknown error"
              }`
            )
          );
        }
      }

      logLine(
        green("\u25B2"),
        `Starting orchestrator for project: ${bold(projectId)}`
      );
      if (httpServer) {
        logLine(
          cyan("\u25A1"),
          parsed.webPort !== undefined
            ? `Web dashboard listening on ${httpServer.url}`
            : `HTTP status API listening on ${httpServer.url}`
        );
      }
      logLine(
        dim("\u00B7"),
        dim(
          parsed.once
            ? "Running one orchestration tick"
            : "Press Ctrl+C to stop"
        )
      );

      while (!shuttingDown) {
        try {
          await service.run({ once: parsed.once });
          if (shuttingDown) {
            break;
          }
          if (parsed.once) {
            if (httpServer) {
              logLine(
                cyan("\u25A1"),
                parsed.webPort !== undefined
                  ? "One-shot tick completed; web dashboard remains available until Ctrl+C"
                  : "One-shot tick completed; HTTP status API remains available until Ctrl+C"
              );
              if (shuttingDown) {
                break;
              }
              await new Promise<void>((resolve) => {
                keepHttpAliveResolve = resolve;
              });
            } else {
              await shutdown();
            }
          }
          break;
        } catch (error) {
          if (shuttingDown) {
            break;
          }

          if (shouldElevateGitHubAuthRuntimeError(projectConfig, error)) {
            authShutdownRequested = true;
            displayRuntimeAuthShutdown(error, authPreflight.githubAuthSource);
            process.exitCode = 1;
            await shutdown();
            return;
          }

          logLine(
            red("\u2717"),
            red(
              `${parsed.once ? "One-shot run failed" : "Run loop error"}: ${
                error instanceof Error ? error.message : "Unknown error"
              }`
            )
          );
          if (parsed.once) {
            process.exitCode = 1;
            await closeHttpServer(httpServer?.server).catch((closeError) => {
              logLine(
                yellow("\u26A0"),
                `Failed to stop HTTP server: ${
                  closeError instanceof Error
                    ? closeError.message
                    : "Unknown error"
                }`
              );
            });
            await removeHttpBindingState(options.configDir, projectId).catch(
              (removeError) => {
                logLine(
                  yellow("\u26A0"),
                  `Failed to remove HTTP state: ${
                    removeError instanceof Error
                      ? removeError.message
                      : "Unknown error"
                  }`
                );
              }
            );
            return;
          }
        }
      }
    } finally {
      process.off("SIGINT", handleSigint);
      process.off("SIGTERM", handleSigterm);
      if (shutdownPromise) {
        await shutdownPromise;
      }
    }
  } finally {
    await releaseProjectLock(projectLock);
  }
};

export async function shutdownForegroundOrchestrator(
  input: ForegroundShutdownOptions
): Promise<never> {
  logLine(yellow("\u25BC"), "Shutting down...");

  // Drain active workers before tearing down infrastructure so that child
  // processes receive SIGTERM/SIGKILL and do not become orphans.
  if (input.service) {
    try {
      await input.service.shutdown();
    } catch (error) {
      logLine(
        red("\u2717"),
        red(
          `Failed to shut down workers: ${error instanceof Error ? error.message : "Unknown error"}`
        )
      );
    }
  }

  try {
    await closeHttpServer(input.httpServer);
  } catch (error) {
    logLine(
      yellow("\u26A0"),
      `Failed to stop HTTP server: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }

  try {
    await removeHttpBindingState(input.configDir, input.projectId);
  } catch (error) {
    logLine(
      yellow("\u26A0"),
      `Failed to remove HTTP state: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }

  try {
    await (input.releaseLock ?? releaseProjectLock)(input.projectLock);
  } catch (error) {
    logLine(
      yellow("\u26A0"),
      `Failed to release project lock: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }

  return (input.exit ?? process.exit)(process.exitCode ?? 0);
}

function hasConfiguredRepository(config: {
  repository?: OrchestratorProjectConfig["repository"];
}): config is OrchestratorProjectConfig {
  return Boolean(config.repository?.owner && config.repository.name);
}

async function tailWorkerLog(
  runtimeRoot: string,
  projectId: string,
  runId: string,
  issueIdentifier: string
): Promise<void> {
  for (const logPath of [
    join(runtimeRoot, "runs", runId, "worker.log"),
    join(runtimeRoot, "projects", projectId, "runs", runId, "worker.log"),
  ]) {
    try {
      const content = await readFile(logPath, "utf8");
      const lines = content.split("\n").filter((l) => l.trim());
      if (lines.length === 0) return;
      const tail = lines.slice(-30);
      logLine(red("\u2717"), red(`Worker stderr (${issueIdentifier}):`));
      for (const line of tail) {
        process.stdout.write(`  ${dim(line)}\n`);
      }
      return;
    } catch {
      // Try the next known runtime layout.
    }
  }
}

export default handler;

// ── 5.2: Daemon mode ─────────────────────────────────────────────────────────

async function startDaemon(
  options: GlobalOptions,
  projectId: string,
  logLevel?: string,
  httpPort?: number,
  webPort?: number,
  assignedOnly = false
): Promise<void> {
  const logPath = orchestratorLogPath(options.configDir, projectId);
  await mkdir(dirname(logPath), { recursive: true });

  const { openSync } = await import("node:fs");
  const logFd = openSync(logPath, "a");

  const child = spawn(
    process.execPath,
    [
      process.argv[1]!,
      "repo",
      "start",
      ...(assignedOnly ? ["--assigned-only"] : []),
      ...(httpPort !== undefined ? ["--http", String(httpPort)] : []),
      ...(webPort !== undefined ? ["--web", String(webPort)] : []),
      ...(logLevel ? ["--log-level", logLevel] : []),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GH_SYMPHONY_CONFIG_DIR: options.configDir,
      },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    }
  );

  const pidPath = daemonPidPath(options.configDir, projectId);
  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, String(child.pid), "utf8");

  child.unref();

  const { closeSync } = await import("node:fs");
  closeSync(logFd);

  process.stdout.write(
    `Orchestrator started in background (PID: ${child.pid}).\n` +
      `Logs: ${logPath}\n` +
      "Stop with: gh-symphony repo stop\n"
  );
}
