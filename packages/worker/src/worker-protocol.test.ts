/**
 * Worker protocol tests — validates the multi-turn, timeout, and user-input-required
 * logic implemented in the codex client protocol (packages/worker/src/index.ts).
 *
 * Because the protocol functions (runCodexClientProtocol, sendRequestWithTimeout,
 * waitForTurnWithTimeout, handleServerMessage, refreshTrackerState) are NOT exported
 * from index.ts, and the module has heavy top-level side effects (starts servers,
 * spawns processes), we replicate the exact protocol logic here and test it directly.
 *
 * This approach verifies the correctness of the protocol patterns without requiring
 * complex module mocking of @gh-symphony/runtime-codex dependencies.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolveCodexPolicySettings } from "./codex-policy.js";

// ---------------------------------------------------------------------------
// Protocol primitives — replicated exactly from packages/worker/src/index.ts
// ---------------------------------------------------------------------------

type PendingRequest = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

/**
 * Minimal fake child process for testing: provides stdin/stdout/stderr streams
 * and basic process lifecycle (pid, kill, exit events).
 */
function createFakeChild(): {
  child: ChildProcessWithoutNullStreams;
  stdout: PassThrough;
  stdin: PassThrough;
  emitExit: (code: number | null, signal: string | null) => void;
  killed: boolean;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  let killed = false;

  const child = {
    pid: 12345,
    stdin,
    stdout,
    stderr,
    once: emitter.once.bind(emitter),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    kill: () => {
      killed = true;
    },
  } as unknown as ChildProcessWithoutNullStreams;

  return {
    child,
    stdout,
    stdin,
    emitExit: (code, signal) => emitter.emit("exit", code, signal),
    get killed() {
      return killed;
    },
  };
}

/**
 * Creates a protocol context matching the pattern from index.ts,
 * wired to a fake child process for testing.
 */
