import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  classifySessionExit,
  DEFAULT_AGENT_INPUT_REQUIRED_REASON,
  parseWorkflowMarkdown,
  resolveWorkflowRuntimeCommand,
  type AgentEvent,
  type OrchestratorChannelEvent,
  type RunAttemptPhase,
  type SessionExitClassification,
  type WorkflowExecutionPhase,
} from "@gh-symphony/core";
import {
  getCodexObservabilityEventName,
  launchCodexAppServer,
  normalizeCodexRuntimeEvents,
  prepareCodexRuntimePlan,
  type CodexRuntimePlan,
  type RuntimeToolDefinition,
} from "@gh-symphony/runtime-codex";
import {
  loadLauncherEnvironment,
  resolveLocalRuntimeLaunchConfig,
} from "@gh-symphony/runtime-codex";
import {
  resolveFinalExecutionPhase,
  resolveInitialExecutionPhase,
} from "./execution-phase.js";
import { resolveCodexPolicySettings } from "./codex-policy.js";
import {
  captureTurnWorkspaceSnapshot,
  evaluateTurnProgress,
  resolveMaxNonProductiveTurns,
} from "./convergence-detection.js";
import { resolveExitRunPhase } from "./run-phase.js";
import {
  buildContinuationTurnInput,
} from "./thread-resume.js";
import { resolveMaxTurns } from "./turn-limits.js";
import { persistTokenUsageArtifact, type TokenUsage } from "./token-usage.js";

const launcherEnv = loadLauncherEnvironment(process.env);
type TokenUsageSnapshot = TokenUsage;
const runtimeState: {
  status: "idle" | "starting" | "running" | "failed" | "completed";
  executionPhase: WorkflowExecutionPhase | null;
  runPhase: RunAttemptPhase | null;
  sessionId: string | null;
  run: null | {
    runId: string;
    issueId: string | null;
    issueIdentifier: string | null;
    state: string | null;
    processId: number | null;
    repository: {
      owner: string | null;
      name: string | null;
      cloneUrl: string | null;
      url: string | null;
    };
    lastError: string | null;
  };
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  lastEventAt: string | null;
  rateLimits: Record<string, unknown> | null;
  sessionInfo: {
    threadId: string | null;
    turnId: string | null;
    turnCount: number;
    sessionId: string | null;
    exitClassification: SessionExitClassification | null;
  };
} = {
  status: launcherEnv.SYMPHONY_RUN_ID ? "starting" : "idle",
  executionPhase: null,
  runPhase: launcherEnv.SYMPHONY_RUN_ID ? "preparing_workspace" : null,
  sessionId: null,
  run: launcherEnv.SYMPHONY_RUN_ID
    ? {
        runId: launcherEnv.SYMPHONY_RUN_ID,
        issueId: launcherEnv.SYMPHONY_ISSUE_ID ?? null,
        issueIdentifier: launcherEnv.SYMPHONY_ISSUE_IDENTIFIER ?? null,
        state: launcherEnv.SYMPHONY_ISSUE_STATE ?? null,
        processId: null,
        repository: {
          owner: launcherEnv.TARGET_REPOSITORY_OWNER ?? null,
          name: launcherEnv.TARGET_REPOSITORY_NAME ?? null,
          cloneUrl: launcherEnv.TARGET_REPOSITORY_CLONE_URL ?? null,
          url: launcherEnv.TARGET_REPOSITORY_URL ?? null,
        },
        lastError: null,
      }
    : null,
  tokenUsage: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  },
  lastEventAt: null,
  rateLimits: null,
  sessionInfo: {
    threadId: null,
    turnId: null,
    turnCount: 0,
    sessionId: null,
    exitClassification: null,
  },
};

console.log(
  JSON.stringify(
    {
      package: "@gh-symphony/worker",
      runtime: "self-hosted-sample",
    },
    null,
    2
  )
);

let childProcess: ReturnType<typeof launchCodexAppServer> | null = null;
let shutdownPromise: Promise<void> | null = null;
let orchestratorChannelDrainPending = false;
const pendingOrchestratorChannelPayloads: string[] = [];
let orchestratorHeartbeatTimer: NodeJS.Timeout | null = null;
const MAX_PENDING_ORCHESTRATOR_CHANNEL_PAYLOADS = 16;
const ORCHESTRATOR_CHANNEL_FLUSH_TIMEOUT_MS = 250;
const ORCHESTRATOR_CHANNEL_HEARTBEAT_INTERVAL_MS = 10_000;

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

if (launcherEnv.SYMPHONY_RUN_ID && launcherEnv.WORKING_DIRECTORY) {
  startOrchestratorHeartbeatTimer();
  void startAssignedRun();
}

