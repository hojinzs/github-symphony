/**
 * Stub Worker — Simulates a Symphony worker without a real AI runtime.
 *
 * Controlled via the STUB_SCENARIO env var:
 *   happy (default) — starting(2s) → running(5s) → completed, exit 0
 *   fail            — starting(2s) → running(3s) → failed, exit 1
 *   stall           — starting(2s) → running(∞), waits for SIGTERM
 *   slow            — starting(2s) → running(30s) → completed, exit 0
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// ── Environment ──────────────────────────────────────────────────

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
const sessionInfo = {
  threadId: "stub-thread",
  turnId: "stub-turn",
  turnCount: 1,
  sessionId: "stub-thread-stub-turn",
};

function emitOrchestratorEvent(event: string): void {
  if (!ISSUE_ID || !lastEventAt) {
    return;
  }

  console.error(
    JSON.stringify({
      type: "codex_update",
      issueId: ISSUE_ID,
      event,
      lastEventAt,
      tokenUsage,
      sessionInfo,
      executionPhase: status === "running" ? "implementation" : null,
      runPhase: status === "running" ? "streaming_turn" : status === "failed" ? "failed" : null,
      lastError: status === "failed" ? "Stub worker simulated failure" : null,
    })
  );
}

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

  console.error(`[stub-worker] scenario=${SCENARIO} runId=${RUN_ID}`);

  // Starting phase
  status = "starting";
  lastEventAt = new Date().toISOString();
  console.error(`[stub-worker] status=starting`);
  emitOrchestratorEvent("starting");
  await sleep(durations.startMs);

  // Running phase
  status = "running";
  lastEventAt = new Date().toISOString();
  console.error(`[stub-worker] status=running`);
  emitOrchestratorEvent("running");
  await sleep(durations.runMs);

  // Terminal phase
  if (SCENARIO === "fail") {
    status = "failed";
    lastEventAt = new Date().toISOString();
    console.error(`[stub-worker] status=failed`);
    emitOrchestratorEvent("failed");
    await saveTokenArtifact();
    process.exit(1);
  } else {
    status = "completed";
    lastEventAt = new Date().toISOString();
    console.error(`[stub-worker] status=completed`);
    emitOrchestratorEvent("completed");
    await saveTokenArtifact();
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
    process.exit(0);
  });
}

process.on("SIGTERM", () => handleSignal("SIGTERM"));
process.on("SIGINT", () => handleSignal("SIGINT"));

// ── Start ────────────────────────────────────────────────────────

run();