function createProtocolContext(options: {
  readTimeoutMs?: number;
  turnTimeoutMs?: number;
  maxTurns?: number;
  orchestratorChannelWriter?: {
    write: (chunk: string) => boolean;
    once: (event: "drain", listener: () => void) => unknown;
    on?: (event: "drain", listener: () => void) => unknown;
    removeListener?: (event: "drain", listener: () => void) => unknown;
  };
}) {
  const {
    readTimeoutMs = 5000,
    turnTimeoutMs = 3600000,
    maxTurns = 20,
    orchestratorChannelWriter,
  } = options;
  const fake = createFakeChild();

  const pendingRequests = new Map<string, PendingRequest>();
  let turnCompletedResolve: (() => void) | null = null;
  let userInputRequired = false;
  let killCalled = false;
  let turnTerminalFailure:
    | {
        runPhase: "failed" | "canceled_by_reconciliation";
        lastError: string | null;
      }
    | null = null;
  const logs: string[] = [];
  const orchestratorEvents: Array<Record<string, unknown>> = [];
  let orchestratorChannelDrainPending = false;
  let pendingOrchestratorChannelPayload: string | null = null;

  const defaultOrchestratorChannelWriter = {
    write(chunk: string): boolean {
      orchestratorEvents.push(JSON.parse(chunk) as Record<string, unknown>);
      return true;
    },
    once(_event: "drain", _listener: () => void): void {
      // No-op for the default sink because writes are always immediate.
    },
    on(_event: "drain", _listener: () => void): void {
      // No-op for the default sink because writes are always immediate.
    },
    removeListener(_event: "drain", _listener: () => void): void {
      // No-op for the default sink because writes are always immediate.
    },
  };
  const channelWriter =
    orchestratorChannelWriter ?? defaultOrchestratorChannelWriter;

  const runtimeState = {
    status: "running" as string,
    runPhase: "streaming_turn" as string,
    run: {
      issueId: "issue-1",
      lastError: null as string | null,
    },
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    lastEventAt: null as string | null,
    rateLimits: null as Record<string, unknown> | null,
  };

  function applyTokenUsageUpdate(
    source: string,
    tokenUsage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }
  ): void {
    runtimeState.tokenUsage.inputTokens = tokenUsage.inputTokens;
    runtimeState.tokenUsage.outputTokens = tokenUsage.outputTokens;
    runtimeState.tokenUsage.totalTokens = tokenUsage.totalTokens;
    logs.push(
      `[worker] token_usage source=${source} input=${tokenUsage.inputTokens} output=${tokenUsage.outputTokens} total=${tokenUsage.totalTokens}`
    );
  }

  function applyRateLimitUpdate(
    source: string,
    rateLimits: Record<string, unknown>
  ): void {
    runtimeState.rateLimits = {
      ...rateLimits,
      source: "codex",
    };
    logs.push(
      `[worker] rate_limits source=${source} payload=${JSON.stringify(runtimeState.rateLimits)}`
    );
  }

  function emitOrchestratorChannelEvent(event?: string): void {
    if (!runtimeState.run.issueId || !runtimeState.lastEventAt) {
      return;
    }

    const payload: Record<string, unknown> = {
      type: "codex_update",
      issueId: runtimeState.run.issueId,
      lastEventAt: runtimeState.lastEventAt,
      tokenUsage: { ...runtimeState.tokenUsage },
    };

    if (runtimeState.rateLimits) {
      payload.rateLimits = { ...runtimeState.rateLimits };
    }
    if (event) {
      payload.event = event;
    }

    function flushPendingOrchestratorChannelEvent(): void {
      if (!pendingOrchestratorChannelPayload) {
        orchestratorChannelDrainPending = false;
        return;
      }

      const pendingPayload = pendingOrchestratorChannelPayload;
      pendingOrchestratorChannelPayload = null;
      const pendingWriteSucceeded = channelWriter.write(pendingPayload);
      if (pendingWriteSucceeded) {
        orchestratorChannelDrainPending = false;
        return;
      }

      pendingOrchestratorChannelPayload = pendingPayload;
      orchestratorChannelDrainPending = true;
      channelWriter.once("drain", flushPendingOrchestratorChannelEvent);
    }

    const serializedPayload = `${JSON.stringify(payload)}\n`;
    if (orchestratorChannelDrainPending) {
      pendingOrchestratorChannelPayload = serializedPayload;
      return;
    }

    const wrote = channelWriter.write(serializedPayload);
    if (!wrote) {
      orchestratorChannelDrainPending = true;
      channelWriter.once("drain", flushPendingOrchestratorChannelEvent);
    }
  }

  function waitForPendingOrchestratorChannelFlush(
    timeoutMs = 250
  ): Promise<void> {
    if (!orchestratorChannelDrainPending && !pendingOrchestratorChannelPayload) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        settled = true;
        channelWriter.removeListener?.("drain", handleDrain);
        timeout = null;
        resolve();
      }, timeoutMs);

      const handleDrain = () => {
        if (
          orchestratorChannelDrainPending ||
          pendingOrchestratorChannelPayload
        ) {
          return;
        }
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
        channelWriter.removeListener?.("drain", handleDrain);
        resolve();
      };

      channelWriter.on?.("drain", handleDrain);
    });
  }

  function extractRateLimitPayload(
    value: unknown
  ): Record<string, unknown> | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const direct = parseRateLimitRecord(value);
    if (direct) {
      return direct;
    }

    const record = value as Record<string, unknown>;
    const preferredKeys = [
      "rate_limits",
      "rateLimits",
      "rate_limit",
      "rateLimit",
      "info",
      "msg",
      "event",
      "data",
      "result",
      "payload",
    ];

    for (const key of preferredKeys) {
      if (key in record) {
        const nested = extractRateLimitPayload(record[key]);
        if (nested) {
          return nested;
        }
      }
    }

    for (const nestedValue of Object.values(record)) {
      const nested = extractRateLimitPayload(nestedValue);
      if (nested) {
        return nested;
      }
    }

    return null;
  }

  function parseRateLimitRecord(
    value: unknown
  ): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const directKeys = new Set([
      "limit",
      "remaining",
      "used",
      "reset",
      "resetAt",
      "resets_at",
      "reset_at",
      "window_minutes",
      "resource",
      "retry_after",
    ]);

    if (!keys.some((key) => directKeys.has(key))) {
      return null;
    }

    return { ...record };
  }

  function extractAbsoluteTokenUsage(
    value: unknown
  ):
    | {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      }
    | null {
    const direct = parseTokenUsageSnapshot(value);
    if (direct) {
      return direct;
    }

    if (!value || typeof value !== "object") {
      return null;
    }

    const record = value as Record<string, unknown>;
    const preferredKeys = [
      "total_token_usage",
      "token_usage",
      "info",
      "msg",
      "event",
      "data",
      "result",
      "payload",
    ];

    for (const key of preferredKeys) {
      if (key in record) {
        const nested = extractAbsoluteTokenUsage(record[key]);
        if (nested) {
          return nested;
        }
      }
    }

    for (const [key, nestedValue] of Object.entries(record)) {
      if (key === "last_token_usage") {
        continue;
      }
      const nested = extractAbsoluteTokenUsage(nestedValue);
      if (nested) {
        return nested;
      }
    }

    return null;
  }

  function parseTokenUsageSnapshot(
    value: unknown
  ):
    | {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      }
    | null {
    if (!value || typeof value !== "object") {
      return null;
    }

    const record = value as Record<string, unknown>;
    const inputTokens =
      typeof record.input_tokens === "number"
        ? record.input_tokens
        : typeof record.inputTokens === "number"
          ? record.inputTokens
          : null;
    const outputTokens =
      typeof record.output_tokens === "number"
        ? record.output_tokens
        : typeof record.outputTokens === "number"
          ? record.outputTokens
          : null;
    const explicitTotalTokens =
      typeof record.total_tokens === "number"
        ? record.total_tokens
        : typeof record.totalTokens === "number"
          ? record.totalTokens
          : null;

    if (
      inputTokens === null &&
      outputTokens === null &&
      explicitTotalTokens === null
    ) {
      return null;
    }

    const normalizedInputTokens = inputTokens ?? 0;
    const normalizedOutputTokens = outputTokens ?? 0;
    const normalizedTotalTokens =
      explicitTotalTokens ?? normalizedInputTokens + normalizedOutputTokens;

    if (
      normalizedInputTokens <= 0 &&
      normalizedOutputTokens <= 0 &&
      normalizedTotalTokens <= 0
    ) {
      return null;
    }

    return {
      inputTokens: normalizedInputTokens,
      outputTokens: normalizedOutputTokens,
      totalTokens:
        normalizedTotalTokens ||
        normalizedInputTokens + normalizedOutputTokens,
    };
  }

  function sendMessage(msg: Record<string, unknown>): void {
    const line = JSON.stringify(msg) + "\n";
    fake.stdin.write(line);
  }

  function sendRequest(
    id: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      sendMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  function sendRequestWithTimeout(
    id: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(
          new Error(
            `response_timeout: ${method} timed out after ${readTimeoutMs}ms`
          )
        );
      }, readTimeoutMs);

      sendRequest(id, method, params).then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  function waitForTurnCompletion(): Promise<void> {
    return new Promise((resolve) => {
      turnCompletedResolve = resolve;
    });
  }

  function waitForTurnWithTimeout(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        killCalled = true;
        reject(new Error("turn_timeout: turn exceeded time limit"));
      }, turnTimeoutMs);

      waitForTurnCompletion().then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  function resolvePendingTurnCompletion(): void {
    if (turnCompletedResolve) {
      turnCompletedResolve();
      turnCompletedResolve = null;
    }
  }

  function describeTurnTerminalEvent(
    event: "turn/failed" | "turn/cancelled",
    params: unknown
  ): string | null {
    const fallback =
      event === "turn/failed"
        ? "turn_failed: codex reported turn failure"
        : "turn_cancelled: codex reported turn cancellation";

    if (!params || typeof params !== "object") {
      return fallback;
    }

    const record = params as Record<string, unknown>;
    const directReasonKeys = ["message", "reason", "error"];

    for (const key of directReasonKeys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return `${event.replace("/", "_")}: ${value.trim()}`;
      }
      if (
        value &&
        typeof value === "object" &&
        typeof (value as Record<string, unknown>).message === "string"
      ) {
        const nested = value as Record<string, unknown>;
        const nestedMessage = String(nested.message).trim();
        if (nestedMessage) {
          return `${event.replace("/", "_")}: ${nestedMessage}`;
        }
      }
    }

    const serialized = JSON.stringify(params).slice(0, 300);
    return serialized && serialized !== "{}"
      ? `${event.replace("/", "_")}: ${serialized}`
      : fallback;
  }

  function markTurnTerminalFailure(
    runPhase: "failed" | "canceled_by_reconciliation",
    lastError: string | null
  ): void {
    runtimeState.status = "failed";
    runtimeState.runPhase = runPhase;
    runtimeState.run.lastError = lastError;
    turnTerminalFailure = { runPhase, lastError };
    resolvePendingTurnCompletion();
  }

  function finalizeRunState(): void {
    runtimeState.runPhase = "finishing";
    runtimeState.status =
      userInputRequired || turnTerminalFailure ? "failed" : "completed";
    runtimeState.runPhase = userInputRequired
      ? "failed"
      : turnTerminalFailure?.runPhase ?? "succeeded";
  }

  function applyChildExit(
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    const currentRunPhase = runtimeState.runPhase;
    const terminalPhases = new Set([
      "succeeded",
      "failed",
      "timed_out",
      "stalled",
      "canceled_by_reconciliation",
    ]);
    const nextRunPhase =
      currentRunPhase && terminalPhases.has(currentRunPhase)
        ? currentRunPhase
        : code === 0 && !signal
          ? "succeeded"
          : "failed";
    const preservesTerminalPhase =
      currentRunPhase != null && nextRunPhase === currentRunPhase;

    if (!preservesTerminalPhase) {
      runtimeState.status = code === 0 && !signal ? "completed" : "failed";
    }
    runtimeState.runPhase = nextRunPhase;

    if (!preservesTerminalPhase) {
      runtimeState.run.lastError =
        code === 0 && !signal
          ? null
          : `codex app-server exited with ${signal ?? code ?? "unknown"}`;
    }
  }

  function handleServerMessage(msg: Record<string, unknown>): void {
    // JSON-RPC response to our requests
    if ("id" in msg && msg.id != null && ("result" in msg || "error" in msg)) {
      const id = String(msg.id);
      const pending = pendingRequests.get(id);
      if (pending) {
        pendingRequests.delete(id);
        if ("error" in msg) {
          pending.reject(new Error(JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Track the timestamp of every server-initiated notification/event.
    runtimeState.lastEventAt = new Date().toISOString();
    const orchestratorEventName =
      typeof msg.method === "string" ? msg.method : undefined;

    // User input required — hard failure
    if (
      msg.method === "item/tool/requestUserInput" ||
      (msg.method === "turn/completed" &&
        msg.params != null &&
        (msg.params as Record<string, unknown>).inputRequired === true)
    ) {
      userInputRequired = true;
      runtimeState.status = "failed";
      runtimeState.run.lastError =
        "turn_input_required: agent requires user input";
      killCalled = true;
      // Resolve any pending turn completion
      resolvePendingTurnCompletion();
      emitOrchestratorChannelEvent(orchestratorEventName);
      return;
    }

    // Turn completed — signal the multi-turn loop
    if (msg.method === "turn/completed") {
      const turnParams = (msg.params ?? {}) as Record<string, unknown>;
      const turnUsage = extractAbsoluteTokenUsage(turnParams.usage);
      if (turnUsage) {
        applyTokenUsageUpdate("turn/completed", turnUsage);
      }
      const rateLimits = extractRateLimitPayload(turnParams);
      if (rateLimits) {
        applyRateLimitUpdate("turn/completed", rateLimits);
      }
      emitOrchestratorChannelEvent(orchestratorEventName);
      resolvePendingTurnCompletion();
      return;
    }

    if (msg.method === "turn/failed") {
      const lastError = describeTurnTerminalEvent(
        "turn/failed",
        msg.params ?? null
      );
      markTurnTerminalFailure("failed", lastError);
      emitOrchestratorChannelEvent(orchestratorEventName);
      return;
    }

    if (msg.method === "turn/cancelled") {
      const lastError = describeTurnTerminalEvent(
        "turn/cancelled",
        msg.params ?? null
      );
      markTurnTerminalFailure("canceled_by_reconciliation", lastError);
      emitOrchestratorChannelEvent(orchestratorEventName);
      return;
    }

    // Token usage events — track cumulative totals
    if (
      msg.method === "thread/tokenUsage/updated" ||
      msg.method === "total_token_usage" ||
      msg.method === "codex/event/token_count"
    ) {
      const tokenUsage = extractAbsoluteTokenUsage(msg.params);
      if (tokenUsage) {
        applyTokenUsageUpdate(msg.method, tokenUsage);
      }
      emitOrchestratorChannelEvent(orchestratorEventName);
      return;
    }

    const rateLimits = extractRateLimitPayload(msg.params);
    if (rateLimits && typeof msg.method === "string") {
      applyRateLimitUpdate(msg.method, rateLimits);
    }
    emitOrchestratorChannelEvent(orchestratorEventName);
  }

  return {
    fake,
    pendingRequests,
    runtimeState,
    sendMessage,
    sendRequest,
    sendRequestWithTimeout,
    waitForTurnCompletion,
    waitForTurnWithTimeout,
    handleServerMessage,
    waitForPendingOrchestratorChannelFlush,
    finalizeRunState,
    applyChildExit,
    maxTurns,
    logs,
    orchestratorEvents,
    get userInputRequired() {
      return userInputRequired;
    },
    get turnTerminalFailure() {
      return turnTerminalFailure;
    },
    get killCalled() {
      return killCalled;
    },
    signalTurnCompleted() {
      if (turnCompletedResolve) {
        turnCompletedResolve();
        turnCompletedResolve = null;
      }
    },
  };
}

function readSentMessages(stream: PassThrough): Array<Record<string, unknown>> {
  let chunk = stream.read();
  if (!chunk) {
    return [];
  }

  let serialized = "";
  while (chunk) {
    serialized += chunk.toString("utf8");
    chunk = stream.read();
  }

  return serialized
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function composeTurnTitle(
  issueIdentifierValue: string | undefined,
  issueTitleValue: string | undefined
): string {
  const issueIdentifier = issueIdentifierValue?.trim() ?? "";
  const issueTitle = issueTitleValue?.trim() ?? "";

  if (issueIdentifier && issueTitle) {
    return `${issueIdentifier}: ${issueTitle}`;
  }

  return issueIdentifier || issueTitle || "Untitled issue";
}

function sendStartupRequestsForEnv(
  ctx: ReturnType<typeof createProtocolContext>,
  env: Partial<
    Pick<
      NodeJS.ProcessEnv,
      | "SYMPHONY_APPROVAL_POLICY"
      | "SYMPHONY_ISSUE_IDENTIFIER"
      | "SYMPHONY_ISSUE_TITLE"
      | "SYMPHONY_THREAD_SANDBOX"
      | "SYMPHONY_TURN_SANDBOX_POLICY"
    >
  >
): void {
  const { approvalPolicy, threadSandbox, turnSandboxPolicy } =
    resolveCodexPolicySettings(env);

  void ctx.sendRequest("thread-1", "thread/start", {
    cwd: "/tmp",
    developerInstructions: "test prompt",
    approvalPolicy,
    sandbox: threadSandbox,
  });
  void ctx.sendRequest("turn-1", "turn/start", {
    threadId: "thread-1",
    input: [{ type: "text", text: "continue" }],
    cwd: "/tmp",
    title: composeTurnTitle(
      env.SYMPHONY_ISSUE_IDENTIFIER,
      env.SYMPHONY_ISSUE_TITLE
    ),
    approvalPolicy,
    sandboxPolicy: turnSandboxPolicy,
  });
}

async function sendStartupHandshake(
  ctx: ReturnType<typeof createProtocolContext>,
  env: Partial<
    Pick<
      NodeJS.ProcessEnv,
      | "SYMPHONY_APPROVAL_POLICY"
      | "SYMPHONY_ISSUE_IDENTIFIER"
      | "SYMPHONY_ISSUE_TITLE"
      | "SYMPHONY_THREAD_SANDBOX"
      | "SYMPHONY_TURN_SANDBOX_POLICY"
    >
  >
): Promise<void> {
  const { approvalPolicy, threadSandbox, turnSandboxPolicy } =
    resolveCodexPolicySettings(env);

  const initializePromise = ctx.sendRequestWithTimeout("init-1", "initialize", {
    clientInfo: { name: "github-symphony", version: "0.1.0" },
    capabilities: {},
  });

  ctx.handleServerMessage({
    jsonrpc: "2.0",
    id: "init-1",
    result: { serverInfo: { name: "codex", version: "1.0" } },
  });

  await initializePromise;

  ctx.sendMessage({ jsonrpc: "2.0", method: "initialized", params: {} });

  const threadPromise = ctx.sendRequestWithTimeout("thread-1", "thread/start", {
    cwd: "/tmp",
    developerInstructions: "test prompt",
    approvalPolicy,
    sandbox: threadSandbox,
  });

  ctx.handleServerMessage({
    jsonrpc: "2.0",
    id: "thread-1",
    result: { thread_id: "thread-from-server" },
  });

  const threadResult = (await threadPromise) as { thread_id?: string };
  const threadId = threadResult.thread_id ?? "thread-1";

  void ctx.sendRequest("turn-1", "turn/start", {
    threadId,
    input: [{ type: "text", text: "continue" }],
    cwd: "/tmp",
    title: composeTurnTitle(
      env.SYMPHONY_ISSUE_IDENTIFIER,
      env.SYMPHONY_ISSUE_TITLE
    ),
    approvalPolicy,
    sandboxPolicy: turnSandboxPolicy,
  });
}

// ---------------------------------------------------------------------------
// refreshTrackerState — replicated from index.ts
// ---------------------------------------------------------------------------

async function refreshTrackerState(env: {
  SYMPHONY_ORCHESTRATOR_URL?: string;
  SYMPHONY_ISSUE_IDENTIFIER?: string;
}): Promise<"active" | "non-actionable" | "unknown"> {
  const orchestratorUrl = env.SYMPHONY_ORCHESTRATOR_URL;
  const issueIdentifier = env.SYMPHONY_ISSUE_IDENTIFIER;

  if (!orchestratorUrl) {
    return "unknown";
  }

  try {
    const response = await fetch(`${orchestratorUrl}/api/v1/state`);
    if (!response.ok) return "unknown";

    const status = (await response.json()) as {
      activeRuns?: Array<{ issueIdentifier: string }>;
    };
    const isActive = status.activeRuns?.some(
      (run) => run.issueIdentifier === issueIdentifier
    );
    return isActive ? "active" : "non-actionable";
  } catch {
    return "unknown";
  }
}

// ===========================================================================
// Tests
// ===========================================================================

describe("multi-turn loop (2.7)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("continues when tracker state is active", async () => {
    const ctx = createProtocolContext({
      maxTurns: 3,
      readTimeoutMs: 1000,
      turnTimeoutMs: 60000,
    });
    const turnResults: string[] = [];

    // Simulate the multi-turn loop from index.ts lines 542-603
    const loopPromise = (async () => {
      for (let turn = 0; turn < ctx.maxTurns; turn++) {
        turnResults.push(`turn-${turn + 1}`);

        // Start waiting for turn completion
        const turnPromise = ctx.waitForTurnWithTimeout();

        // Simulate codex completing the turn after a small delay
        setTimeout(() => {
          ctx.handleServerMessage({ method: "turn/completed", params: {} });
        }, 100);

        await vi.advanceTimersByTimeAsync(100);
        await turnPromise;

        if (ctx.userInputRequired) break;
        if (ctx.turnTerminalFailure) break;
        if (turn + 1 >= ctx.maxTurns) break;

        // Simulate tracker returning "active" — continue loop
        // (We test the actual refreshTrackerState below)
      }
    })();

    await loopPromise;
    expect(turnResults).toEqual(["turn-1", "turn-2", "turn-3"]);
  });

  it("stops at max_turns", async () => {
    const ctx = createProtocolContext({
      maxTurns: 2,
      readTimeoutMs: 1000,
      turnTimeoutMs: 60000,
    });
    let turnCount = 0;

    const loopPromise = (async () => {
      for (let turn = 0; turn < ctx.maxTurns; turn++) {
        turnCount = turn + 1;

        const turnPromise = ctx.waitForTurnWithTimeout();
        setTimeout(() => {
          ctx.handleServerMessage({ method: "turn/completed", params: {} });
        }, 50);
        await vi.advanceTimersByTimeAsync(50);
        await turnPromise;

        if (ctx.turnTerminalFailure) break;
        if (turn + 1 >= ctx.maxTurns) break;
      }
    })();

    await loopPromise;
    expect(turnCount).toBe(2);
  });

  it("stops immediately when turn/failed is received", async () => {
    const ctx = createProtocolContext({
      maxTurns: 3,
      readTimeoutMs: 1000,
      turnTimeoutMs: 60000,
    });
    const turnResults: string[] = [];

    const loopPromise = (async () => {
      for (let turn = 0; turn < ctx.maxTurns; turn++) {
        turnResults.push(`turn-${turn + 1}`);

        const turnPromise = ctx.waitForTurnWithTimeout();
        setTimeout(() => {
          ctx.handleServerMessage({
            method: "turn/failed",
            params: { message: "tool execution failed" },
          });
        }, 25);
        await vi.advanceTimersByTimeAsync(25);
        await turnPromise;

        if (ctx.userInputRequired) break;
        if (ctx.turnTerminalFailure) break;
      }

      ctx.finalizeRunState();
    })();

    await loopPromise;

    expect(turnResults).toEqual(["turn-1"]);
    expect(ctx.runtimeState.status).toBe("failed");
    expect(ctx.runtimeState.runPhase).toBe("failed");
    expect(ctx.runtimeState.run.lastError).toBe(
      "turn_failed: tool execution failed"
    );
  });

  it("stops immediately when turn/cancelled is received", async () => {
    const ctx = createProtocolContext({
      maxTurns: 3,
      readTimeoutMs: 1000,
      turnTimeoutMs: 60000,
    });
    let turnCount = 0;

    const loopPromise = (async () => {
      for (let turn = 0; turn < ctx.maxTurns; turn++) {
        turnCount = turn + 1;

        const turnPromise = ctx.waitForTurnWithTimeout();
        setTimeout(() => {
          ctx.handleServerMessage({
            method: "turn/cancelled",
            params: { reason: "reconciled against tracker state" },
          });
        }, 25);
        await vi.advanceTimersByTimeAsync(25);
        await turnPromise;

        if (ctx.turnTerminalFailure) break;
      }

      ctx.finalizeRunState();
    })();

    await loopPromise;

    expect(turnCount).toBe(1);
    expect(ctx.runtimeState.status).toBe("failed");
    expect(ctx.runtimeState.runPhase).toBe("canceled_by_reconciliation");
    expect(ctx.runtimeState.run.lastError).toBe(
      "turn_cancelled: reconciled against tracker state"
    );
  });

  it("stops when tracker state is non-actionable", async () => {
    // Mock fetch to return non-actionable status
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          activeRuns: [{ issueIdentifier: "other/repo#99" }],
        }),
        { status: 200 }
      )
    );

    const ctx = createProtocolContext({
      maxTurns: 5,
      readTimeoutMs: 1000,
      turnTimeoutMs: 60000,
    });
    const env = {
      SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
      PROJECT_ID: "ws-1",
      SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#1",
    };
    let turnCount = 0;

    // Use real timers for fetch-based test
    vi.useRealTimers();

    for (let turn = 0; turn < ctx.maxTurns; turn++) {
      turnCount = turn + 1;

      // Immediately signal turn completion (no timeout test here)
      ctx.signalTurnCompleted();

      if (turn + 1 >= ctx.maxTurns) break;

      const trackerState = await refreshTrackerState(env);
      if (trackerState === "non-actionable") break;
    }

    expect(turnCount).toBe(1); // Only one turn before discovering non-actionable
    fetchSpy.mockRestore();
  });

  it("continues on tracker refresh failure (returns 'unknown')", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network error"));

    const env = {
      SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
      PROJECT_ID: "ws-1",
      SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#1",
    };

    vi.useRealTimers();

    const result = await refreshTrackerState(env);
    expect(result).toBe("unknown");

    // In the multi-turn loop, "unknown" means continue (not break)
    // This matches the logic: if (trackerState === "non-actionable") break;
    // "unknown" does NOT match, so the loop continues

    fetchSpy.mockRestore();
  });
});

