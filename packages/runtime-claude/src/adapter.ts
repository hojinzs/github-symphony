import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentSessionInvalidatedEvent,
  AgentRuntimeAdapter,
  AgentRuntimeCredentialBrokerResponse,
  AgentRuntimeEnv,
  AgentRuntimeEventHandler,
  AgentRuntimeEventSubscription,
  AgentEvent,
  AgentToolExecutionContext,
} from "@gh-symphony/core";
import {
  collectMcpSecretEnvironmentNames,
  extractEnvForClaude,
  prepareAgentChildHome,
  resolveAgentChildHome,
  stageGitUserIdentity,
  stageJsonCredentialFile,
} from "@gh-symphony/core";
import {
  buildClaudePrintArgv,
  type ClaudePrintArgvOptions,
  type ClaudeRuntimeIsolationOptions,
  type ClaudeRuntimeSessionOptions,
} from "./argv.js";
import {
  composeClaudeMcpConfig,
  type ClaudeMcpCompositionResult,
  type ClaudeMcpTokenEnvironment,
} from "./mcp-compose.js";
import {
  startClaudeMcpHttpServer,
  type ClaudeMcpHttpServer,
} from "./mcp-http-server.js";
import {
  spawnClaudeTurn,
  type ClaudeSpawnDependencies,
  type ClaudeSpawnTurnResult,
  type ClaudeWireMessage,
} from "./spawn.js";
import { ClaudeSessionStore, type ClaudeSessionFile } from "./session-store.js";

export type ClaudeRuntimeConfig = {
  workingDirectory: string;
  runtimeDirectory?: string;
  command?: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  extraArgs?: readonly string[];
  isolation?: ClaudeRuntimeIsolationOptions;
  authEnvKey?: string;
  inheritProcessEnv?: boolean;
  runtimeRoot?: string;
  readTimeoutMs?: number;
  turnTimeoutMs?: number;
  stallTimeoutMs?: number;
  hostMcpContext?: AgentToolExecutionContext;
};

