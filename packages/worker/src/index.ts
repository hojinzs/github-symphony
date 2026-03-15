import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseWorkflowMarkdown,
  type WorkflowExecutionPhase,
} from "@gh-symphony/core";
import {
  launchCodexAppServer,
  prepareCodexRuntimePlan,
  type CodexRuntimePlan,
  type RuntimeToolDefinition,
} from "@gh-symphony/runtime-codex";
import {
  loadLauncherEnvironment,
  resolveLocalRuntimeLaunchConfig,
} from "@gh-symphony/runtime-codex";
import {
  buildWorkerRuntimeState,
  startWorkerStateServer,
} from "./state-server.js";
import {
  resolveFinalExecutionPhase,
  resolveInitialExecutionPhase,
} from "./execution-phase.js";
import { persistTokenUsageArtifact } from "./token-usage.js";

const port = Number(process.env.PORT ?? process.env.SYMPHONY_PORT ?? 4141);
const launcherEnv = loadLauncherEnvironment(process.env);
const runtimeState: {
  status: "idle" | "starting" | "running" | "failed" | "completed";
  executionPhase: WorkflowExecutionPhase | null;
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
  sessionInfo: {
    threadId: string | null;
    turnCount: number;
  };
} = {
  status: launcherEnv.SYMPHONY_RUN_ID ? "starting" : "idle",
  executionPhase: null,
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
  sessionInfo: {
    threadId: null,
    turnCount: 0,
  },
};

const server = startWorkerStateServer({
  port,
  getState: async () =>
    buildWorkerRuntimeState(launcherEnv, undefined, runtimeState),
});

console.log(
  JSON.stringify(
    {
      package: "@gh-symphony/worker",
      runtime: "self-hosted-sample",
      port,
    },
    null,
    2
  )
);

let childProcess: ReturnType<typeof launchCodexAppServer> | null = null;
let shutdownPromise: Promise<void> | null = null;