describe("read timeout (3.5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects with response_timeout when initialize has no response", async () => {
    const ctx = createProtocolContext({ readTimeoutMs: 500 });

    const promise = ctx.sendRequestWithTimeout("init-1", "initialize", {
      clientInfo: { name: "test", version: "0.1.0" },
      capabilities: {},
    });

    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
    const rejection = expect(promise).rejects.toThrow(
      "response_timeout: initialize timed out after 500ms"
    );

    await vi.advanceTimersByTimeAsync(501);
    await rejection;
  });

  it("rejects with response_timeout when thread/start has no response", async () => {
    const ctx = createProtocolContext({ readTimeoutMs: 300 });

    const promise = ctx.sendRequestWithTimeout("thread-1", "thread/start", {
      cwd: "/tmp",
      developerInstructions: "test prompt",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });

    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
    const rejection = expect(promise).rejects.toThrow(
      "response_timeout: thread/start timed out after 300ms"
    );

    await vi.advanceTimersByTimeAsync(301);
    await rejection;
  });

  it("resolves successfully when response arrives before timeout", async () => {
    const ctx = createProtocolContext({ readTimeoutMs: 500 });

    const promise = ctx.sendRequestWithTimeout("init-1", "initialize", {
      clientInfo: { name: "test", version: "0.1.0" },
      capabilities: {},
    });

    // Simulate server responding with a JSON-RPC result
    setTimeout(() => {
      ctx.handleServerMessage({
        jsonrpc: "2.0",
        id: "init-1",
        result: { serverInfo: { name: "codex", version: "1.0" } },
      });
    }, 100);

    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result).toEqual({ serverInfo: { name: "codex", version: "1.0" } });
  });

  it("includes env-derived approval and sandbox settings in protocol requests", () => {
    const ctx = createProtocolContext({ readTimeoutMs: 500 });
    sendStartupRequestsForEnv(ctx, {
      SYMPHONY_APPROVAL_POLICY: "on-request",
      SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#1",
      SYMPHONY_ISSUE_TITLE: "Test issue",
      SYMPHONY_THREAD_SANDBOX: "workspace-write",
      SYMPHONY_TURN_SANDBOX_POLICY: "workspace-write",
    });

    const messages = readSentMessages(ctx.fake.stdin);

    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: "thread-1",
        method: "thread/start",
        params: {
          cwd: "/tmp",
          developerInstructions: "test prompt",
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
        },
      },
      {
        jsonrpc: "2.0",
        id: "turn-1",
        method: "turn/start",
        params: {
          threadId: "thread-1",
          input: [{ type: "text", text: "continue" }],
          cwd: "/tmp",
          title: "acme/repo#1: Test issue",
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "workspace-write" },
        },
      },
    ]);
  });

  it("sends initialized between initialize and thread/start", async () => {
    const ctx = createProtocolContext({ readTimeoutMs: 500 });

    await sendStartupHandshake(ctx, {
      SYMPHONY_APPROVAL_POLICY: "on-request",
      SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#1",
      SYMPHONY_ISSUE_TITLE: "Test issue",
      SYMPHONY_THREAD_SANDBOX: "workspace-write",
      SYMPHONY_TURN_SANDBOX_POLICY: "workspace-write",
    });

    const messages = readSentMessages(ctx.fake.stdin);

    expect(messages).toEqual([
      {
        jsonrpc: "2.0",
        id: "init-1",
        method: "initialize",
        params: {
          clientInfo: { name: "github-symphony", version: "0.1.0" },
          capabilities: {},
        },
      },
      {
        jsonrpc: "2.0",
        method: "initialized",
        params: {},
      },
      {
        jsonrpc: "2.0",
        id: "thread-1",
        method: "thread/start",
        params: {
          cwd: "/tmp",
          developerInstructions: "test prompt",
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
        },
      },
      {
        jsonrpc: "2.0",
        id: "turn-1",
        method: "turn/start",
        params: {
          threadId: "thread-from-server",
          input: [{ type: "text", text: "continue" }],
          cwd: "/tmp",
          title: "acme/repo#1: Test issue",
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "workspace-write" },
        },
      },
    ]);
  });

  it("falls back to default approval and sandbox settings when env is empty", () => {
    const ctx = createProtocolContext({ readTimeoutMs: 500 });
    sendStartupRequestsForEnv(ctx, {
      SYMPHONY_APPROVAL_POLICY: "",
      SYMPHONY_ISSUE_IDENTIFIER: "",
      SYMPHONY_ISSUE_TITLE: "",
      SYMPHONY_THREAD_SANDBOX: "",
      SYMPHONY_TURN_SANDBOX_POLICY: "",
    });

    const messages = readSentMessages(ctx.fake.stdin);

    expect(messages[0]).toEqual({
      jsonrpc: "2.0",
      id: "thread-1",
      method: "thread/start",
      params: {
        cwd: "/tmp",
        developerInstructions: "test prompt",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    });
    expect(messages[1]).toEqual({
      jsonrpc: "2.0",
      id: "turn-1",
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "continue" }],
        cwd: "/tmp",
        title: "Untitled issue",
        approvalPolicy: "never",
        sandboxPolicy: undefined,
      },
    });
  });

  it("trims and composes title without dangling separators", () => {
    const ctx = createProtocolContext({ readTimeoutMs: 500 });
    sendStartupRequestsForEnv(ctx, {
      SYMPHONY_ISSUE_IDENTIFIER: "  acme/repo#1  ",
      SYMPHONY_ISSUE_TITLE: "  Test issue\n",
    });

    const messages = readSentMessages(ctx.fake.stdin);

    expect(messages[1]).toEqual({
      jsonrpc: "2.0",
      id: "turn-1",
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "continue" }],
        cwd: "/tmp",
        title: "acme/repo#1: Test issue",
        approvalPolicy: "never",
        sandboxPolicy: undefined,
      },
    });
  });

  it("omits the separator when only one title component is available", () => {
    const identifierOnlyCtx = createProtocolContext({ readTimeoutMs: 500 });
    sendStartupRequestsForEnv(identifierOnlyCtx, {
      SYMPHONY_ISSUE_IDENTIFIER: "  acme/repo#1  ",
      SYMPHONY_ISSUE_TITLE: "   ",
    });

    const identifierOnlyMessages = readSentMessages(identifierOnlyCtx.fake.stdin);

    expect(identifierOnlyMessages[1]).toEqual({
      jsonrpc: "2.0",
      id: "turn-1",
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "continue" }],
        cwd: "/tmp",
        title: "acme/repo#1",
        approvalPolicy: "never",
        sandboxPolicy: undefined,
      },
    });

    const titleOnlyCtx = createProtocolContext({ readTimeoutMs: 500 });
    sendStartupRequestsForEnv(titleOnlyCtx, {
      SYMPHONY_ISSUE_IDENTIFIER: "\n",
      SYMPHONY_ISSUE_TITLE: "  Test issue  ",
    });

    const titleOnlyMessages = readSentMessages(titleOnlyCtx.fake.stdin);

    expect(titleOnlyMessages[1]).toEqual({
      jsonrpc: "2.0",
      id: "turn-1",
      method: "turn/start",
      params: {
        threadId: "thread-1",
        input: [{ type: "text", text: "continue" }],
        cwd: "/tmp",
        title: "Test issue",
        approvalPolicy: "never",
        sandboxPolicy: undefined,
      },
    });
  });
});