function shutdown(signal: NodeJS.Signals) {
  if (shutdownPromise) {
    return;
  }

  shutdownPromise = (async () => {
    if (childProcess?.pid) {
      try {
        process.kill(childProcess.pid, "SIGTERM");
      } catch {
        // Ignore shutdown races.
      }
    }

    stopOrchestratorHeartbeatTimer();
    emitOrchestratorHeartbeat();
    await persistSessionTokenUsageArtifact(launcherEnv);
    await waitForPendingOrchestratorChannelFlush(
      resolveTerminalOrchestratorChannelFlushTimeoutMs()
    );
    console.log(`Worker stopped on ${signal}`);
    process.exit(0);
  })();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

type ActiveTurnTelemetry = {
  startedAt: string;
  threadId: string | null;
  turnId: string | null;
  turnCount: number;
  sessionId: string | null;
  tokenUsageBaseline: TokenUsageSnapshot;
};

function enqueuePendingOrchestratorChannelPayload(payload: string): void {
  if (
    pendingOrchestratorChannelPayloads.length >=
    MAX_PENDING_ORCHESTRATOR_CHANNEL_PAYLOADS
  ) {
    pendingOrchestratorChannelPayloads.shift();
  }

  pendingOrchestratorChannelPayloads.push(payload);
}

function flushPendingOrchestratorChannelEvent(): void {
  while (pendingOrchestratorChannelPayloads.length > 0) {
    const payload = pendingOrchestratorChannelPayloads.shift();
    if (!payload) {
      continue;
    }

    const wrote = process.stderr.write(payload);
    if (wrote) {
      continue;
    }

    orchestratorChannelDrainPending = true;
    process.stderr.once("drain", flushPendingOrchestratorChannelEvent);
    return;
  }

  orchestratorChannelDrainPending = false;
}

function waitForPendingOrchestratorChannelFlush(
  timeoutMs = ORCHESTRATOR_CHANNEL_FLUSH_TIMEOUT_MS
): Promise<void> {
  if (
    !orchestratorChannelDrainPending &&
    pendingOrchestratorChannelPayloads.length === 0
  ) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | null = setTimeout(() => {
      settled = true;
      process.stderr.removeListener("drain", handleDrain);
      timeout = null;
      resolve();
    }, timeoutMs);

    const handleDrain = () => {
      if (
        orchestratorChannelDrainPending ||
        pendingOrchestratorChannelPayloads.length > 0
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
      process.stderr.removeListener("drain", handleDrain);
      resolve();
    };

    process.stderr.on("drain", handleDrain);
  });
}

function resolveTerminalOrchestratorChannelFlushTimeoutMs(): number {
  const pendingPayloadCount =
    pendingOrchestratorChannelPayloads.length +
    (orchestratorChannelDrainPending ? 1 : 0);

  return Math.max(
    ORCHESTRATOR_CHANNEL_FLUSH_TIMEOUT_MS,
    pendingPayloadCount * ORCHESTRATOR_CHANNEL_FLUSH_TIMEOUT_MS
  );
}

function writeOrQueueOrchestratorChannelPayload(
  serializedPayload: string
): void {
  if (orchestratorChannelDrainPending) {
    enqueuePendingOrchestratorChannelPayload(serializedPayload);
    return;
  }

  const wrote = process.stderr.write(serializedPayload);
  if (!wrote) {
    orchestratorChannelDrainPending = true;
    process.stderr.once("drain", flushPendingOrchestratorChannelEvent);
  }
}

function emitOrchestratorHeartbeat(): void {
  const issueId = runtimeState.run?.issueId;
  if (!issueId) {
    return;
  }

  const payload: OrchestratorChannelEvent = {
    type: "heartbeat",
    issueId,
    lastEventAt: runtimeState.lastEventAt,
    tokenUsage: resolveSessionTokenUsageDelta(),
    rateLimits: runtimeState.rateLimits ? { ...runtimeState.rateLimits } : null,
    sessionInfo: { ...runtimeState.sessionInfo },
    executionPhase: runtimeState.executionPhase,
    runPhase: runtimeState.runPhase,
    lastError: runtimeState.run?.lastError ?? null,
  };

  writeOrQueueOrchestratorChannelPayload(`${JSON.stringify(payload)}\n`);
}

function startOrchestratorHeartbeatTimer(): void {
  if (orchestratorHeartbeatTimer) {
    return;
  }

  orchestratorHeartbeatTimer = setInterval(() => {
    emitOrchestratorHeartbeat();
  }, ORCHESTRATOR_CHANNEL_HEARTBEAT_INTERVAL_MS);
  orchestratorHeartbeatTimer.unref?.();
}

function stopOrchestratorHeartbeatTimer(): void {
  if (!orchestratorHeartbeatTimer) {
    return;
  }

  clearInterval(orchestratorHeartbeatTimer);
  orchestratorHeartbeatTimer = null;
}

function emitOrchestratorChannelEvent(event?: string): void {
  const issueId = runtimeState.run?.issueId;
  const lastEventAt = runtimeState.lastEventAt;
  if (!issueId || !lastEventAt) {
    return;
  }

  const payload: OrchestratorChannelEvent = {
    type: "codex_update",
    issueId,
    lastEventAt,
    tokenUsage: resolveSessionTokenUsageDelta(),
    sessionInfo: { ...runtimeState.sessionInfo },
    executionPhase: runtimeState.executionPhase,
    runPhase: runtimeState.runPhase,
    lastError: runtimeState.run?.lastError ?? null,
  };

  if (runtimeState.rateLimits) {
    payload.rateLimits = { ...runtimeState.rateLimits };
  }
  if (event) {
    payload.event = event;
  }

  writeOrQueueOrchestratorChannelPayload(`${JSON.stringify(payload)}\n`);
}