if (launcherEnv.SYMPHONY_RUN_ID && launcherEnv.WORKING_DIRECTORY) {
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

    await persistTokenUsageArtifact(launcherEnv, runtimeState.tokenUsage);
    server.close(() => {
      console.log(`Worker state server stopped on ${signal}`);
      process.exit(0);
    });
  })();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function startAssignedRun() {
  try {
    const workflowPath = join(launcherEnv.WORKING_DIRECTORY!, "WORKFLOW.md");
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
    config.agentCommand = workflow.codex.command;
    const plan = await prepareCodexRuntimePlan(config);
    childProcess = launchCodexAppServer(plan);
    runtimeState.status = "running";

    if (runtimeState.run) {
      runtimeState.run.processId = childProcess.pid ?? null;
    }

    // Wire up the codex app-server client protocol (multi-turn)
    void runCodexClientProtocol(childProcess, plan, launcherEnv);

    childProcess.once(
      "exit",
      (code: number | null, signal: NodeJS.Signals | null) => {
        runtimeState.status = code === 0 && !signal ? "completed" : "failed";

        if (runtimeState.run) {
          runtimeState.run.lastError =
            code === 0 && !signal
              ? null
              : `codex app-server exited with ${signal ?? code ?? "unknown"}`;
        }
        void persistTokenUsageArtifact(launcherEnv, runtimeState.tokenUsage);
      }
    );
    childProcess.once("error", (error: Error) => {
      runtimeState.status = "failed";

      if (runtimeState.run) {
        runtimeState.run.lastError = error.message;
      }
      void persistTokenUsageArtifact(launcherEnv, runtimeState.tokenUsage);
    });
  } catch (error) {
    runtimeState.status = "failed";

    if (runtimeState.run) {
      runtimeState.run.lastError =
        error instanceof Error ? error.message : "Unknown worker startup error";
    }
    await persistTokenUsageArtifact(launcherEnv, runtimeState.tokenUsage);
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
 * 4. Multi-turn loop: on turn/completed, refresh tracker state,
 *    send continuation turn if issue is still active
 * 5. Exit when max_turns reached, issue non-actionable, or error
 */
async function runCodexClientProtocol(
  child: ReturnType<typeof launchCodexAppServer>,
  plan: CodexRuntimePlan,
  env: NodeJS.ProcessEnv
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

  const maxTurns = Number(env.SYMPHONY_MAX_TURNS) || 20;
  const readTimeoutMs = Number(env.SYMPHONY_READ_TIMEOUT_MS) || 5000;
  const turnTimeoutMs = Number(env.SYMPHONY_TURN_TIMEOUT_MS) || 3600000;

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
   * when `turn/completed` is received from the codex server.
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

    // Server-initiated request (dynamic tool call)
    if (msg.method === "dynamic_tool_call_request" && msg.params != null) {
      const params = msg.params as {
        callId: string;
        tool: string;
        threadId: string;
        turnId: string;
        arguments: unknown;
      };
      void dispatchDynamicToolCall(
        params.callId,
        params.tool,
        params.threadId,
        params.turnId,
        params.arguments
      );
      return;
    }

    // User input required — hard failure (agent cannot proceed autonomously)
    if (
      msg.method === "item/tool/requestUserInput" ||
      (msg.method === "turn/completed" &&
        msg.params != null &&
        (msg.params as Record<string, unknown>).inputRequired === true)
    ) {
      process.stderr.write(
        "[worker] user_input_required detected — terminating codex process\n"
      );
      userInputRequired = true;
      runtimeState.status = "failed";
      if (runtimeState.run) {
        runtimeState.run.lastError =
          "turn_input_required: agent requires user input";
      }
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          // Already gone.
        }
      }
      // Resolve any pending turn completion
      if (turnCompletedResolve) {
        turnCompletedResolve();
        turnCompletedResolve = null;
      }
      return;
    }

    // Turn completed — signal the multi-turn loop
    if (msg.method === "turn/completed") {
      flushDeltaBuffer();
      // Extract token usage from turn completion params if present
      const turnParams = (msg.params ?? {}) as Record<string, unknown>;
      const usage = turnParams.usage as Record<string, unknown> | undefined;
      if (usage) {
        const inputTokens =
          typeof usage.input_tokens === "number"
            ? usage.input_tokens
            : typeof usage.inputTokens === "number"
              ? usage.inputTokens
              : 0;
        const outputTokens =
          typeof usage.output_tokens === "number"
            ? usage.output_tokens
            : typeof usage.outputTokens === "number"
              ? usage.outputTokens
              : 0;
        const totalTokens =
          typeof usage.total_tokens === "number"
            ? usage.total_tokens
            : typeof usage.totalTokens === "number"
              ? usage.totalTokens
              : inputTokens + outputTokens;
        if (inputTokens > 0 || outputTokens > 0 || totalTokens > 0) {
          runtimeState.tokenUsage.inputTokens = inputTokens;
          runtimeState.tokenUsage.outputTokens = outputTokens;
          runtimeState.tokenUsage.totalTokens =
            totalTokens || inputTokens + outputTokens;
        }
      }
      process.stderr.write("[worker] codex turn/completed\n");
      if (turnCompletedResolve) {
        turnCompletedResolve();
        turnCompletedResolve = null;
      }
      return;
    }

    // Token usage events — track cumulative totals
    if (
      msg.method === "thread/tokenUsage/updated" ||
      msg.method === "total_token_usage" ||
      msg.method === "codex/event/token_count"
    ) {
      const params = (msg.params ?? {}) as Record<string, unknown>;

      // codex/event/token_count: { msg: { info: { total_token_usage: { input_tokens, output_tokens, total_tokens } } } }
      const codexMsg = params.msg as Record<string, unknown> | undefined;
      const codexInfo = codexMsg?.info as Record<string, unknown> | undefined;
      const codexTotals = codexInfo?.total_token_usage as
        | Record<string, unknown>
        | undefined;
      const source = codexTotals ?? params;

      const inputTokens =
        typeof source.input_tokens === "number"
          ? source.input_tokens
          : typeof source.inputTokens === "number"
            ? source.inputTokens
            : 0;
      const outputTokens =
        typeof source.output_tokens === "number"
          ? source.output_tokens
          : typeof source.outputTokens === "number"
            ? source.outputTokens
            : 0;
      const totalTokens =
        typeof source.total_tokens === "number"
          ? source.total_tokens
          : typeof source.totalTokens === "number"
            ? source.totalTokens
            : 0;

      // Prefer absolute totals from the event
      if (totalTokens > 0 || inputTokens > 0 || outputTokens > 0) {
        runtimeState.tokenUsage.inputTokens = inputTokens;
        runtimeState.tokenUsage.outputTokens = outputTokens;
        runtimeState.tokenUsage.totalTokens =
          totalTokens || inputTokens + outputTokens;
      }
      return;
    }

    // Accumulate streaming delta events into a single log line per message
    if (
      typeof msg.method === "string" &&
      (msg.method === "codex/event/agent_message_content_delta" ||
        msg.method === "codex/event/agent_message_delta" ||
        msg.method === "item/agentMessage/delta")
    ) {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const delta = typeof params.delta === "string" ? params.delta : "";
      const itemId = typeof params.item_id === "string" ? params.item_id : "";
      if (deltaBuffer?.itemId !== itemId) {
        flushDeltaBuffer();
        deltaBuffer = { itemId, text: delta };
      } else {
        deltaBuffer.text += delta;
      }
      return;
    }

    // Log all other server notifications for observability
    if (typeof msg.method === "string") {
      flushDeltaBuffer();
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

    // Step 2: thread/start with rendered prompt and MCP server tool definitions
    const mcpServers: Record<string, unknown> = {};
    for (const t of plan.tools) {
      mcpServers[t.name] = {
        command: t.command,
        args: t.args,
        env: t.env,
      };
    }

    process.stderr.write(
      `[worker] starting codex thread (mcp_servers: ${Object.keys(mcpServers).join(", ")})`
    );

    const threadResult = (await sendRequestWithTimeout(
      "thread-1",
      "thread/start",
      {
        cwd: plan.cwd,
        developerInstructions: renderedPrompt,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        ephemeral: false,
        config: {
          mcp_servers: mcpServers,
        },
      }
    )) as Record<string, unknown>;

    const threadId =
      (threadResult.thread_id as string | undefined) ??
      ((threadResult.thread as Record<string, unknown> | undefined)?.id as
        | string
        | undefined);

    runtimeState.sessionInfo.threadId = threadId ?? null;

    process.stderr.write(
      `[worker] codex thread started (id=${String(threadId ?? "unknown")})\n`
    );

    if (!threadId) {
      process.stderr.write(
        "[worker] warning: no threadId returned; cannot start turn\n"
      );
      return;
    }

    // Step 3: Multi-turn loop
    let turnCount = 0;
    let requestIdCounter = 0;

    for (let turn = 0; turn < maxTurns; turn++) {
      turnCount = turn + 1;
      runtimeState.sessionInfo.turnCount = turnCount;
      const isFirstTurn = turn === 0;
      const turnInput = isFirstTurn
        ? renderedPrompt
        : "Continue working on the issue. Review your progress and complete any remaining tasks.";

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
          approvalPolicy: "never",
        }
      )) as Record<string, unknown>;

      const turnId =
        (turnResult.turn_id as string | undefined) ??
        ((turnResult.turn as Record<string, unknown> | undefined)?.id as
          | string
          | undefined);
      process.stderr.write(
        `[worker] codex turn started (id=${String(turnId ?? "unknown")})\n`
      );

      // Wait for turn completion with absolute timeout
      await waitForTurnWithTimeout();

      // Check for user_input_required (set by handleServerMessage)
      if (userInputRequired) {
        process.stderr.write("[worker] exiting due to user_input_required\n");
        break;
      }

      // Check if we should continue with another turn
      if (turn + 1 >= maxTurns) {
        process.stderr.write(
          `[worker] max_turns (${maxTurns}) reached — exiting\n`
        );
        break;
      }

      // Refresh tracker state to decide whether to continue
      const trackerState = await refreshTrackerState(env);
      process.stderr.write(`[worker] tracker state refresh: ${trackerState}\n`);

      if (trackerState === "non-actionable") {
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

      // trackerState is "active" or "unknown" — continue with next turn
    }

    process.stderr.write(
      `[worker] multi-turn loop complete after ${turnCount} turn(s) — exiting worker\n`
    );
    runtimeState.status = userInputRequired ? "failed" : "completed";
    await persistTokenUsageArtifact(env, runtimeState.tokenUsage);

    // Brief delay so the state API can serve the final status once.
    setTimeout(() => {
      server.close(() => process.exit(userInputRequired ? 1 : 0));
    }, 1500);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[worker] codex client protocol error: ${errMsg}\n`);
    runtimeState.status = "failed";
    if (runtimeState.run) {
      runtimeState.run.lastError = `Codex client protocol error: ${errMsg}`;
    }

    // Map timeout errors to specific categories
    if (errMsg.startsWith("response_timeout:")) {
      if (runtimeState.run) {
        runtimeState.run.lastError = errMsg;
      }
    } else if (errMsg.startsWith("turn_timeout:")) {
      if (runtimeState.run) {
        runtimeState.run.lastError = errMsg;
      }
    }

    await persistTokenUsageArtifact(env, runtimeState.tokenUsage);

    // Exit worker on protocol failure
    setTimeout(() => {
      server.close(() => process.exit(1));
    }, 1500);
  }
}

/**
 * Refresh tracker state by querying the orchestrator status API.
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
    const response = await fetch(`${orchestratorUrl}/api/v1/status`);
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