describe("rate-limit telemetry", () => {
  it("captures rate limits from turn/completed payloads", () => {
    const ctx = createProtocolContext({
      readTimeoutMs: 1000,
      turnTimeoutMs: 60000,
    });

    ctx.handleServerMessage({
      method: "turn/completed",
      params: {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
        rate_limits: {
          source: "upstream",
          remaining: 42,
          resetAt: "2026-03-08T00:30:00.000Z",
        },
      },
    });

    expect(ctx.runtimeState.rateLimits).toEqual({
      source: "codex",
      remaining: 42,
      resetAt: "2026-03-08T00:30:00.000Z",
    });
  });

  it("captures nested rate limits from non-turn agent events", () => {
    const ctx = createProtocolContext({
      readTimeoutMs: 1000,
      turnTimeoutMs: 60000,
    });

    ctx.handleServerMessage({
      method: "codex/event/session_updated",
      params: {
        payload: {
          info: {
            rateLimits: {
              limit: 100,
              remaining: 99,
              resource: "tokens",
            },
          },
        },
      },
    });

    expect(ctx.runtimeState.rateLimits).toEqual({
      source: "codex",
      limit: 100,
      remaining: 99,
      resource: "tokens",
    });
  });
});

describe("turn timeout (3.6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects with turn_timeout when turn exceeds limit", async () => {
    const ctx = createProtocolContext({ turnTimeoutMs: 1000 });

    const promise = ctx.waitForTurnWithTimeout();

    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
    const rejection = expect(promise).rejects.toThrow(
      "turn_timeout: turn exceeded time limit"
    );

    await vi.advanceTimersByTimeAsync(1001);
    await rejection;

    expect(ctx.killCalled).toBe(true);
  });

  it("resolves normally when turn completes within limit", async () => {
    const ctx = createProtocolContext({ turnTimeoutMs: 5000 });

    const promise = ctx.waitForTurnWithTimeout();

    // Signal turn completion before timeout
    setTimeout(() => {
      ctx.handleServerMessage({ method: "turn/completed", params: {} });
    }, 500);

    await vi.advanceTimersByTimeAsync(500);
    await promise; // Should resolve without throwing

    expect(ctx.killCalled).toBe(false);
  });

  it("resolves pending turn wait when turn/failed is received", async () => {
    const ctx = createProtocolContext({ turnTimeoutMs: 5000 });

    const promise = ctx.waitForTurnWithTimeout();

    setTimeout(() => {
      ctx.handleServerMessage({
        method: "turn/failed",
        params: { error: { message: "model backend failed" } },
      });
    }, 100);

    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(ctx.runtimeState.status).toBe("failed");
    expect(ctx.runtimeState.runPhase).toBe("failed");
    expect(ctx.runtimeState.run.lastError).toBe(
      "turn_failed: model backend failed"
    );
  });

  it("resolves pending turn wait when turn/cancelled is received", async () => {
    const ctx = createProtocolContext({ turnTimeoutMs: 5000 });

    const promise = ctx.waitForTurnWithTimeout();

    setTimeout(() => {
      ctx.handleServerMessage({
        method: "turn/cancelled",
        params: { reason: "superseded" },
      });
    }, 100);

    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(ctx.runtimeState.status).toBe("failed");
    expect(ctx.runtimeState.runPhase).toBe("canceled_by_reconciliation");
    expect(ctx.runtimeState.run.lastError).toBe("turn_cancelled: superseded");
  });

  it("falls back when nested turn failure message is whitespace only", async () => {
    const ctx = createProtocolContext({ turnTimeoutMs: 5000 });

    const promise = ctx.waitForTurnWithTimeout();

    setTimeout(() => {
      ctx.handleServerMessage({
        method: "turn/failed",
        params: { error: { message: "   " }, code: "E_BACKEND" },
      });
    }, 100);

    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(ctx.runtimeState.status).toBe("failed");
    expect(ctx.runtimeState.runPhase).toBe("failed");
    expect(ctx.runtimeState.run.lastError).toBe(
      'turn_failed: {"error":{"message":"   "},"code":"E_BACKEND"}'
    );
  });

  it("preserves terminal failure details after child exit", async () => {
    const ctx = createProtocolContext({ turnTimeoutMs: 5000 });

    const promise = ctx.waitForTurnWithTimeout();

    setTimeout(() => {
      ctx.handleServerMessage({
        method: "turn/failed",
        params: { message: "tool execution failed" },
      });
    }, 100);

    await vi.advanceTimersByTimeAsync(100);
    await promise;

    ctx.applyChildExit(1, null);

    expect(ctx.runtimeState.status).toBe("failed");
    expect(ctx.runtimeState.runPhase).toBe("failed");
    expect(ctx.runtimeState.run.lastError).toBe(
      "turn_failed: tool execution failed"
    );
  });
});

