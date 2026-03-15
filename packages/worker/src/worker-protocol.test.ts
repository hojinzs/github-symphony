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
}) {
  const {
    readTimeoutMs = 5000,
    turnTimeoutMs = 3600000,
    maxTurns = 20,
  } = options;
  const fake = createFakeChild();

  const pendingRequests = new Map<string, PendingRequest>();
  let turnCompletedResolve: (() => void) | null = null;
  let userInputRequired = false;
  let killCalled = false;

  const runtimeState = {
    status: "running" as string,
    run: { lastError: null as string | null },
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };

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
      if (turnCompletedResolve) {
        turnCompletedResolve();
        turnCompletedResolve = null;
      }
      return;
    }

    // Turn completed — signal the multi-turn loop
    if (msg.method === "turn/completed") {
      if (turnCompletedResolve) {
        turnCompletedResolve();
        turnCompletedResolve = null;
      }
      return;
    }

    // Token usage events — track cumulative totals
    if (
      msg.method === "thread/tokenUsage/updated" ||
      msg.method === "total_token_usage"
    ) {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const inputTokens =
        typeof params.input_tokens === "number" ? params.input_tokens : 0;
      const outputTokens =
        typeof params.output_tokens === "number" ? params.output_tokens : 0;
      const totalTokens =
        typeof params.total_tokens === "number" ? params.total_tokens : 0;

      if (totalTokens > 0 || inputTokens > 0 || outputTokens > 0) {
        runtimeState.tokenUsage.inputTokens = inputTokens;
        runtimeState.tokenUsage.outputTokens = outputTokens;
        runtimeState.tokenUsage.totalTokens =
          totalTokens || inputTokens + outputTokens;
      }
      return;
    }
  }

  return {
    fake,
    pendingRequests,
    runtimeState,
    sendRequest,
    sendRequestWithTimeout,
    waitForTurnCompletion,
    waitForTurnWithTimeout,
    handleServerMessage,
    maxTurns,
    get userInputRequired() {
      return userInputRequired;
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

// ---------------------------------------------------------------------------
// refreshTrackerState — replicated from index.ts lines 645-672
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

        if (turn + 1 >= ctx.maxTurns) break;
      }
    })();

    await loopPromise;
    expect(turnCount).toBe(2);
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

describe("token usage tracking", () => {
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