function cloneTokenUsageSnapshot(): TokenUsageSnapshot {
  return { ...runtimeState.tokenUsage };
}

function resolveTurnTokenUsageDelta(
  baseline: TokenUsageSnapshot
): TokenUsageSnapshot {
  return {
    inputTokens: Math.max(
      0,
      runtimeState.tokenUsage.inputTokens - baseline.inputTokens
    ),
    outputTokens: Math.max(
      0,
      runtimeState.tokenUsage.outputTokens - baseline.outputTokens
    ),
    totalTokens: Math.max(
      0,
      runtimeState.tokenUsage.totalTokens - baseline.totalTokens
    ),
  };
}

function resolveSessionTokenUsageDelta(): TokenUsageSnapshot {
  return cloneTokenUsageSnapshot();
}

async function persistSessionTokenUsageArtifact(
  env: NodeJS.ProcessEnv
): Promise<void> {
  await persistTokenUsageArtifact(env, resolveSessionTokenUsageDelta());
}

function emitTurnStartedEvent(turn: ActiveTurnTelemetry): void {
  const issueId = runtimeState.run?.issueId;
  if (!issueId) {
    return;
  }

  const payload: OrchestratorChannelEvent = {
    type: "turn_started",
    issueId,
    startedAt: turn.startedAt,
    threadId: turn.threadId,
    turnId: turn.turnId,
    turnCount: turn.turnCount,
    sessionId: turn.sessionId,
  };

  writeOrQueueOrchestratorChannelPayload(`${JSON.stringify(payload)}\n`);
}

function emitTurnCompletedEvent(turn: ActiveTurnTelemetry): void {
  const issueId = runtimeState.run?.issueId;
  if (!issueId) {
    return;
  }

  const completedAt = new Date().toISOString();
  const payload: OrchestratorChannelEvent = {
    type: "turn_completed",
    issueId,
    startedAt: turn.startedAt,
    completedAt,
    durationMs: Math.max(
      0,
      new Date(completedAt).getTime() - new Date(turn.startedAt).getTime()
    ),
    threadId: turn.threadId,
    turnId: turn.turnId,
    turnCount: turn.turnCount,
    sessionId: turn.sessionId,
    tokenUsage: resolveTurnTokenUsageDelta(turn.tokenUsageBaseline),
  };

  writeOrQueueOrchestratorChannelPayload(`${JSON.stringify(payload)}\n`);
}

function emitTurnFailedEvent(
  turn: ActiveTurnTelemetry,
  error: string | null
): void {
  const issueId = runtimeState.run?.issueId;
  if (!issueId) {
    return;
  }

  const failedAt = new Date().toISOString();
  const payload: OrchestratorChannelEvent = {
    type: "turn_failed",
    issueId,
    startedAt: turn.startedAt,
    failedAt,
    durationMs: Math.max(
      0,
      new Date(failedAt).getTime() - new Date(turn.startedAt).getTime()
    ),
    threadId: turn.threadId,
    turnId: turn.turnId,
    turnCount: turn.turnCount,
    sessionId: turn.sessionId,
    tokenUsage: resolveTurnTokenUsageDelta(turn.tokenUsageBaseline),
    error,
  };

  writeOrQueueOrchestratorChannelPayload(`${JSON.stringify(payload)}\n`);
}

async function startAssignedRun() {
  try {
    const workflowPath =
      launcherEnv.SYMPHONY_WORKFLOW_PATH ||
      join(launcherEnv.WORKING_DIRECTORY!, "WORKFLOW.md");
    runtimeState.runPhase = "building_prompt";
    const workflow = parseWorkflowMarkdown(
      await readFile(workflowPath, "utf8"),
      launcherEnv
    );
    runtimeState.executionPhase = resolveInitialExecutionPhase({
      issueState: runtimeState.run?.state,
      blockerCheckStates: workflow.lifecycle.blockerCheckStates,
      activeStates: workflow.lifecycle.activeStates,
    });
    const config = resolveLocalRuntimeLaunchConfig(launcherEnv);
    config.agentCommand = resolveWorkflowRuntimeCommand(workflow);
    runtimeState.runPhase = "launching_agent";
    // TODO(#254): route claude-print/custom runtime kinds through runtime
    // adapters instead of the Codex app-server client protocol.
    const plan = await prepareCodexRuntimePlan(config);
    childProcess = launchCodexAppServer(plan);
    runtimeState.status = "running";
    runtimeState.runPhase = "initializing_session";

    if (runtimeState.run) {
      runtimeState.run.processId = childProcess.pid ?? null;
    }

    // Wire up the codex app-server client protocol (multi-turn)
    void runCodexClientProtocol(childProcess, plan, launcherEnv, {
      continuationGuidance: workflow.continuationGuidance,
    });

    childProcess.once(
      "exit",
      (code: number | null, signal: NodeJS.Signals | null) => {
        const currentRunPhase = runtimeState.runPhase;
        const nextRunPhase = resolveExitRunPhase(currentRunPhase, {
          code,
          signal,
        });
        const preservesTerminalPhase =
          currentRunPhase != null && nextRunPhase === currentRunPhase;

        if (!preservesTerminalPhase) {
          runtimeState.status = code === 0 && !signal ? "completed" : "failed";
        }
        runtimeState.runPhase = nextRunPhase;

        if (runtimeState.run) {
          if (!preservesTerminalPhase) {
            runtimeState.run.lastError =
              code === 0 && !signal
                ? null
                : `codex app-server exited with ${signal ?? code ?? "unknown"}`;
          }
        }
        void persistSessionTokenUsageArtifact(launcherEnv);
      }
    );
    childProcess.once("error", (error: Error) => {
      runtimeState.status = "failed";
      runtimeState.runPhase = "failed";

      if (runtimeState.run) {
        runtimeState.run.lastError = error.message;
      }
      void persistSessionTokenUsageArtifact(launcherEnv);
    });
  } catch (error) {
    runtimeState.status = "failed";
    runtimeState.runPhase = "failed";

    if (runtimeState.run) {
      runtimeState.run.lastError =
        error instanceof Error ? error.message : "Unknown worker startup error";
    }
    await persistSessionTokenUsageArtifact(launcherEnv);
  }
}