describe("user input required hard failure (4.3)", () => {
  it("detects item/tool/requestUserInput and marks failure", () => {
    const ctx = createProtocolContext({});

    ctx.handleServerMessage({
      method: "item/tool/requestUserInput",
      params: { prompt: "Enter API key" },
    });

    expect(ctx.userInputRequired).toBe(true);
    expect(ctx.runtimeState.status).toBe("failed");
    expect(ctx.runtimeState.run.lastError).toBe(
      "turn_input_required: agent requires user input"
    );
    expect(ctx.killCalled).toBe(true);
  });

  it("detects turn/completed with inputRequired=true and marks failure", () => {
    const ctx = createProtocolContext({});

    ctx.handleServerMessage({
      method: "turn/completed",
      params: { inputRequired: true },
    });

    expect(ctx.userInputRequired).toBe(true);
    expect(ctx.runtimeState.status).toBe("failed");
    expect(ctx.runtimeState.run.lastError).toBe(
      "turn_input_required: agent requires user input"
    );
    expect(ctx.killCalled).toBe(true);
  });

  it("does NOT trigger on normal turn/completed (inputRequired absent)", () => {
    const ctx = createProtocolContext({});

    ctx.handleServerMessage({
      method: "turn/completed",
      params: {},
    });

    expect(ctx.userInputRequired).toBe(false);
    expect(ctx.runtimeState.status).toBe("running");
    expect(ctx.killCalled).toBe(false);
  });

  it("resolves pending turn completion on user input detection", async () => {
    const ctx = createProtocolContext({ turnTimeoutMs: 60000 });

    vi.useFakeTimers();

    // Start waiting for turn
    const turnPromise = ctx.waitForTurnWithTimeout();

    // Simulate user input required detection
    setTimeout(() => {
      ctx.handleServerMessage({
        method: "item/tool/requestUserInput",
        params: {},
      });
    }, 100);

    await vi.advanceTimersByTimeAsync(100);

    // The turn should resolve (not hang) because the handler calls turnCompletedResolve
    await turnPromise;

    expect(ctx.userInputRequired).toBe(true);

    vi.useRealTimers();
  });
});