export type ClaudeRuntimePrepareContext = {
  runId: string;
  runDirectory?: string;
  previousRunId?: string;
  previousRunDirectory?: string;
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

export type ClaudeRuntimeDependencies = ClaudeSpawnDependencies & {
  createSessionId?: () => string;
  now?: () => Date;
};

export type ClaudeRuntimeEvent = AgentEvent;

export class ClaudePrintRuntimeAdapter implements AgentRuntimeAdapter<
  ClaudeRuntimePrepareContext,
  ClaudeRuntimeTurnInput,
  ClaudeRuntimeTurnResult,
  ClaudeRuntimeEvent
> {
  private activeChild: ChildProcess | null = null;
  private preparedMcpConfig: ClaudeMcpCompositionResult | null = null;
  private hostMcpServer: ClaudeMcpHttpServer | null = null;
  private preparedSession: PreparedClaudeSession | null = null;
  private readonly eventHandlers = new Set<
    AgentRuntimeEventHandler<ClaudeRuntimeEvent>
  >();
  private readonly pendingEvents: ClaudeRuntimeEvent[] = [];
  private readonly sessionStore: ClaudeSessionStore;

  constructor(
    private readonly config: ClaudeRuntimeConfig,
    private readonly dependencies: ClaudeRuntimeDependencies = {}
  ) {
    this.sessionStore = new ClaudeSessionStore({
      runtimeRoot:
        config.runtimeRoot ??
        join(config.workingDirectory, ".runtime", "orchestrator"),
    });
  }

  async prepare(context: ClaudeRuntimePrepareContext): Promise<void> {
    await this.cleanupPreparedMcpConfig();
    this.pendingEvents.length = 0;
    await this.prepareChildHome();
    this.preparedSession = await this.prepareSession(context);
    if (this.config.hostMcpContext) {
      this.hostMcpServer = await startClaudeMcpHttpServer({
        env: this.config.env ?? {},
        context: this.config.hostMcpContext,
        onEvent: (event) => {
          process.stderr.write(`[runtime-claude] host MCP server ${event}\n`);
        },
      });
    }
    this.preparedMcpConfig = await composeClaudeMcpConfig(
      this.config.workingDirectory,
      this.config.isolation?.strictMcpConfig === true,
      buildClaudeMcpTokenEnvironment({
        inheritProcessEnv: this.config.inheritProcessEnv === true,
        configEnv: this.config.env,
        runtimeDirectory: this.config.runtimeDirectory,
        hostMcpUrl: this.hostMcpServer?.url,
        hostMcpSessionToken: this.hostMcpServer?.sessionToken,
      })
    );
    if (this.preparedMcpConfig.excludedServerNames?.length) {
      process.stderr.write(
        `[runtime-claude] ignored child MCP declarations: ${this.preparedMcpConfig.excludedServerNames.join(", ")}; only the worker-owned loopback Streamable HTTP endpoint is exposed\n`
      );
    }
  }

  async spawnTurn(
    input: ClaudeRuntimeTurnInput
  ): Promise<ClaudeRuntimeTurnResult> {
    if (this.activeChild) {
      throw new Error(
        "TODO(#8): Claude print runtime adapter supports only one in-flight turn."
      );
    }

    const session = input.session ?? this.preparedSession?.session;
    const argv = buildClaudePrintArgv(this.buildArgvOptions(input, session));

    try {
      const result = await this.spawnWithArgv(input, argv);

      if (this.shouldInvalidatePreparedResume(session, result)) {
        return await this.retryWithFreshSession(input, result);
      }

      await this.persistStartedSessionId(result);
      await this.persistForkedSessionId(result);

      return result;
    } finally {
      this.activeChild = null;
    }
  }

  onEvent(
    handler: AgentRuntimeEventHandler<ClaudeRuntimeEvent>
  ): AgentRuntimeEventSubscription {
    this.eventHandlers.add(handler);
    // Pending events are scoped to the current prepare cycle and intentionally
    // replayed to each later subscriber. Live events after subscription are not
    // replayed to handlers registered later.
    for (const event of this.pendingEvents) {
      handler(event);
    }
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  resolveCredentials(
    brokerResponse: AgentRuntimeCredentialBrokerResponse
  ): AgentRuntimeEnv {
    return extractEnvForClaude(brokerResponse.env, this.config.authEnvKey);
  }

  async shutdown(): Promise<void> {
    this.stopActiveChild();
    await this.cleanupPreparedMcpConfig();
  }

  async cancel(_reason?: string): Promise<void> {
    // TODO(#8,#9): replace direct process termination with session-aware
    // cancellation once Claude runtime turn orchestration is wired end-to-end.
    this.stopActiveChild();
    await this.cleanupPreparedMcpConfig();
  }

  private buildArgvOptions(
    input: ClaudeRuntimeTurnInput,
    session: ClaudeRuntimeSessionOptions | undefined
  ): ClaudePrintArgvOptions {
    const isolation = {
      ...this.config.isolation,
      ...input.isolation,
    };
    const configuredExtraArgs = input.extraArgs ?? this.config.extraArgs ?? [];

    if (this.preparedMcpConfig) {
      return {
        baseArgs: this.config.args,
        session,
        // prepare() owns MCP argv injection through extraArgv; suppress the
        // isolation flag here so buildClaudePrintArgv does not add it twice.
        // Any input mcpConfigPath is intentionally ignored while a prepared
        // composition result is active.
        isolation: {
          ...isolation,
          strictMcpConfig: false,
          mcpConfigPath: undefined,
        },
        extraArgs: [
          ...this.preparedMcpConfig.extraArgv,
          ...configuredExtraArgs,
        ],
      };
    }

    if (isolation.strictMcpConfig && !isolation.mcpConfigPath) {
      throw new Error(
        "Claude strict MCP config requires prepare() or an explicit mcpConfigPath."
      );
    }

    return {
      baseArgs: this.config.args,
      session,
      isolation,
      extraArgs: configuredExtraArgs,
    };
  }

  private async prepareSession(
    context: ClaudeRuntimePrepareContext
  ): Promise<PreparedClaudeSession> {
    const currentOptions = {
      runId: context.runId,
      runDirectory: context.runDirectory,
    };
    const parentRunId = context.previousRunId;

    try {
      const current = await this.sessionStore.load(currentOptions);
      if (current) {
        return {
          runId: context.runId,
          runDirectory: context.runDirectory,
          sessionFile: current,
          session: {
            mode: "resume",
            sessionId: current.sessionId,
          },
        };
      }
    } catch (error) {
      return await this.createFreshSession(context, {
        reason: `session file could not be read or parsed: ${formatErrorMessage(error)}`,
        invalidatedSessionId: "unknown",
        parentRunId,
      });
    }

    if (context.previousRunId) {
      try {
        const previous = await this.sessionStore.load({
          runId: context.previousRunId,
          runDirectory: context.previousRunDirectory,
        });
        if (previous) {
          const sessionFile = await this.sessionStore.save({
            ...currentOptions,
            sessionId: previous.sessionId,
            createdAt: this.nowIso(),
            parentRunId: context.previousRunId,
          });
          return {
            runId: context.runId,
            runDirectory: context.runDirectory,
            sessionFile,
            session: {
              mode: "resume",
              sessionId: previous.sessionId,
              forkSession: true,
            },
          };
        }
      } catch (error) {
        return await this.createFreshSession(context, {
          reason: `parent session file could not be read or parsed: ${formatErrorMessage(error)}`,
          invalidatedSessionId: "unknown",
          parentRunId,
        });
      }
    }

    return await this.createFreshSession(context, { parentRunId });
  }

  private async createFreshSession(
    context: ClaudeRuntimePrepareContext,
    options: {
      reason?: string;
      invalidatedSessionId?: string;
      parentRunId?: string;
    } = {}
  ): Promise<PreparedClaudeSession> {
    const replacementSessionId = this.createSessionId();
    const sessionFile = await this.sessionStore.save({
      runId: context.runId,
      runDirectory: context.runDirectory,
      sessionId: replacementSessionId,
      createdAt: this.nowIso(),
      parentRunId: options.parentRunId,
    });

    if (options.reason) {
      this.emitSessionInvalidated({
        runId: context.runId,
        sessionId: options.invalidatedSessionId ?? "unknown",
        replacementSessionId,
        reason: options.reason,
      });
    }

    return {
      runId: context.runId,
      runDirectory: context.runDirectory,
      sessionFile,
      session: {
        mode: "start",
        sessionId: replacementSessionId,
      },
    };
  }

  private async retryWithFreshSession(
    input: ClaudeRuntimeTurnInput,
    failedResult: ClaudeSpawnTurnResult
  ): Promise<ClaudeSpawnTurnResult> {
    if (!this.preparedSession) {
      // Unreachable from shouldInvalidatePreparedResume(); keep the original
      // failed result if this method is called defensively in the future.
      return failedResult;
    }

    const invalidatedSessionId = this.preparedSession.session.sessionId;
    const replacementSessionId = this.createSessionId();
    const parentRunId = this.preparedSession.sessionFile.parentRunId;
    const sessionFile = await this.sessionStore.save({
      runId: this.preparedSession.runId,
      runDirectory: this.preparedSession.runDirectory,
      sessionId: replacementSessionId,
      createdAt: this.nowIso(),
      parentRunId,
    });
    this.preparedSession = {
      ...this.preparedSession,
      sessionFile,
      session: {
        mode: "start",
        sessionId: replacementSessionId,
      },
    };
    this.emitSessionInvalidated({
      runId: this.preparedSession.runId,
      sessionId: invalidatedSessionId,
      replacementSessionId,
      reason:
        "claude resume session was rejected because no conversation was found",
    });

    const retryArgv = buildClaudePrintArgv(
      this.buildArgvOptions(input, this.preparedSession.session)
    );
    const retryResult = await this.spawnWithArgv(input, retryArgv);
    await this.persistStartedSessionId(retryResult);
    return retryResult;
  }

  private async spawnWithArgv(
    input: ClaudeRuntimeTurnInput,
    argv: string[]
  ): Promise<ClaudeSpawnTurnResult> {
    const childHome = this.resolveChildHome();
    return await spawnClaudeTurn(
      {
        command: input.command ?? this.config.command,
        args: argv,
        cwd: input.cwd ?? this.config.workingDirectory,
        env: buildClaudeSpawnEnv({
          workingDirectory: this.config.workingDirectory,
          inheritProcessEnv: this.config.inheritProcessEnv === true,
          configEnv: this.config.env,
          inputEnv: input.env,
          childHome,
        }),
        stdinMessages: input.messages,
        // Claude startup includes CLI initialization, MCP connections, and
        // first-token latency. The runtime stall budget is the compatible
        // bound for that initial silence rather than Codex's RPC read budget.
        initialOutputTimeoutMs: this.config.stallTimeoutMs,
        turnTimeoutMs: this.config.turnTimeoutMs,
      },
      {
        ...this.dependencies,
        onSpawned: (child) => {
          this.activeChild = child;
          this.dependencies.onSpawned?.(child);
        },
        onEvent: (event) => {
          this.emitEvent(event);
          try {
            this.dependencies.onEvent?.(event);
          } catch {
            // Dependency hook failures must not block stream processing.
          }
        },
      }
    );
  }

  private resolveChildHome(): string {
    return resolveAgentChildHome({
      workingDirectory: this.config.workingDirectory,
      runtimeDirectory: this.config.runtimeDirectory ?? this.config.runtimeRoot,
    });
  }

  private async prepareChildHome(): Promise<void> {
    const childHome = this.resolveChildHome();
    await prepareAgentChildHome(childHome);
    const hostHome = this.config.env?.HOME ?? process.env.HOME ?? homedir();
    await stageGitUserIdentity({
      sourceHome: hostHome,
      destination: join(childHome, ".gitconfig"),
    });
    if (
      this.config.isolation?.bare === true ||
      this.config.env?.ANTHROPIC_API_KEY
    ) {
      return;
    }

    await stageJsonCredentialFile({
      source: join(hostHome, ".claude", ".credentials.json"),
      destination: join(childHome, ".claude", ".credentials.json"),
      allowedKeys: ["claudeAiOauth"],
    });
  }

  private async persistForkedSessionId(
    result: ClaudeSpawnTurnResult
  ): Promise<void> {
    if (
      this.preparedSession?.session.mode !== "resume" ||
      !this.preparedSession.session.forkSession
    ) {
      return;
    }

    const forkedSessionId = findSessionIdInResult(result);
    const sessionId = forkedSessionId ?? this.preparedSession.session.sessionId;

    this.preparedSession = {
      ...this.preparedSession,
      sessionFile: await this.sessionStore.save({
        runId: this.preparedSession.runId,
        runDirectory: this.preparedSession.runDirectory,
        sessionId,
        createdAt: this.preparedSession.sessionFile.createdAt,
        parentRunId: this.preparedSession.sessionFile.parentRunId,
        protocolState: this.preparedSession.sessionFile.protocolState,
      }),
      session: {
        mode: "resume",
        sessionId,
      },
    };
  }

  private async persistStartedSessionId(
    result: ClaudeSpawnTurnResult
  ): Promise<void> {
    if (this.preparedSession?.session.mode !== "start") {
      return;
    }
    if (result.result !== "success") {
      return;
    }

    const sessionId =
      findSessionIdInResult(result) ?? this.preparedSession.session.sessionId;
    this.preparedSession = {
      ...this.preparedSession,
      sessionFile: await this.sessionStore.save({
        runId: this.preparedSession.runId,
        runDirectory: this.preparedSession.runDirectory,
        sessionId,
        createdAt: this.preparedSession.sessionFile.createdAt,
        parentRunId: this.preparedSession.sessionFile.parentRunId,
        protocolState: this.preparedSession.sessionFile.protocolState,
      }),
      session: {
        mode: "resume",
        sessionId,
      },
    };
  }

  private shouldInvalidatePreparedResume(
    session: ClaudeRuntimeSessionOptions | undefined,
    result: ClaudeSpawnTurnResult
  ): boolean {
    // Only sessions selected by prepare() are persisted and eligible for
    // automatic invalidation. Explicit input.session callers own their retry
    // policy, so reference equality is the boundary between the two paths.
    return (
      session === this.preparedSession?.session &&
      session?.mode === "resume" &&
      isResumeRejected(session, result)
    );
  }

  private emitSessionInvalidated(payload: {
    runId: string;
    sessionId: string;
    replacementSessionId: string;
    reason: string;
  }): void {
    const event: AgentSessionInvalidatedEvent = {
      name: "agent.sessionInvalidated",
      payload: {
        params: {},
        ...payload,
        observabilityEvent: "session_invalidated",
      },
    };
    if (this.eventHandlers.size === 0) {
      this.pendingEvents.push(event);
    } else {
      for (const handler of this.eventHandlers) {
        handler(event);
      }
    }
  }

  private createSessionId(): string {
    return this.dependencies.createSessionId?.() ?? randomUUID();
  }

  private nowIso(): string {
    return (this.dependencies.now?.() ?? new Date()).toISOString();
  }

  private stopActiveChild(): void {
    if (!this.activeChild || this.activeChild.killed) {
      this.activeChild = null;
      return;
    }

    this.activeChild.kill("SIGTERM");
    this.activeChild = null;
  }

  private async cleanupPreparedMcpConfig(): Promise<void> {
    const cleanupPath = this.preparedMcpConfig?.cleanupPath;
    this.preparedMcpConfig = null;
    const server = this.hostMcpServer;
    this.hostMcpServer = null;

    if (server) {
      await server.close();
    }

    if (!cleanupPath) {
      return;
    }

    await rm(cleanupPath, { force: true });
  }

  private emitEvent(event: ClaudeRuntimeEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Event subscriber failures must not block later subscribers or turns.
      }
    }
  }
}

