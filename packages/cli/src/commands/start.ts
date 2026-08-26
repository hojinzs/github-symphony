import { mkdir, readFile, rm } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
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
  getProcessIdentity,
  releaseProjectLock,
  resolveOrchestratorLogLevel,
  type OrchestratorLogLevel,
  type ProjectLockHandle,
} from "@gh-symphony/orchestrator";
import type {
  OrchestratorProjectConfig,
  ProjectStatusSnapshot,
  TrackerStateRequest,
  TrackerStateResult,
} from "@gh-symphony/core";
import {
  DashboardFsReader,
  isAuthorizedApiRequest,
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
  GitHubAuthError,
  type GitHubAuthSource,
  resolveGitHubAuth,
  runGhAuthLogin,
  runGhAuthRefresh,
} from "../github/gh-auth.js";
import { GitHubApiError, GitHubScopeError } from "../github/client.js";
import { formatRepositoryDisplay } from "../format/repository.js";
import { findLiveDuplicate, registerInstance, unregisterInstance, type InstanceEntry } from "../instances.js";

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
const DAEMON_PROJECT_ID_ENV = "GH_SYMPHONY_DAEMON_PROJECT_ID";

type RepoStartAuthPreflightResult =
  | { ok: true; githubAuthSource?: GitHubAuthSource }
  | { ok: false };

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function displayGhAuthError(
  error: GitHubAuthError,
  retryCommand = REPO_START_COMMAND
): void {
  const remediation = formatGhAuthRemediation(error, {
    retryCommand,
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
  configuredSources?: GitHubAuthSource[];
}): void {
  if ((auth.configuredSources?.length ?? 0) > 1) {
    process.stderr.write(
      `Warning: Both GITHUB_GRAPHQL_TOKEN and gh CLI authentication are configured. This operation is using ${formatAuthSource(auth.source)}.\n`
    );
  }
  process.stdout.write(
    `Authenticated via ${formatAuthSource(auth.source)} as ${auth.login}\n`
  );
}

async function resolveRepoStartGitHubAuth(input: {
  allowInteractiveRemediation: boolean;
  retryCommand: string;
}): Promise<RepoStartAuthPreflightResult> {
  try {
    const auth = await resolveGitHubAuth();
    process.env.GITHUB_GRAPHQL_TOKEN = auth.token;
    displayGitHubAuthSuccess(auth);
    return { ok: true, githubAuthSource: auth.source };
  } catch (error) {
    if (!(error instanceof GitHubAuthError)) {
      throw error;
    }

    displayGhAuthError(error, input.retryCommand);

    const remediation = formatGhAuthRemediation(error, {
      retryCommand: input.retryCommand,
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
      if (retryError instanceof GitHubAuthError) {
        displayGhAuthError(retryError, input.retryCommand);
        process.exitCode = 1;
        return { ok: false };
      }
      throw retryError;
    }
  }
}

async function preflightRepoStartAuth(
  projectConfig: OrchestratorProjectConfig,
  input: { daemon: boolean; retryCommand: string }
): Promise<RepoStartAuthPreflightResult> {
  if (projectConfig.tracker.adapter === "github-project") {
    return resolveRepoStartGitHubAuth({
      allowInteractiveRemediation: !input.daemon,
      retryCommand: input.retryCommand,
    });
  }

  if (projectConfig.tracker.adapter === "linear") {
    if (process.env.LINEAR_API_KEY?.trim()) {
      return { ok: true };
    }
    process.stderr.write(
      `Linear authentication is required. Set LINEAR_API_KEY in the environment before running '${input.retryCommand}'.\n`
    );
    process.exitCode = 1;
    return { ok: false };
  }

  return { ok: true };
}

type GitHubAuthRuntimeError =
  | GitHubAuthError
  | GitHubScopeError
  | GitHubApiError;

function isGitHubAuthRuntimeError(
  error: unknown
): error is GitHubAuthRuntimeError {
  if (error instanceof GitHubScopeError) {
    return true;
  }
  if (error instanceof GitHubAuthError) {
    return error.code === "missing_scopes" || error.code === "invalid_token";
  }
  if (error instanceof GitHubApiError) {
    return error.status === 401;
  }
  return false;
}

function ghRuntimeErrorToAuthError(
  error: GitHubAuthRuntimeError,
  source?: GitHubAuthSource
): GitHubAuthError {
  if (error instanceof GitHubAuthError) {
    return error;
  }
  if (error instanceof GitHubScopeError) {
    return new GitHubAuthError(
      "missing_scopes",
      `GitHub token is missing required scopes: ${error.requiredScopes.join(", ")}`,
      {
        missingScopes: [...error.requiredScopes],
        currentScopes: [...error.currentScopes],
        source,
      }
    );
  }
  return new GitHubAuthError(
    "invalid_token",
    error.message || "GitHub token validation failed.",
    { source }
  );
}

function displayRuntimeAuthShutdown(
  error: GitHubAuthRuntimeError,
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
  workerHttpServer?: Server;
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
const DEFAULT_HTTP_HOST = "127.0.0.1";
const BIND_ALL_HTTP_HOST = "0.0.0.0";
const HTTP_API_TOKEN_ENV = "GH_SYMPHONY_HTTP_TOKEN";

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseStartArgs(args: string[]): {
  daemon: boolean;
  once: boolean;
  assignedOnly?: boolean;
  allowDuplicate?: boolean;
  bindAll: boolean;
  httpPort?: number;
  webPort?: number;
  logLevel?: string;
  error?: string;
} {
  const parsed: {
    daemon: boolean;
    once: boolean;
    assignedOnly?: boolean;
    allowDuplicate?: boolean;
    bindAll: boolean;
    httpPort?: number;
    webPort?: number;
    logLevel?: string;
    error?: string;
  } = {
    daemon: false,
    bindAll: false,
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
    if (arg === "--allow-duplicate") { parsed.allowDuplicate = true; continue; }
    if (arg === "--bind-all") {
      parsed.bindAll = true;
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
    const skipped = snapshot.summary.skipped ?? 0;
    if (skipped > 0) {
      logLine(
        yellow("⚠"),
        `${bold(String(skipped))} item(s) skipped by the tracker`
      );
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

  const prevSkipped = prevSnapshot?.summary.skipped ?? 0;
  const skipped = snapshot.summary.skipped ?? 0;
  if (skipped !== prevSkipped) {
    logLine(
      yellow("⚠"),
      `${bold(String(skipped))} item(s) skipped by the tracker`
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
    (snapshot.summary.skipped ?? 0) !== (prevSnapshot?.summary.skipped ?? 0) ||
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

function resolveHttpApiToken(): string {
  const configured = process.env[HTTP_API_TOKEN_ENV]?.trim();
  return configured || randomBytes(32).toString("base64url");
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
    return `http://${DEFAULT_HTTP_HOST}`;
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
  host: string;
  apiToken: string;
  service: {
    requestReconcile(): void;
    acquireWorkerTurnLease(request: {
      issueId: string;
      runId: string;
      turn: number;
    }): Promise<
      | { acquired: true; expiresAt: string }
      | { acquired: false; reason: string }
    >;
    requestTrackerState(request: {
      runId: string;
      request: TrackerStateRequest;
    }): Promise<TrackerStateResult>;
  };
  trackerStateToken: string;
}): Promise<{ server: Server; port: number; url: string }> {
  const reader = new DashboardFsReader(
    join(input.runtimeRoot, "projects", encodeURIComponent(input.projectId))
  );

  for (let port = input.initialPort; port <= 65_535; port += 1) {
    const server = createServer((request, response) => {
      void (async () => {
        try {
          const url = new URL(request.url ?? "/", `http://${input.host}`);
          const isWorkerApi =
            url.pathname === "/api/v1/worker-state" ||
            url.pathname === "/api/v1/worker-turn-lease";
          const isTrackerStateApi = url.pathname === "/api/v1/tracker-state";
          if (
            url.pathname.startsWith("/api/v1/") &&
            !isTrackerStateApi &&
            !isAuthorizedApiRequest(
              request,
              isWorkerApi ? input.trackerStateToken : input.apiToken
            )
          ) {
            respondJson(response, 401, { error: "Unauthorized" });
            return;
          }
          if (request.method === "POST" && url.pathname === "/api/v1/refresh") {
            request.resume();
            input.service.requestReconcile();
            respondJson(response, 202, { ok: true });
            return;
          }

          if (
            request.method === "POST" &&
            url.pathname === "/api/v1/worker-state"
          ) {
            const body = await readJsonRequest(request);
            if (!body || typeof body.issueIdentifier !== "string") {
              respondJson(response, 400, { reason: "invalid_request" });
              return;
            }
            const snapshot = await reader.loadProjectState();
            const active =
              snapshot?.activeRuns.some(
                (run) => run.issueIdentifier === body.issueIdentifier
              ) ?? false;
            respondJson(response, 200, { active });
            return;
          }

          if (
            request.method === "POST" &&
            url.pathname === "/api/v1/worker-turn-lease"
          ) {
            const body = await readJsonRequest(request);
            if (
              !body ||
              typeof body.issueId !== "string" ||
              typeof body.runId !== "string" ||
              typeof body.turn !== "number"
            ) {
              respondJson(response, 400, { reason: "invalid_request" });
              return;
            }
            const lease = await input.service.acquireWorkerTurnLease({
              issueId: body.issueId,
              runId: body.runId,
              turn: body.turn,
            });
            respondJson(response, lease.acquired ? 200 : 409, lease);
            return;
          }

          if (
            request.method === "POST" &&
            url.pathname === "/api/v1/tracker-state"
          ) {
            const body = await readJsonRequest(request);
            const runIdHeader = request.headers["x-symphony-run-id"];
            const runId =
              typeof runIdHeader === "string" ? runIdHeader.trim() : "";
            const tokenHeader =
              request.headers["x-symphony-orchestrator-token"];
            const token =
              typeof tokenHeader === "string" ? tokenHeader.trim() : "";
            const trackerRequest = parseTrackerStateRequest(body);
            if (!runId || !trackerRequest) {
              respondJson(
                response,
                400,
                rejectedTrackerStateResult(
                  trackerRequest,
                  "invalid_tracker_state_request"
                )
              );
              return;
            }
            if (!secretsEqual(token, input.trackerStateToken)) {
              respondJson(
                response,
                401,
                rejectedTrackerStateResult(
                  trackerRequest,
                  "tracker_state_authentication_failed"
                )
              );
              return;
            }
            const result = await input.service.requestTrackerState({
              runId,
              request: trackerRequest,
            });
            respondJson(
              response,
              result.ok
                ? 200
                : result.outcome === "expected_state_mismatch"
                  ? 409
                  : result.outcome === "rejected"
                    ? 403
                    : 503,
              result
            );
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
        server.listen(port, input.host);
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

async function readJsonRequest(
  request: IncomingMessage
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) {
      return null;
    }
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseTrackerStateRequest(
  body: Record<string, unknown> | null
): TrackerStateRequest | null {
  if (body?.type === "state-read") {
    return { type: "state-read" };
  }
  if (
    body?.type !== "transition-request" ||
    typeof body.expected_state !== "string" ||
    typeof body.target_state !== "string" ||
    typeof body.reason !== "string" ||
    (body.comment_body !== undefined && typeof body.comment_body !== "string")
  ) {
    return null;
  }
  return {
    type: "transition-request",
    expectedState: body.expected_state,
    targetState: body.target_state,
    reason: body.reason,
    ...(body.comment_body === undefined
      ? {}
      : { commentBody: body.comment_body }),
  };
}

function rejectedTrackerStateResult(
  request: TrackerStateRequest | null,
  error: string
): TrackerStateResult {
  return {
    ok: false,
    outcome: "rejected",
    state: null,
    expectedState:
      request?.type === "transition-request" ? request.expectedState : null,
    targetState:
      request?.type === "transition-request" ? request.targetState : null,
    reason: request?.type === "transition-request" ? request.reason : null,
    rateLimits: null,
    error,
  };
}

function secretsEqual(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
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
      `Usage: gh-symphony ${options.invocation === "project" ? "project" : "repo"} start [--daemon] [--once] [--assigned-only] [--http [port]] [--web [port]] [--bind-all]${options.invocation === "project" ? " [--project-dir <path>]" : ""}\n`
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
    requestedProjectId: options.projectId ?? process.env[DAEMON_PROJECT_ID_ENV],
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
  const instanceBase = {
    projectId,
    repo: `${projectConfig.repository.owner}/${projectConfig.repository.name}`,
    repoPath: resolve(projectConfig.repositoryDir ?? projectConfig.projectDir ?? process.cwd()),
    workspacePath: resolve(projectConfig.workspaceDir ?? process.cwd()),
    runtimeRoot,
    standalone: options.invocation === "project",
  };
  if (!parsed.allowDuplicate) {
    const duplicate = await findLiveDuplicate(instanceBase);
    if (duplicate && resolve(duplicate.runtimeRoot) !== runtimeRoot) {
      throw new Error(`Project "${projectId}" is already running for ${instanceBase.repoPath} (PID ${duplicate.pid}). Use --allow-duplicate to override.`);
    }
  }
  let logLevel: OrchestratorLogLevel;
  const requestedLogLevel =
    parsed.logLevel ??
    (options.verbose ? "verbose" : process.env.SYMPHONY_LOG_LEVEL);
  try {
    logLevel = resolveOrchestratorLogLevel(requestedLogLevel);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Unsupported log level"}\n`
    );
    process.exitCode = 2;
    return;
  }

  const authPreflight = await preflightRepoStartAuth(projectConfig, {
    daemon: parsed.daemon,
    retryCommand:
      options.invocation === "project"
        ? "gh-symphony project start"
        : REPO_START_COMMAND,
  });
  if (!authPreflight.ok) {
    return;
  }
  const httpApiToken = resolveHttpApiToken();
  const httpHost = parsed.bindAll ? BIND_ALL_HTTP_HOST : DEFAULT_HTTP_HOST;

  if (parsed.daemon) {
    await startDaemon(
      options,
      projectId,
      parsed.logLevel ?? (options.verbose ? "verbose" : undefined),
      parsed.httpPort,
      parsed.webPort,
      parsed.assignedOnly === true,
      parsed.bindAll,
      httpApiToken,
      projectConfig.projectDir,
      projectId
    );
    return;
  }

  // ── 5.1: Foreground mode with live logging ────────────────────────────────
  let projectLock: ProjectLockHandle | null = null;
  let instance: InstanceEntry | null = null;
  try {
    projectLock = await acquireProjectLock({
      runtimeRoot,
      projectId,
    });
    if (projectLock) {
      instance = { ...instanceBase, pid: projectLock.pid, startedAt: projectLock.startedAt, heartbeatAt: projectLock.heartbeatAt, processIdentity: projectLock.processIdentity };
      await registerInstance(instance);
    }
    await removeHttpBindingState(options.configDir, projectId);

    const store = createStore(runtimeRoot);
    let prevSnapshot: ProjectStatusSnapshot | null = null;
    let isFirst = true;
    let requestShutdown: (() => void) | null = null;
    let authShutdownRequested = false;
    const service = new OrchestratorService(store, projectConfig, {
      logLevel,
      assignedOnly: parsed.assignedOnly,
      ownerToken: projectLock.ownerToken,
      onTick: async (snapshot) => {
        try {
          if (authShutdownRequested) {
            return;
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
    let workerHttpServer: Awaited<ReturnType<typeof startHttpServer>> | null =
      null;
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
        workerHttpServer: workerHttpServer?.server,
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
      const trackerStateToken = randomBytes(32).toString("hex");
      workerHttpServer = await startHttpServer({
        runtimeRoot,
        projectId,
        initialPort: parsed.httpPort ?? 0,
        host: parsed.httpPort !== undefined ? httpHost : DEFAULT_HTTP_HOST,
        apiToken: httpApiToken,
        service,
        trackerStateToken,
      });
      service.setWorkerOrchestratorUrl(workerHttpServer.url);
      service.setWorkerOrchestratorToken(trackerStateToken);

      httpServer =
        parsed.webPort !== undefined
          ? await startControlPlaneServer({
              host: httpHost,
              port: parsed.webPort,
              runtimeRoot: join(
                runtimeRoot,
                "projects",
                encodeURIComponent(projectId)
              ),
              apiToken: httpApiToken,
              onRefreshRequest: () => service.requestReconcile(),
            })
          : parsed.httpPort !== undefined
            ? workerHttpServer
            : null;
      if (httpServer) {
        try {
          await writeHttpBindingState(options.configDir, projectId, {
            host: httpHost,
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
        if (instance) {
          instance = { ...instance, endpoint: httpServer.url };
          await registerInstance(instance);
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
        logLine(
          cyan("\u25A1"),
          parsed.webPort !== undefined
            ? `Open ${httpServer.url}/#token=${encodeURIComponent(
                httpApiToken
              )}`
            : `Bearer token: ${httpApiToken}`
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
            await Promise.all(
              [...new Set([httpServer?.server, workerHttpServer?.server])]
                .filter((server): server is Server => Boolean(server))
                .map((server) => closeHttpServer(server))
            ).catch((closeError) => {
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
    if (instance) await unregisterInstance(instance);
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
    await Promise.all(
      [...new Set([input.httpServer, input.workerHttpServer])]
        .filter((server): server is Server => Boolean(server))
        .map((server) => closeHttpServer(server))
    );
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
  assignedOnly = false,
  bindAll = false,
  httpApiToken = resolveHttpApiToken(),
  projectDir?: string,
  selectedProjectId?: string
): Promise<void> {
  const logPath = orchestratorLogPath(options.configDir, projectId);
  await mkdir(dirname(logPath), { recursive: true });

  const { closeSync, openSync } = await import("node:fs");
  const logFd = openSync(logPath, "a");

  const child = spawn(
    process.execPath,
    [
      process.argv[1]!,
      "repo",
      "start",
      ...(options.verbose ? ["--verbose"] : []),
      ...(assignedOnly ? ["--assigned-only"] : []),
      ...(bindAll ? ["--bind-all"] : []),
      ...(httpPort !== undefined ? ["--http", String(httpPort)] : []),
      ...(webPort !== undefined ? ["--web", String(webPort)] : []),
      ...(logLevel ? ["--log-level", logLevel] : []),
    ],
    {
      cwd: projectDir ?? process.cwd(),
      env: {
        ...process.env,
        GH_SYMPHONY_CONFIG_DIR: resolve(options.configDir),
        ...(selectedProjectId
          ? { [DAEMON_PROJECT_ID_ENV]: selectedProjectId }
          : {}),
        [HTTP_API_TOKEN_ENV]: httpApiToken,
      },
      detached: true,
      stdio: ["ignore", logFd, logFd],
    }
  );

  const pidPath = daemonPidPath(options.configDir, projectId);
  try {
    await waitForChildSpawn(child);
    if (!child.pid) {
      throw new Error("Daemon process started without a PID.");
    }

    await writeJsonFile(pidPath, {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      processIdentity: getProcessIdentity(child.pid),
      cwd: projectDir ?? process.cwd(),
    });
    child.unref();
  } catch (error) {
    await rm(pidPath, { force: true });
    if (child.pid) {
      try {
        child.kill();
      } catch {
        // The child may already have exited after a persistence failure.
      }
    }
    throw error;
  } finally {
    closeSync(logFd);
  }

  process.stdout.write(
    `Orchestrator started in background (PID: ${child.pid}).\n` +
      `Logs: ${logPath}\n` +
      `Stop with: ${options.invocation === "project" ? "gh-symphony project stop" : "gh-symphony repo stop"}\n`
  );
  if (httpPort !== undefined || webPort !== undefined) {
    process.stdout.write(`HTTP API bearer token: ${httpApiToken}\n`);
  }
}

async function waitForChildSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}