describe("refreshTrackerState", () => {
  it("returns 'unknown' when orchestrator URL is missing", async () => {
    const result = await refreshTrackerState({
      SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#1",
    });
    expect(result).toBe("unknown");
  });

  it("returns 'non-actionable' when the issue is not present in activeRuns", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          activeRuns: [],
        }),
        { status: 200 }
      )
    );

    const result = await refreshTrackerState({
      SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
      SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#1",
    });
    expect(result).toBe("non-actionable");
    expect(fetchSpy).toHaveBeenCalledWith("http://localhost:4680/api/v1/state");
    fetchSpy.mockRestore();
  });

  it("returns 'active' when the issue is in activeRuns", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          activeRuns: [{ issueIdentifier: "acme/repo#1" }],
        }),
        { status: 200 }
      )
    );

    const result = await refreshTrackerState({
      SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
      SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#1",
    });

    expect(result).toBe("active");
    fetchSpy.mockRestore();
  });

  it("returns 'non-actionable' when the issue is not in activeRuns", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          activeRuns: [{ issueIdentifier: "other/repo#99" }],
        }),
        { status: 200 }
      )
    );

    const result = await refreshTrackerState({
      SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
      SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#1",
    });

    expect(result).toBe("non-actionable");
    fetchSpy.mockRestore();
  });

  it("returns 'unknown' on fetch error", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await refreshTrackerState({
      SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
      SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#1",
    });

    expect(result).toBe("unknown");
    fetchSpy.mockRestore();
  });

  it("returns 'unknown' on non-OK response", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("Not Found", { status: 404 }));

    const result = await refreshTrackerState({
      SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
      SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#1",
    });

    expect(result).toBe("unknown");
    fetchSpy.mockRestore();
  });
});