export function createClaudePrintRuntimeAdapter(
  config: ClaudeRuntimeConfig,
  dependencies: ClaudeRuntimeDependencies = {}
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
  workingDirectory: string;
  inheritProcessEnv: boolean;
  configEnv?: NodeJS.ProcessEnv;
  inputEnv?: NodeJS.ProcessEnv;
  childHome: string;
}): NodeJS.ProcessEnv {
  if (options.inheritProcessEnv) {
    const env = {
      ...process.env,
      ...options.configEnv,
      ...options.inputEnv,
    };
    stripTrackerSecrets(env, options.workingDirectory, options.configEnv);
    env.HOME = options.childHome;
    env.GH_CONFIG_DIR = join(options.childHome, "gh");
    removeChildHostCredentialEnvironment(env);
    return env;
  }

  const env: NodeJS.ProcessEnv = {};

  for (const key of DEFAULT_INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  Object.assign(env, options.configEnv, options.inputEnv);
  stripTrackerSecrets(env, options.workingDirectory, options.configEnv);
  env.HOME = options.childHome;
  env.GH_CONFIG_DIR = join(options.childHome, "gh");
  removeChildHostCredentialEnvironment(env);

  return env;
}

function stripTrackerSecrets(
  env: NodeJS.ProcessEnv,
  workingDirectory: string,
  configEnv?: NodeJS.ProcessEnv
): void {
  const declaredNames = readTrackerSecretEnvironmentNames(env);
  for (const name of [
    ...declaredNames,
    ...collectMcpSecretEnvironmentNames({
      repositoryDir: workingDirectory,
      projectDir: configEnv?.SYMPHONY_PROJECT_DIR,
      trustRepoConfig: configEnv?.SYMPHONY_TRUST_REPO_CONFIG === "true",
      secretEnvironmentNames: declaredNames,
    }),
    "GH_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_GRAPHQL_TOKEN",
    "GITHUB_TOKEN_BROKER_SECRET",
    "LINEAR_API_KEY",
    "LINEAR_AUTHORIZATION",
  ]) {
    delete env[name];
  }
}

function removeChildHostCredentialEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of [
    "AGENT_CREDENTIAL_BROKER_URL",
    "AGENT_CREDENTIAL_BROKER_SECRET",
    "AGENT_CREDENTIAL_CACHE_PATH",
    "GITHUB_GIT_HOST",
    "GITHUB_GIT_USERNAME",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GITHUB_TOKEN_BROKER_URL",
    "GITHUB_TOKEN_CACHE_PATH",
    "GIT_ASKPASS",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_SYSTEM",
    "GIT_DIR",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_WORK_TREE",
    "SSH_AGENT_PID",
    "SSH_ASKPASS",
    "SSH_AUTH_SOCK",
    "XDG_CONFIG_HOME",
  ]) {
    delete env[name];
  }
  for (const name of Object.keys(env)) {
    if (
      name.startsWith("GIT_CONFIG_KEY_") ||
      name.startsWith("GIT_CONFIG_VALUE_")
    ) {
      delete env[name];
    }
  }
  env.GIT_TERMINAL_PROMPT = "0";
}

