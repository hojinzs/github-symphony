import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AgentSessionInvalidatedEvent,
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
import {
  ClaudeSessionStore,
  type ClaudeSessionFile,
} from "./session-store.js";

export type ClaudeRuntimeConfig = {
  workingDirectory: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: readonly string[];
  isolation?: ClaudeRuntimeIsolationOptions;
  inheritProcessEnv?: boolean;
  runtimeRoot?: string;
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

export type ClaudeRuntimeEvent = AgentRuntimeEvent | AgentSessionInvalidatedEvent;

export type ClaudeRuntimeDependencies = ClaudeSpawnDependencies & {
  createSessionId?: () => string;
  now?: () => Date;
};

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
  private activeChild: ChildProcess | null = null;
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
    this.preparedSession = await this.prepareSession(context);
  }

  async spawnTurn(input: ClaudeRuntimeTurnInput): Promise<ClaudeRuntimeTurnResult> {
    if (this.activeChild) {
      throw new Error(
        "TODO(#8): Claude print runtime adapter supports only one in-flight turn."
      );
    }

    const session = input.session ?? this.preparedSession?.session;
    const argv = buildClaudePrintArgv(this.buildArgvOptions(input, session));

    try {
      const result = await this.spawnWithArgv(input, argv);
      await this.persistStartedSessionId(result);
      await this.persistForkedSessionId(result);

      if (this.shouldInvalidatePreparedResume(session, result)) {
        return await this.retryWithFreshSession(input, result);
      }

      return result;
    } finally {
      this.activeChild = null;
    }
  }

  onEvent(
    handler: AgentRuntimeEventHandler<ClaudeRuntimeEvent>
  ): AgentRuntimeEventSubscription {
    this.eventHandlers.add(handler);
    for (const event of this.pendingEvents.splice(0)) {
      handler(event);
    }
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  resolveCredentials(
    brokerResponse: AgentRuntimeCredentialBrokerResponse
  ): AgentRuntimeEnv {
    return extractEnvForClaude(brokerResponse.env);
  }

  shutdown(): void {
    this.stopActiveChild();
  }

  cancel(_reason?: string): void {
    // TODO(#8,#9): replace direct process termination with session-aware
    // cancellation once Claude runtime turn orchestration is wired end-to-end.
    this.stopActiveChild();
  }

  private buildArgvOptions(
    input: ClaudeRuntimeTurnInput,
    session: ClaudeRuntimeSessionOptions | undefined
  ): ClaudePrintArgvOptions {
    return {
      session,
      isolation: {
        ...this.config.isolation,
        ...input.isolation,
      },
      extraArgs: input.extraArgs ?? this.config.extraArgs,
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
    } catch {
      return await this.createFreshSession(context, {
        reason: "session file could not be read",
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
      } catch {
        return await this.createFreshSession(context, {
          reason: "parent session file could not be read",
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
      return failedResult;
    }

    const invalidatedSessionId = this.preparedSession.session.sessionId;
    const replacementSessionId = this.createSessionId();
    const parentRunId = this.preparedSession.sessionFile.parentRunId;
    const sessionFile = await this.sessionStore.invalidate({
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
      reason: "claude resume session was rejected with a 4xx response",
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
    return await spawnClaudeTurn(
      {
        command: input.command ?? this.config.command,
        args: argv,
        cwd: input.cwd ?? this.config.workingDirectory,
        env: buildClaudeSpawnEnv({
          inheritProcessEnv: this.config.inheritProcessEnv === true,
          configEnv: this.config.env,
          inputEnv: input.env,
        }),
        stdinMessages: input.messages,
      },
      {
        ...this.dependencies,
        onSpawned: (child) => {
          this.activeChild = child;
          this.dependencies.onSpawned?.(child);
        },
      }
    );
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
    if (!forkedSessionId) {
      return;
    }

    this.preparedSession = {
      ...this.preparedSession,
      sessionFile: await this.sessionStore.save({
        runId: this.preparedSession.runId,
        runDirectory: this.preparedSession.runDirectory,
        sessionId: forkedSessionId,
        createdAt: this.preparedSession.sessionFile.createdAt,
        parentRunId: this.preparedSession.sessionFile.parentRunId,
        protocolState: this.preparedSession.sessionFile.protocolState,
      }),
      session: {
        mode: "resume",
        sessionId: forkedSessionId,
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
    return (
      session === this.preparedSession?.session &&
      session?.mode === "resume" &&
      isResumeRejectedWith4xx(result)
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
      return;
    }
    for (const handler of this.eventHandlers) {
      handler(event);
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
}

export function createClaudePrintRuntimeAdapter(
  config: ClaudeRuntimeConfig,
  dependencies: ClaudeRuntimeDependencies = {}
): ClaudePrintRuntimeAdapter {
  return new ClaudePrintRuntimeAdapter(config, dependencies);
}

export function resolveClaudeCredentials(
  brokerResponse: AgentRuntimeCredentialBrokerResponse
): AgentRuntimeEnv {
  return extractEnvForClaude(brokerResponse.env);
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
  inheritProcessEnv: boolean;
  configEnv?: NodeJS.ProcessEnv;
  inputEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  if (options.inheritProcessEnv) {
    return {
      ...process.env,
      ...options.configEnv,
      ...options.inputEnv,
    };
  }

  const env: NodeJS.ProcessEnv = {};

  for (const key of DEFAULT_INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }

  Object.assign(env, options.configEnv, options.inputEnv);

  return env;
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

function findSessionId(value: unknown): string | null {
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
    const sessionId = findSessionId(nested);
    if (sessionId) {
      return sessionId;
    }
  }
  return null;
}

function isResumeRejectedWith4xx(result: ClaudeSpawnTurnResult): boolean {
  if (result.result !== "process-error") {
    return false;
  }
  if (
    typeof result.exitCode === "number" &&
    result.exitCode >= 400 &&
    result.exitCode < 500
  ) {
    return true;
  }

  return result.records.some((record) => {
    const text = record.line.toLowerCase();
    return (
      text.includes("resume") &&
      /\b4\d\d\b/.test(text)
    );
  });
}