describe("orchestrator channel telemetry", () => {
  it("emits codex_update payloads with the latest counters and rate limits", () => {
    const ctx = createProtocolContext({});

    ctx.handleServerMessage({
      method: "turn/completed",
      params: {
        usage: { input_tokens: 90, output_tokens: 30, total_tokens: 120 },
        rate_limits: {
          remaining: 7,
          resetAt: "2026-03-08T00:30:00.000Z",
        },
      },
    });

    expect(ctx.orchestratorEvents).toHaveLength(1);
    expect(ctx.orchestratorEvents[0]).toEqual({
      type: "codex_update",
      issueId: "issue-1",
      lastEventAt: expect.any(String),
      tokenUsage: {
        inputTokens: 90,
        outputTokens: 30,
        totalTokens: 120,
      },
      rateLimits: {
        source: "codex",
        remaining: 7,
        resetAt: "2026-03-08T00:30:00.000Z",
      },
      event: "turn/completed",
    });
  });

  it("coalesces codex_update payloads while stderr is backpressured and flushes the latest on drain", () => {
    const drainEmitter = new EventEmitter();
    const writtenPayloads: Array<Record<string, unknown>> = [];
    let writeCount = 0;
    const ctx = createProtocolContext({
      orchestratorChannelWriter: {
        write(chunk: string): boolean {
          writtenPayloads.push(JSON.parse(chunk) as Record<string, unknown>);
          writeCount += 1;
          return writeCount !== 1;
        },
        once(event: "drain", listener: () => void): void {
          drainEmitter.once(event, listener);
        },
      },
    });

    ctx.handleServerMessage({
      method: "thread/tokenUsage/updated",
      params: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    });
    ctx.handleServerMessage({
      method: "thread/tokenUsage/updated",
      params: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
    });
    ctx.handleServerMessage({
      method: "thread/tokenUsage/updated",
      params: { input_tokens: 7, output_tokens: 8, total_tokens: 15 },
    });

    expect(writtenPayloads).toHaveLength(1);
    expect(writtenPayloads[0]).toMatchObject({
      event: "thread/tokenUsage/updated",
      tokenUsage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
    });

    drainEmitter.emit("drain");

    expect(writtenPayloads).toHaveLength(2);
    expect(writtenPayloads[1]).toMatchObject({
      event: "thread/tokenUsage/updated",
      tokenUsage: {
        inputTokens: 7,
        outputTokens: 8,
        totalTokens: 15,
      },
    });
  });

  it("waits for the trailing codex_update payload to flush before exit when stderr is backpressured", async () => {
    const drainEmitter = new EventEmitter();
    const writtenPayloads: Array<Record<string, unknown>> = [];
    let writeCount = 0;
    const ctx = createProtocolContext({
      orchestratorChannelWriter: {
        write(chunk: string): boolean {
          writtenPayloads.push(JSON.parse(chunk) as Record<string, unknown>);
          writeCount += 1;
          return writeCount !== 1;
        },
        once(event: "drain", listener: () => void): void {
          drainEmitter.once(event, listener);
        },
        on(event: "drain", listener: () => void): void {
          drainEmitter.on(event, listener);
        },
        removeListener(event: "drain", listener: () => void): void {
          drainEmitter.removeListener(event, listener);
        },
      },
    });

    ctx.handleServerMessage({
      method: "thread/tokenUsage/updated",
      params: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    });
    ctx.handleServerMessage({
      method: "thread/tokenUsage/updated",
      params: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
    });

    const flushPromise = ctx.waitForPendingOrchestratorChannelFlush(1000);
    let resolved = false;
    void flushPromise.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(writtenPayloads).toHaveLength(1);

    drainEmitter.emit("drain");
    await flushPromise;

    expect(resolved).toBe(true);
    expect(writtenPayloads).toHaveLength(2);
    expect(writtenPayloads[1]).toMatchObject({
      event: "thread/tokenUsage/updated",
      tokenUsage: {
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
      },
    });
  });
});