type PreparedClaudeSession = {
  runId: string;
  runDirectory?: string;
  sessionFile: ClaudeSessionFile;
  session: ClaudeRuntimeSessionOptions;
};

function findSessionIdInResult(result: ClaudeSpawnTurnResult): string | null {
  for (const record of result.records) {
    const sessionId = findSessionId(record.message);
    if (sessionId) {
      return sessionId;
    }
  }
  return null;
}

// Claude print result records are expected to carry sessionId/session_id near
// the top-level result object. The depth guard keeps malformed records bounded
// without treating arbitrary nested metadata as authoritative session state.
function findSessionId(value: unknown, depth = 0): string | null {
  if (depth > 5) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId === "string") {
    return record.sessionId;
  }
  if (typeof record.session_id === "string") {
    return record.session_id;
  }
  for (const nested of Object.values(record)) {
    const sessionId = findSessionId(nested, depth + 1);
    if (sessionId) {
      return sessionId;
    }
  }
  return null;
}

function isResumeRejected(
  session: ClaudeRuntimeSessionOptions,
  result: ClaudeSpawnTurnResult
): boolean {
  if (result.result !== "process-error") {
    return false;
  }

  // Claude Code 2.1.227 emits a terminal stream-json result for a missing
  // resume session: `{ subtype: "error_during_execution", is_error: true,
  // session_id, errors }`. Use that protocol record rather than duplicating the
  // human-readable stderr diagnostic. `errors` identifies this as a rejected
  // session instead of another process error that happens after --resume.
  return result.records.some((record) => {
    const message = record.message;
    const errors = message?.errors;
    return (
      message?.type === "result" &&
      message.subtype === "error_during_execution" &&
      message.is_error === true &&
      message.session_id === session.sessionId &&
      Array.isArray(errors) &&
      errors.some(
        (error) =>
          typeof error === "string" &&
          error.startsWith("No conversation found with session ID:")
      )
    );
  });
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function buildClaudeMcpTokenEnvironment(options: {
  inheritProcessEnv: boolean;
  configEnv?: NodeJS.ProcessEnv;
  runtimeDirectory?: string;
  hostMcpUrl?: string;
  hostMcpSessionToken?: string;
}): ClaudeMcpTokenEnvironment {
  const source = options.inheritProcessEnv
    ? {
        ...process.env,
        ...options.configEnv,
      }
    : {
        ...options.configEnv,
      };

  return {
    ...(source.GITHUB_TOKEN_BROKER_URL && source.GITHUB_TOKEN_BROKER_SECRET
      ? {}
      : { GITHUB_GRAPHQL_TOKEN: source.GITHUB_GRAPHQL_TOKEN }),
    GITHUB_GRAPHQL_API_URL: source.GITHUB_GRAPHQL_API_URL,
    GITHUB_TOKEN_BROKER_URL: source.GITHUB_TOKEN_BROKER_URL,
    GITHUB_TOKEN_BROKER_SECRET: source.GITHUB_TOKEN_BROKER_SECRET,
    GITHUB_TOKEN_CACHE_PATH: source.GITHUB_TOKEN_CACHE_PATH,
    GITHUB_PROJECT_ID: source.GITHUB_PROJECT_ID,
    LINEAR_API_KEY: source.LINEAR_API_KEY,
    LINEAR_AUTHORIZATION: source.LINEAR_AUTHORIZATION,
    LINEAR_GRAPHQL_URL: source.LINEAR_GRAPHQL_URL,
    SYMPHONY_TRACKER_KIND: source.SYMPHONY_TRACKER_KIND,
    SYMPHONY_PROJECT_DIR: source.SYMPHONY_PROJECT_DIR,
    SYMPHONY_TRUST_REPO_CONFIG: source.SYMPHONY_TRUST_REPO_CONFIG,
    SYMPHONY_TRACKER_SECRET_ENVIRONMENT_NAMES:
      source.SYMPHONY_TRACKER_SECRET_ENVIRONMENT_NAMES,
    WORKSPACE_RUNTIME_DIR:
      options.runtimeDirectory ?? source.WORKSPACE_RUNTIME_DIR,
    SYMPHONY_CLAUDE_MCP_URL: options.hostMcpUrl,
    SYMPHONY_CLAUDE_MCP_SESSION_TOKEN: options.hostMcpSessionToken,
  };
}

function readTrackerSecretEnvironmentNames(env: NodeJS.ProcessEnv): string[] {
  try {
    const names = JSON.parse(
      env.SYMPHONY_TRACKER_SECRET_ENVIRONMENT_NAMES ?? "[]"
    );
    return Array.isArray(names)
      ? names.filter((name): name is string => typeof name === "string")
      : [];
  } catch {
    return [];
  }
}