/**
 * Implements the JSON-RPC client side of the codex app-server protocol
 * with multi-turn support, timeouts, and user-input-required detection.
 *
 * Flow:
 * 1. Initialize codex
 * 2. Start thread with prompt + tool definitions
 * 3. Start first turn with rendered prompt
 * 4. Multi-turn loop: on agent turn completion, refresh tracker state,
 *    send continuation turn if issue is still active
 * 5. Exit when max_turns reached, issue non-actionable, or error
 */
async function runCodexClientProtocol(
  child: ReturnType<typeof launchCodexAppServer>,
  plan: CodexRuntimePlan,
  env: NodeJS.ProcessEnv,
  options: {
    continuationGuidance: string | null;
  }
): Promise<void> {
  const renderedPrompt = env.SYMPHONY_RENDERED_PROMPT;
  if (!renderedPrompt) {
    process.stderr.write(
      "[worker] SYMPHONY_RENDERED_PROMPT not set; skipping codex client protocol\n"
    );
    return;
  }

  if (!child.stdin || !child.stdout) {
    process.stderr.write(
      "[worker] codex process has no stdio pipes; cannot run client protocol\n"
    );
    return;
  }

  const { maxTurns, exhaustedBeforeStart } = resolveMaxTurns(
    env.SYMPHONY_MAX_TURNS
  );
  const readTimeoutMs = Number(env.SYMPHONY_READ_TIMEOUT_MS) || 5000;
  const turnTimeoutMs = Number(env.SYMPHONY_TURN_TIMEOUT_MS) || 3600000;
  const maxNonProductiveTurns = resolveMaxNonProductiveTurns(env);
  const issueIdentifier = env.SYMPHONY_ISSUE_IDENTIFIER ?? "";
  const continuationGuidance =
    env.SYMPHONY_CONTINUATION_GUIDANCE ?? options.continuationGuidance;
  const { approvalPolicy, threadSandbox, turnSandboxPolicy } =
    resolveCodexPolicySettings(env);
  let previousTurnProgressSnapshot = {
    ...captureTurnWorkspaceSnapshot(plan.cwd),
    lastError: runtimeState.run?.lastError ?? null,
  };

  // Pipe codex stderr to our stderr for observability
  child.stderr?.pipe(process.stderr);

  // Buffer to accumulate incomplete lines from codex stdout
  let lineBuffer = "";

  // Accumulate streaming delta events so they log as a single line
  let deltaBuffer: { itemId: string; text: string } | null = null;

  function flushDeltaBuffer(): void {
    if (!deltaBuffer) return;
    process.stderr.write(
      `[worker] codex → agent_message [accumulated] ${JSON.stringify({ text: deltaBuffer.text }).slice(0, 500)}\n`
    );
    deltaBuffer = null;
  }

  const pendingRequests = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  // Turn completion signaling
  let turnCompletedResolve: (() => void) | null = null;
  let userInputRequired = false;
  type TurnTerminalFailurePhase = "failed" | "canceled_by_reconciliation";
  let turnTerminalFailurePhase: TurnTerminalFailurePhase | null = null;
  let activeTurnTelemetry: ActiveTurnTelemetry | null = null;
  let consecutiveNonProductiveTurns = 0;
  let convergenceDetected = false;

  function resolvePendingTurnCompletion(): void {
    if (turnCompletedResolve) {
      turnCompletedResolve();
      turnCompletedResolve = null;
    }
  }

  function describeTurnTerminalEvent(
    event: "agent.turnFailed" | "agent.turnCancelled",
    params: unknown
  ): string | null {
    const errorPrefix =
      event === "agent.turnFailed" ? "turn_failed" : "turn_cancelled";
    const fallback =
      event === "agent.turnFailed"
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
        return `${errorPrefix}: ${value.trim()}`;
      }
      if (
        value &&
        typeof value === "object" &&
        typeof (value as Record<string, unknown>).message === "string"
      ) {
        const nested = value as Record<string, unknown>;
        const nestedMessage = String(nested.message).trim();
        if (nestedMessage) {
          return `${errorPrefix}: ${nestedMessage}`;
        }
      }
    }

    const serialized = JSON.stringify(params).slice(0, 300);
    return serialized && serialized !== "{}"
      ? `${errorPrefix}: ${serialized}`
      : fallback;
  }

  function markTurnTerminalFailure(
    runPhase: TurnTerminalFailurePhase,
    lastError: string | null
  ): void {
    runtimeState.status = "failed";
    runtimeState.runPhase = runPhase;
    if (runtimeState.run) {
      runtimeState.run.lastError = lastError;
    }
    turnTerminalFailurePhase = runPhase;
    resolvePendingTurnCompletion();
    if (activeTurnTelemetry) {
      emitTurnFailedEvent(activeTurnTelemetry, lastError);
      activeTurnTelemetry = null;
    }
  }

  function sendMessage(msg: Record<string, unknown>): void {
    const line = JSON.stringify(msg) + "\n";
    child.stdin?.write(line);
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

  /**
   * Send a JSON-RPC request with a read timeout. Rejects with
   * `response_timeout` if no response arrives within the deadline.
   */
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

  /**
   * Wait for the current turn to complete. Returns a promise that resolves
   * when the runtime reports that the active turn completed.
   */
  function waitForTurnCompletion(): Promise<void> {
    return new Promise((resolve) => {
      turnCompletedResolve = resolve;
    });
  }

  /**
   * Wait for turn completion with an absolute timeout. Kills the codex
   * process if the turn exceeds `turn_timeout_ms`.
   */
  function waitForTurnWithTimeout(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        process.stderr.write(
          `[worker] turn_timeout: turn exceeded ${turnTimeoutMs}ms — killing codex process\n`
        );
        if (child.pid) {
          try {
            process.kill(child.pid, "SIGTERM");
          } catch {
            // Already gone.
          }
        }
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

  async function dispatchDynamicToolCall(
    callId: string,
    toolName: string,
    threadId: string,
    turnId: string,
    args: unknown
  ): Promise<void> {
    // Find the tool definition to get command + env
    const toolDef = plan.tools.find(
      (t: RuntimeToolDefinition) => t.name === toolName
    );
    if (!toolDef) {
      process.stderr.write(
        `[worker] unknown dynamic tool: ${toolName}; sending error response\n`
      );
      sendMessage({
        jsonrpc: "2.0",
        method: "dynamic_tool_call_response",
        params: {
          callId,
          threadId,
          turnId,
          contentItems: [
            {
              type: "input_text",
              text: `Tool "${toolName}" is not registered.`,
            },
          ],
          isError: true,
        },
      });
      return;
    }

    const inputJson = JSON.stringify(args ?? {});
    process.stderr.write(
      `[worker] executing dynamic tool "${toolName}" (callId=${callId})\n`
    );

    try {
      const output = await runToolProcess(toolDef, inputJson);
      sendMessage({
        jsonrpc: "2.0",
        method: "dynamic_tool_call_response",
        params: {
          callId,
          threadId,
          turnId,
          contentItems: [{ type: "input_text", text: output }],
          isError: false,
        },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[worker] tool "${toolName}" failed: ${errMsg}\n`);
      sendMessage({
        jsonrpc: "2.0",
        method: "dynamic_tool_call_response",
        params: {
          callId,
          threadId,
          turnId,
          contentItems: [{ type: "input_text", text: errMsg }],
          isError: true,
        },
      });
    }
  }

  function emitObservedAgentEvent(event: AgentEvent): void {
    if (event.payload.suppressUpdate) {
      return;
    }
    emitOrchestratorChannelEvent(getCodexObservabilityEventName(event));
  }

  function handleInputRequired(reason: string, event: AgentEvent): void {
    process.stderr.write(
      "[worker] user_input_required detected — terminating agent process\n"
    );
    userInputRequired = true;
    runtimeState.status = "failed";
    if (runtimeState.run) {
      runtimeState.run.lastError = reason;
    }
    if (child.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    if (activeTurnTelemetry) {
      emitTurnFailedEvent(
        activeTurnTelemetry,
        runtimeState.run?.lastError ?? null
      );
      activeTurnTelemetry = null;
    }
    resolvePendingTurnCompletion();
    emitObservedAgentEvent(event);
  }

  function handleAgentEvent(event: AgentEvent): boolean {
    switch (event.name) {
      case "agent.turnStarted":
        emitObservedAgentEvent(event);
        return true;
      case "agent.toolCallRequested":
        void dispatchDynamicToolCall(
          event.payload.callId,
          event.payload.toolName,
          event.payload.threadId,
          event.payload.turnId,
          event.payload.arguments
        );
        emitObservedAgentEvent(event);
        return true;
      case "agent.inputRequired":
        handleInputRequired(event.payload.reason, event);
        return true;
      case "agent.tokenUsageUpdated": {
        const tokenUsage = extractAbsoluteTokenUsage(event.payload.params);
        if (tokenUsage) {
          applyTokenUsageUpdate(
            getCodexObservabilityEventName(event) ?? event.name,
            tokenUsage
          );
        }
        emitObservedAgentEvent(event);
        return true;
      }
      case "agent.rateLimit": {
        const rateLimits = extractRateLimitPayload(event.payload.params);
        if (rateLimits) {
          applyRateLimitUpdate(
            getCodexObservabilityEventName(event) ?? event.name,
            rateLimits
          );
        }
        emitObservedAgentEvent(event);
        return true;
      }
      case "agent.messageDelta": {
        const { delta, itemId } = event.payload;
        if (deltaBuffer?.itemId !== itemId) {
          flushDeltaBuffer();
          deltaBuffer = { itemId, text: delta };
        } else {
          deltaBuffer.text += delta;
        }
        emitObservedAgentEvent(event);
        return true;
      }
      case "agent.turnCompleted":
        flushDeltaBuffer();
        if (event.payload.inputRequired) {
          handleInputRequired(DEFAULT_AGENT_INPUT_REQUIRED_REASON, event);
          return true;
        }
        emitObservedAgentEvent(event);
        if (activeTurnTelemetry) {
          emitTurnCompletedEvent(activeTurnTelemetry);
          activeTurnTelemetry = null;
        }
        process.stderr.write("[worker] agent turn completed\n");
        resolvePendingTurnCompletion();
        return true;
      case "agent.turnFailed": {
        flushDeltaBuffer();
        const lastError = describeTurnTerminalEvent(
          "agent.turnFailed",
          event.payload.params
        );
        process.stderr.write(
          `[worker] agent turn failed ${JSON.stringify(event.payload.params).slice(0, 300)}\n`
        );
        markTurnTerminalFailure("failed", lastError);
        emitObservedAgentEvent(event);
        return true;
      }
      case "agent.turnCancelled": {
        flushDeltaBuffer();
        const lastError = describeTurnTerminalEvent(
          "agent.turnCancelled",
          event.payload.params
        );
        process.stderr.write(
          `[worker] agent turn cancelled ${JSON.stringify(event.payload.params).slice(0, 300)}\n`
        );
        markTurnTerminalFailure("canceled_by_reconciliation", lastError);
        emitObservedAgentEvent(event);
        return true;
      }
      case "agent.error":
        flushDeltaBuffer();
        process.stderr.write(
          `[worker] runtime error ${JSON.stringify(event.payload.params).slice(0, 300)}\n`
        );
        markTurnTerminalFailure("failed", event.payload.error);
        emitObservedAgentEvent(event);
        return true;
      default:
        return false;
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
    // This powers stall detection in the orchestrator (§4.1.6 last_codex_timestamp).
    runtimeState.lastEventAt = new Date().toISOString();
    const agentEvents = normalizeCodexRuntimeEvents(msg);
    let handledAgentEvent = false;
    for (const event of agentEvents) {
      handledAgentEvent = handleAgentEvent(event) || handledAgentEvent;
    }
    if (handledAgentEvent) {
      return;
    }

    const rateLimits = extractRateLimitPayload(msg.params);
    if (rateLimits && typeof msg.method === "string") {
      applyRateLimitUpdate(msg.method, rateLimits);
    }

    // Log all other server notifications for observability
    if (typeof msg.method === "string") {
      flushDeltaBuffer();
      emitOrchestratorChannelEvent(msg.method);
      process.stderr.write(
        `[worker] codex → ${msg.method} ${JSON.stringify(msg.params ?? {}).slice(0, 300)}\n`
      );
    }
  }

  // Wire up line-delimited JSON parsing from codex stdout
  child.stdout.on("data", (chunk: Buffer) => {
    lineBuffer += chunk.toString("utf8");
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as Record<string, unknown>;
        handleServerMessage(msg);
      } catch {
        // Non-JSON output from codex (e.g. startup logs); ignore
        process.stderr.write(`[worker] codex stdout (non-JSON): ${trimmed}\n`);
      }
    }
  });

  try {
    // Step 1: Initialize
    process.stderr.write("[worker] sending codex initialize\n");
    await sendRequestWithTimeout("init-1", "initialize", {
      clientInfo: { name: "github-symphony", version: "0.1.0" },
      capabilities: {},
    });
    process.stderr.write("[worker] codex initialized\n");

    // Step 2: Notify codex that initialization is complete.
    sendMessage({ jsonrpc: "2.0", method: "initialized", params: {} });

    // Step 3: thread/start with rendered prompt and MCP server tool definitions
    const mcpServers: Record<string, unknown> = {};
    for (const t of plan.tools) {
      mcpServers[t.name] = {
        command: t.command,
        args: t.args,
        env: t.env,
      };
    }

    const baseThreadParams = {
      cwd: plan.cwd,
      developerInstructions: renderedPrompt,
      approvalPolicy,
      sandbox: threadSandbox,
      config: {
        mcp_servers: mcpServers,
      },
    };

    process.stderr.write(
      `[worker] starting codex thread (mcp_servers: ${Object.keys(mcpServers).join(", ")})\n`
    );

    const threadResult = (await sendRequestWithTimeout("thread-1", "thread/start", {
      ...baseThreadParams,
      ephemeral: false,
    })) as Record<string, unknown>;

    const threadId =
      (threadResult.thread_id as string | undefined) ??
      ((threadResult.thread as Record<string, unknown> | undefined)?.id as
        | string
        | undefined);

    runtimeState.sessionInfo.threadId = threadId ?? null;
    runtimeState.sessionInfo.turnId = null;
    runtimeState.sessionInfo.sessionId = null;
    runtimeState.sessionInfo.exitClassification = null;
    runtimeState.sessionId = null;

    process.stderr.write(
      `[worker] codex thread started (id=${String(threadId ?? "unknown")})\n`
    );

    if (!threadId) {
      process.stderr.write(
        "[worker] warning: no threadId returned; cannot start turn\n"
      );
      return;
    }

    // Step 4: Multi-turn loop
    let turnCount = 0;
    let requestIdCounter = 0;

    let maxTurnsReached = exhaustedBeforeStart;
    if (exhaustedBeforeStart) {
      process.stderr.write(
        `[worker] max_turns (${String(env.SYMPHONY_MAX_TURNS ?? maxTurns)}) does not allow any turns for this worker session — exiting\n`
      );
    }

    for (let turn = 0; turn < maxTurns; turn++) {
      turnCount = turn + 1;
      runtimeState.sessionInfo.turnCount = turnCount;
      runtimeState.runPhase = "streaming_turn";
      const isFirstTurn = turn === 0;
      const turnInput = isFirstTurn
        ? renderedPrompt
        : buildContinuationTurnInput({
            continuationGuidance,
            cumulativeTurnCount: turn,
          });

      process.stderr.write(
        `[worker] starting codex turn ${turnCount}/${maxTurns}${isFirstTurn ? " (initial)" : " (continuation)"}\n`
      );

      requestIdCounter += 1;
      const turnRequestId = `turn-${requestIdCounter}`;
      const turnResult = (await sendRequestWithTimeout(
        turnRequestId,
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: turnInput }],
          cwd: plan.cwd,
          title: composeTurnTitle(issueIdentifier, env.SYMPHONY_ISSUE_TITLE),
          approvalPolicy,
          sandboxPolicy: turnSandboxPolicy,
        }
      )) as Record<string, unknown>;

      const turnId =
        (turnResult.turn_id as string | undefined) ??
        ((turnResult.turn as Record<string, unknown> | undefined)?.id as
          | string
          | undefined);
      const sessionId = threadId && turnId ? `${threadId}-${turnId}` : null;
      runtimeState.sessionInfo.turnId = turnId ?? null;
      runtimeState.sessionInfo.sessionId = sessionId;
      runtimeState.sessionId = sessionId;
      activeTurnTelemetry = {
        startedAt: new Date().toISOString(),
        threadId: threadId ?? null,
        turnId: turnId ?? null,
        turnCount,
        sessionId,
        tokenUsageBaseline: cloneTokenUsageSnapshot(),
      };
      process.stderr.write(
        `[worker] codex turn started (id=${String(turnId ?? "unknown")})\n`
      );
      process.stderr.write(
        `[worker] session_id=${String(sessionId ?? "unknown")}\n`
      );
      emitTurnStartedEvent(activeTurnTelemetry);

      // Wait for turn completion with absolute timeout
      await waitForTurnWithTimeout();

      // Check for user_input_required (set by handleServerMessage)
      if (userInputRequired) {
        process.stderr.write("[worker] exiting due to user_input_required\n");
        break;
      }

      if (turnTerminalFailurePhase) {
        process.stderr.write(
          `[worker] exiting due to ${turnTerminalFailurePhase}\n`
        );
        break;
      }

      // Check if we should continue with another turn
      if (turn + 1 >= maxTurns) {
        maxTurnsReached = true;
        process.stderr.write(
          `[worker] max_turns (${maxTurns}) reached for this worker session — exiting\n`
        );
        break;
      }

      // Refresh tracker state to decide whether to continue
      const trackerState = await refreshTrackerState(env);
      process.stderr.write(`[worker] tracker state refresh: ${trackerState}\n`);

      if (trackerState === "non-actionable") {
        runtimeState.runPhase = "finishing";
        runtimeState.executionPhase = resolveFinalExecutionPhase({
          currentPhase: runtimeState.executionPhase,
          trackerState,
          userInputRequired: false,
        });
        process.stderr.write(
          "[worker] issue no longer actionable — exiting multi-turn loop\n"
        );
        break;
      }

      const currentTurnProgressSnapshot = {
        ...captureTurnWorkspaceSnapshot(plan.cwd),
        lastError: runtimeState.run?.lastError ?? null,
      };
      const turnProgress = evaluateTurnProgress(
        previousTurnProgressSnapshot,
        currentTurnProgressSnapshot
      );
      previousTurnProgressSnapshot = currentTurnProgressSnapshot;

      if (turnProgress.nonProductive) {
        consecutiveNonProductiveTurns += 1;
        process.stderr.write(
          `[worker] non-productive turn detected (${consecutiveNonProductiveTurns}/${maxNonProductiveTurns})${turnProgress.reason ? `: ${turnProgress.reason}` : ""}\n`
        );
      } else {
        consecutiveNonProductiveTurns = 0;
      }

      if (consecutiveNonProductiveTurns >= maxNonProductiveTurns) {
        convergenceDetected = true;
        if (runtimeState.run) {
          runtimeState.run.lastError = turnProgress.reason
            ? `convergence_detected: ${turnProgress.reason}`
            : "convergence_detected: repeated non-productive turn results";
        }
        process.stderr.write(
          `[worker] convergence detected after ${consecutiveNonProductiveTurns} non-productive turns — exiting\n`
        );
        break;
      }

      // trackerState is "active" or "unknown" — continue with next turn
    }

    process.stderr.write(
      `[worker] multi-turn loop complete after ${turnCount} turn(s) — exiting worker\n`
    );
    runtimeState.runPhase = "finishing";
    runtimeState.status =
      userInputRequired || turnTerminalFailurePhase ? "failed" : "completed";
    runtimeState.runPhase = convergenceDetected
      ? "failed"
      : userInputRequired
        ? "failed"
        : (turnTerminalFailurePhase ?? "succeeded");
    runtimeState.sessionInfo.exitClassification = classifySessionExit({
      runPhase: runtimeState.runPhase,
      userInputRequired,
      budgetExceeded: false,
      convergenceDetected,
      maxTurnsReached,
    });
    stopOrchestratorHeartbeatTimer();
    emitOrchestratorHeartbeat();
    await persistSessionTokenUsageArtifact(env);
    await waitForPendingOrchestratorChannelFlush(
      resolveTerminalOrchestratorChannelFlushTimeoutMs()
    );

    // Brief delay so orchestrator log capture can flush before exit.
    setTimeout(() => {
      process.exit(userInputRequired || turnTerminalFailurePhase ? 1 : 0);
    }, 1500);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[worker] codex client protocol error: ${errMsg}\n`);
    runtimeState.status = "failed";
    runtimeState.runPhase = "failed";
    if (runtimeState.run) {
      runtimeState.run.lastError = `Codex client protocol error: ${errMsg}`;
    }

    // Map timeout errors to specific categories
    if (errMsg.startsWith("response_timeout:")) {
      runtimeState.runPhase = "stalled";
      if (runtimeState.run) {
        runtimeState.run.lastError = errMsg;
      }
    } else if (errMsg.startsWith("turn_timeout:")) {
      runtimeState.runPhase = "timed_out";
      if (runtimeState.run) {
        runtimeState.run.lastError = errMsg;
      }
    }
    runtimeState.sessionInfo.exitClassification = classifySessionExit({
      runPhase: runtimeState.runPhase,
      userInputRequired: false,
      budgetExceeded: false,
      convergenceDetected: false,
      maxTurnsReached: false,
    });
    if (activeTurnTelemetry) {
      emitTurnFailedEvent(
        activeTurnTelemetry,
        runtimeState.run?.lastError ?? errMsg
      );
      activeTurnTelemetry = null;
    }

    stopOrchestratorHeartbeatTimer();
    emitOrchestratorHeartbeat();
    await persistSessionTokenUsageArtifact(env);
    await waitForPendingOrchestratorChannelFlush(
      resolveTerminalOrchestratorChannelFlushTimeoutMs()
    );

    // Exit worker on protocol failure after flush.
    setTimeout(() => {
      process.exit(1);
    }, 1500);
  }
}

function applyTokenUsageUpdate(
  source: string,
  tokenUsage: TokenUsageSnapshot
): void {
  runtimeState.tokenUsage.inputTokens = tokenUsage.inputTokens;
  runtimeState.tokenUsage.outputTokens = tokenUsage.outputTokens;
  runtimeState.tokenUsage.totalTokens = tokenUsage.totalTokens;
  process.stderr.write(
    `[worker] token_usage source=${source} input=${tokenUsage.inputTokens} output=${tokenUsage.outputTokens} total=${tokenUsage.totalTokens}\n`
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
  process.stderr.write(
    `[worker] rate_limits source=${source} payload=${JSON.stringify(runtimeState.rateLimits).slice(0, 300)}\n`
  );
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

function parseRateLimitRecord(value: unknown): Record<string, unknown> | null {
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

function extractAbsoluteTokenUsage(value: unknown): TokenUsageSnapshot | null {
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

function parseTokenUsageSnapshot(value: unknown): TokenUsageSnapshot | null {
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
      normalizedTotalTokens || normalizedInputTokens + normalizedOutputTokens,
  };
}

/**
 * Refresh tracker state by querying the dashboard state API.
 * Returns "active" if the issue run is still tracked, "non-actionable"
 * if the run is no longer listed, or "unknown" on any failure.
 */
async function refreshTrackerState(
  env: NodeJS.ProcessEnv
): Promise<"active" | "non-actionable" | "unknown"> {
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

/**
 * Run a tool process with the given input (stdin), capture stdout as result.
 */
function runToolProcess(
  toolDef: RuntimeToolDefinition,
  inputJson: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const toolEnv = {
      ...process.env,
      ...toolDef.env,
    };

    const toolProc = spawn(toolDef.command, toolDef.args, {
      env: toolEnv,
      stdio: "pipe",
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    toolProc.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    toolProc.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    toolProc.once("error", (err) => reject(err));
    toolProc.once("exit", (code) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      if (code === 0) {
        resolve(output || "{}");
      } else {
        const errOutput = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new Error(
            `Tool exited with code ${code ?? "unknown"}: ${errOutput || output}`
          )
        );
      }
    });

    toolProc.stdin?.write(inputJson);
    toolProc.stdin?.end();
  });
}