describe("token usage tracking", () => {
  it("updates and logs token counts from turn/completed usage payloads", () => {
    const ctx = createProtocolContext({});

    ctx.handleServerMessage({
      method: "turn/completed",
      params: {
        usage: { input_tokens: 90, output_tokens: 30, total_tokens: 120 },
      },
    });

    expect(ctx.runtimeState.tokenUsage).toEqual({
      inputTokens: 90,
      outputTokens: 30,
      totalTokens: 120,
    });
    expect(ctx.logs).toContain(
      "[worker] token_usage source=turn/completed input=90 output=30 total=120"
    );
  });

  it("updates token counts from thread/tokenUsage/updated events", () => {
    const ctx = createProtocolContext({});

    ctx.handleServerMessage({
      method: "thread/tokenUsage/updated",
      params: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    });

    expect(ctx.runtimeState.tokenUsage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
  });

  it("updates token counts from total_token_usage events", () => {
    const ctx = createProtocolContext({});

    ctx.handleServerMessage({
      method: "total_token_usage",
      params: { input_tokens: 200, output_tokens: 100, total_tokens: 300 },
    });

    expect(ctx.runtimeState.tokenUsage).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
    });
  });

  it("updates token counts from codex/event/token_count wrapper events", () => {
    const ctx = createProtocolContext({});

    ctx.handleServerMessage({
      method: "codex/event/token_count",
      params: {
        msg: {
          info: {
            total_token_usage: {
              input_tokens: 300,
              output_tokens: 120,
              total_tokens: 420,
            },
          },
        },
      },
    });

    expect(ctx.runtimeState.tokenUsage).toEqual({
      inputTokens: 300,
      outputTokens: 120,
      totalTokens: 420,
    });
  });

  it("accepts alternate codex/event/token_count wrapper shapes", () => {
    const ctx = createProtocolContext({});

    ctx.handleServerMessage({
      method: "codex/event/token_count",
      params: {
        info: {
          total_token_usage: {
            input_tokens: 410,
            output_tokens: 140,
            total_tokens: 550,
          },
        },
      },
    });

    expect(ctx.runtimeState.tokenUsage).toEqual({
      inputTokens: 410,
      outputTokens: 140,
      totalTokens: 550,
    });
  });

  it("accepts deeply nested token_count wrapper shapes and logs the update", () => {
    const ctx = createProtocolContext({});

    ctx.handleServerMessage({
      method: "codex/event/token_count",
      params: {
        event: {
          payload: {
            info: {
              total_token_usage: {
                input_tokens: 515,
                output_tokens: 185,
                total_tokens: 700,
              },
              last_token_usage: {
                input_tokens: 1,
                output_tokens: 1,
                total_tokens: 2,
              },
            },
          },
        },
      },
    });

    expect(ctx.runtimeState.tokenUsage).toEqual({
      inputTokens: 515,
      outputTokens: 185,
      totalTokens: 700,
    });
    expect(ctx.logs).toContain(
      "[worker] token_usage source=codex/event/token_count input=515 output=185 total=700"
    );
  });

  it("prefers absolute totals (replaces, does not accumulate)", () => {
    const ctx = createProtocolContext({});

    ctx.handleServerMessage({
      method: "thread/tokenUsage/updated",
      params: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    });
    ctx.handleServerMessage({
      method: "thread/tokenUsage/updated",
      params: { input_tokens: 200, output_tokens: 100, total_tokens: 300 },
    });

    // Should be latest absolute value, not sum
    expect(ctx.runtimeState.tokenUsage).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
    });
  });

  it("computes totalTokens from input + output when total_tokens is 0", () => {
    const ctx = createProtocolContext({});

    ctx.handleServerMessage({
      method: "thread/tokenUsage/updated",
      params: { input_tokens: 80, output_tokens: 40, total_tokens: 0 },
    });

    expect(ctx.runtimeState.tokenUsage.totalTokens).toBe(120);
  });

  it("ignores events with all-zero token counts", () => {
    const ctx = createProtocolContext({});

    // Set initial values
    ctx.handleServerMessage({
      method: "thread/tokenUsage/updated",
      params: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    });

    // This should be ignored — all zeros
    ctx.handleServerMessage({
      method: "thread/tokenUsage/updated",
      params: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    });

    expect(ctx.runtimeState.tokenUsage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
  });
});

describe("lastEventAt timestamp tracking", () => {
  it("updates lastEventAt on turn/completed", () => {
    const ctx = createProtocolContext({});
    expect(ctx.runtimeState.lastEventAt).toBeNull();

    ctx.handleServerMessage({
      method: "turn/completed",
      params: {},
    });

    expect(ctx.runtimeState.lastEventAt).not.toBeNull();
    // Verify it's a valid ISO timestamp
    expect(new Date(ctx.runtimeState.lastEventAt!).toISOString()).toBe(
      ctx.runtimeState.lastEventAt
    );
  });

  it("updates lastEventAt on turn/failed", () => {
    const ctx = createProtocolContext({});

    ctx.handleServerMessage({
      method: "turn/failed",
      params: { message: "some failure" },
    });

    expect(ctx.runtimeState.lastEventAt).not.toBeNull();
  });

  it("updates lastEventAt on turn/cancelled", () => {
    const ctx = createProtocolContext({});

    ctx.handleServerMessage({
      method: "turn/cancelled",
      params: { reason: "reconciliation" },
    });

    expect(ctx.runtimeState.lastEventAt).not.toBeNull();
  });

  it("updates lastEventAt on token usage events", () => {
    const ctx = createProtocolContext({});

    ctx.handleServerMessage({
      method: "thread/tokenUsage/updated",
      params: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    });

    expect(ctx.runtimeState.lastEventAt).not.toBeNull();
  });

  it("updates lastEventAt on user_input_required", () => {
    const ctx = createProtocolContext({});

    ctx.handleServerMessage({
      method: "item/tool/requestUserInput",
      params: {},
    });

    expect(ctx.runtimeState.lastEventAt).not.toBeNull();
  });

  it("does not update lastEventAt on JSON-RPC responses", () => {
    const ctx = createProtocolContext({});
    // Set up a pending request so the response handler finds it
    void ctx.sendRequest("test-1", "initialize", {});

    ctx.handleServerMessage({
      id: "test-1",
      result: { ok: true },
    });

    expect(ctx.runtimeState.lastEventAt).toBeNull();
  });

  it("advances lastEventAt on each successive event", () => {
    vi.useFakeTimers();
    try {
      const baseTime = new Date("2024-01-01T00:00:00.000Z");
      vi.setSystemTime(baseTime);

      const ctx = createProtocolContext({});

      ctx.handleServerMessage({
        method: "thread/tokenUsage/updated",
        params: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      });
      const first = ctx.runtimeState.lastEventAt;
      expect(first).not.toBeNull();

      // Advance system time deterministically to ensure timestamp advances
      const laterTime = new Date(baseTime.getTime() + 10);
      vi.setSystemTime(laterTime);

      ctx.handleServerMessage({
        method: "turn/completed",
        params: {},
      });
      const second = ctx.runtimeState.lastEventAt;
      expect(second).not.toBeNull();
      expect(new Date(second!).getTime()).toBeGreaterThan(
        new Date(first!).getTime()
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
