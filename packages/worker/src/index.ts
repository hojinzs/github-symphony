import { spawn } from "node:child_process";
import {
  launchCodexAppServer,
  prepareCodexRuntimePlan,
  type CodexRuntimePlan,
  type RuntimeToolDefinition,
} from "@github-symphony/runtime-codex";
import {
  loadLauncherEnvironment,
  resolveLocalRuntimeLaunchConfig,
} from "@github-symphony/runtime-codex";
import {
  buildWorkerRuntimeState,
  startWorkerStateServer,
} from "./state-server.js";

const port = Number(process.env.PORT ?? process.env.SYMPHONY_PORT ?? 4141);
const launcherEnv = loadLauncherEnvironment(process.env);
const runtimeState: {
  status: "idle" | "starting" | "running" | "failed" | "completed";
  run: null | {
    runId: string;
    issueId: string | null;
    issueIdentifier: string | null;
    phase: string | null;
    processId: number | null;
    repository: {
      owner: string | null;
      name: string | null;
      cloneUrl: string | null;
      url: string | null;
    };
    lastError: string | null;
  };
} = {
  status: launcherEnv.SYMPHONY_RUN_ID ? "starting" : "idle",
  run: launcherEnv.SYMPHONY_RUN_ID
    ? {
        runId: launcherEnv.SYMPHONY_RUN_ID,
        issueId: launcherEnv.SYMPHONY_ISSUE_ID ?? null,
        issueIdentifier: launcherEnv.SYMPHONY_ISSUE_IDENTIFIER ?? null,
        phase: launcherEnv.SYMPHONY_RUN_PHASE ?? null,
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
};

const server = startWorkerStateServer({
  port,
  getState: async () =>
    buildWorkerRuntimeState(launcherEnv, undefined, runtimeState),
});

console.log(
  JSON.stringify(
    {
      package: "@github-symphony/worker",
      runtime: "self-hosted-sample",
      port,
    },
    null,
    2
  )
);

let childProcess: ReturnType<typeof launchCodexAppServer> | null = null;

if (launcherEnv.SYMPHONY_RUN_ID && launcherEnv.WORKING_DIRECTORY) {
  void startAssignedRun();
}

function shutdown(signal: NodeJS.Signals) {
  if (childProcess?.pid) {
    try {
      process.kill(childProcess.pid, "SIGTERM");
    } catch {
      // Ignore shutdown races.
    }
  }

  server.close(() => {
    console.log(`Worker state server stopped on ${signal}`);
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function startAssignedRun() {
  try {
    const config = resolveLocalRuntimeLaunchConfig(launcherEnv);
    const plan = await prepareCodexRuntimePlan(config);
    childProcess = launchCodexAppServer(plan);
    runtimeState.status = "running";

    if (runtimeState.run) {
      runtimeState.run.processId = childProcess.pid ?? null;
    }

    // Wire up the codex app-server client protocol
    void runCodexClientProtocol(childProcess, plan, launcherEnv);

    childProcess.once("exit", (code, signal) => {
      runtimeState.status = code === 0 && !signal ? "completed" : "failed";

      if (runtimeState.run) {
        runtimeState.run.lastError =
          code === 0 && !signal
            ? null
            : `codex app-server exited with ${signal ?? code ?? "unknown"}`;
      }
    });
    childProcess.once("error", (error) => {
      runtimeState.status = "failed";

      if (runtimeState.run) {
        runtimeState.run.lastError = error.message;
      }
    });
  } catch (error) {
    runtimeState.status = "failed";

    if (runtimeState.run) {
      runtimeState.run.lastError =
        error instanceof Error ? error.message : "Unknown worker startup error";
    }
  }
}

/**
 * Implements the JSON-RPC client side of the codex app-server protocol:
 * 1. Sends initialize
 * 2. After initialize response, sends thread/start with prompt + tool definitions
 * 3. Listens for dynamic_tool_call_request and dispatches to the tool process
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

  // Pipe codex stderr to our stderr for observability
  child.stderr?.pipe(process.stderr);

  // Buffer to accumulate incomplete lines from codex stdout
  let lineBuffer = "";

  const pendingRequests = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

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

  async function dispatchDynamicToolCall(
    callId: string,
    toolName: string,
    threadId: string,
    turnId: string,
    args: unknown
  ): Promise<void> {
    // Find the tool definition to get command + env
    const toolDef = plan.tools.find((t) => t.name === toolName);
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

    // Turn completed — codex has finished its work for this run.
    // Exit the worker so the orchestrator can detect completion and
    // decide whether to retry (continuation) or mark done.
    if (msg.method === "turn/completed") {
      process.stderr.write("[worker] codex turn/completed — exiting worker\n");
      runtimeState.status = "completed";
      // Brief delay so the state API can serve the completed status once.
      setTimeout(() => {
        server.close(() => process.exit(0));
      }, 1500);
      return;
    }

    // Log all server notifications for observability
    if (typeof msg.method === "string") {
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
    await sendRequest("init-1", "initialize", {
      clientInfo: { name: "github-symphony", version: "0.1.0" },
      capabilities: {},
    });
    process.stderr.write("[worker] codex initialized\n");

    // Step 2: thread/start with rendered prompt and MCP server tool definitions
    // The github_graphql tool is registered as an MCP server so codex can call it.
    // Each tool in plan.tools is a shell-command MCP server (stdio transport).
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

    const threadResult = (await sendRequest("thread-1", "thread/start", {
      cwd: plan.cwd,
      developerInstructions: renderedPrompt,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: false,
      config: {
        mcp_servers: mcpServers,
      },
    })) as Record<string, unknown>;

    const threadId =
      (threadResult.thread_id as string | undefined) ??
      ((threadResult.thread as Record<string, unknown> | undefined)?.id as string | undefined);

    process.stderr.write(
      `[worker] codex thread started (id=${String(threadId ?? "unknown")})\n`
    );

    // Step 3: turn/start — send the rendered prompt as user input to begin generation.
    // thread/start only creates the thread; turn/start triggers actual codex execution.
    if (threadId) {
      process.stderr.write("[worker] starting codex turn\n");
      const turnResult = (await sendRequest("turn-1", "turn/start", {
        threadId,
        input: [{ type: "text", text: renderedPrompt }],
        approvalPolicy: "never",
      })) as Record<string, unknown>;
      const turnId =
        (turnResult.turn_id as string | undefined) ??
        ((turnResult.turn as Record<string, unknown> | undefined)?.id as string | undefined);
      process.stderr.write(`[worker] codex turn started (id=${String(turnId ?? "unknown")})\n`);
    } else {
      process.stderr.write("[worker] warning: no threadId returned; cannot start turn\n");
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[worker] codex client protocol error: ${errMsg}\n`);
    runtimeState.status = "failed";
    if (runtimeState.run) {
      runtimeState.run.lastError = `Codex client protocol error: ${errMsg}`;
    }
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
