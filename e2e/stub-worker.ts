/**
 * Stub Worker — Simulates a Symphony worker without a real AI runtime.
 *
 * Controlled via the STUB_SCENARIO env var:
 *   happy (default) — starting(2s) → running(5s) → completed, exit 0
 *   fail            — starting(2s) → running(3s) → failed, exit 1
 *   stall           — starting(2s) → running(∞), waits for SIGTERM
 *   slow            — starting(2s) → running(30s) → completed, exit 0
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ── Environment ──────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? process.env.SYMPHONY_PORT ?? "4601");
const RUN_ID = process.env.SYMPHONY_RUN_ID ?? "unknown";
const ISSUE_ID = process.env.SYMPHONY_ISSUE_ID ?? null;
const ISSUE_IDENTIFIER = process.env.SYMPHONY_ISSUE_IDENTIFIER ?? null;
const ISSUE_STATE = process.env.SYMPHONY_ISSUE_STATE ?? null;
const WORKSPACE_RUNTIME_DIR = process.env.WORKSPACE_RUNTIME_DIR ?? "/tmp/stub-worker";
type Scenario = "happy" | "fail" | "stall" | "slow";
const VALID_SCENARIOS: ReadonlySet<string> = new Set(["happy", "fail", "stall", "slow"]);
const rawScenario = process.env.STUB_SCENARIO ?? "happy";
const SCENARIO: Scenario = VALID_SCENARIOS.has(rawScenario)
  ? (rawScenario as Scenario)
  : (() => {
      console.error(`[stub-worker] unknown STUB_SCENARIO="${rawScenario}", falling back to "happy"`);
      return "happy" as Scenario;
    })();

const SCENARIO_DURATIONS: Record<Scenario, { startMs: number; runMs: number }> = {
  happy: { startMs: 2000, runMs: 5000 },
  fail: { startMs: 2000, runMs: 3000 },
  stall: { startMs: 2000, runMs: Infinity },
  slow: { startMs: 2000, runMs: 30000 },
};

// ── State ────────────────────────────────────────────────────────

type WorkerStatus = "idle" | "starting" | "running" | "failed" | "completed";

let status: WorkerStatus = "idle";
let lastEventAt: string | null = null;
const tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function buildState() {
  return {
    package: "@gh-symphony/stub-worker",
    runtime: "self-hosted-sample",
    status,
    executionPhase: status === "running" ? "implementation" : null,
    runPhase: status === "running" ? "streaming_turn" : null,
    sessionId: null,
    projectId: null,
    workspaceRuntimeDir: WORKSPACE_RUNTIME_DIR,
    run: {
      runId: RUN_ID,
      issueId: ISSUE_ID,
      issueIdentifier: ISSUE_IDENTIFIER,
      state: ISSUE_STATE,
      processId: process.pid,
      repository: {
        owner: null,
        name: null,
        cloneUrl: null,
        url: null,
      },
      lastError: status === "failed" ? "Stub worker simulated failure" : null,
    },
    tokenUsage,
    lastEventAt,
    workflow: null,
  };
}

// ── HTTP Server ──────────────────────────────────────────────────

function handleRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.url === "/api/v1/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildState()));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

const server = createServer(handleRequest);

// ── Lifecycle ────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms)) {
    return new Promise(() => {}); // never resolves (stall)
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveTokenArtifact() {
  tokenUsage.inputTokens = 150;
  tokenUsage.outputTokens = 42;
  tokenUsage.totalTokens = 192;

  try {
    await mkdir(WORKSPACE_RUNTIME_DIR, { recursive: true });
    await writeFile(
      join(WORKSPACE_RUNTIME_DIR, "token-usage.json"),
      JSON.stringify(tokenUsage, null, 2),
    );
  } catch {
    // best-effort
  }
}

async function run() {
  const durations = SCENARIO_DURATIONS[SCENARIO];

  console.error(`[stub-worker] scenario=${SCENARIO} port=${PORT} runId=${RUN_ID}`);

  // Starting phase
  status = "starting";
  lastEventAt = new Date().toISOString();
  console.error(`[stub-worker] status=starting`);
  await sleep(durations.startMs);

  // Running phase
  status = "running";
  lastEventAt = new Date().toISOString();
  console.error(`[stub-worker] status=running`);
  await sleep(durations.runMs);

  // Terminal phase
  if (SCENARIO === "fail") {
    status = "failed";
    lastEventAt = new Date().toISOString();
    console.error(`[stub-worker] status=failed`);
    await saveTokenArtifact();
    server.close();
    process.exit(1);
  } else {
    status = "completed";
    lastEventAt = new Date().toISOString();
    console.error(`[stub-worker] status=completed`);
    await saveTokenArtifact();
    server.close();
    process.exit(0);
  }
}

// ── Graceful Shutdown ────────────────────────────────────────────

let shuttingDown = false;

function handleSignal(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[stub-worker] received ${signal}, shutting down gracefully`);

  saveTokenArtifact().finally(() => {
    server.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => handleSignal("SIGTERM"));
process.on("SIGINT", () => handleSignal("SIGINT"));

// ── Start ────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.error(`[stub-worker] listening on port ${PORT}`);
  run();
});
