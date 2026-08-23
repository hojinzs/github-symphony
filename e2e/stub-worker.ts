/**
 * Stub Worker — Simulates a Symphony worker without a real AI runtime.
 *
 * Controlled via the STUB_SCENARIO env var:
 *   happy (default) — starting(2s) → running(5s) → completed, exit 0
 *   fail            — starting(2s) → running(3s) → failed, exit 1
 *   stall           — starting(2s) → running(∞), waits for SIGTERM
 *   slow            — starting(2s) → running(30s) → completed, exit 0
 *   prompt-phase    — validates the rendered planning phase, then completes
 *   transition-race — requests Ready → In review, then stalls for reconciliation
 *   api-progress    — requests Ready → Done, confirms readback, then completes
 *   api-progress-unknown — confirms Done, removes the canonical item, then completes
 */

import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ── Environment ──────────────────────────────────────────────────

const RUN_ID = process.env.SYMPHONY_RUN_ID ?? "unknown";
const ISSUE_ID = process.env.SYMPHONY_ISSUE_ID ?? null;
const ISSUE_IDENTIFIER = process.env.SYMPHONY_ISSUE_IDENTIFIER ?? null;
const ISSUE_STATE = process.env.SYMPHONY_ISSUE_STATE ?? null;
const RENDERED_PROMPT = process.env.SYMPHONY_RENDERED_PROMPT ?? "";
const WORKSPACE_RUNTIME_DIR =
  process.env.WORKSPACE_RUNTIME_DIR ?? "/tmp/stub-worker";
type Scenario =
  | "happy"
  | "fail"
  | "stall"
  | "slow"
  | "prompt-phase"
  | "transition-race"
  | "api-progress"
  | "api-progress-unknown";
const VALID_SCENARIOS: ReadonlySet<string> = new Set([
  "happy",
  "fail",
  "stall",
  "slow",
  "prompt-phase",
  "transition-race",
  "api-progress",
  "api-progress-unknown",
]);
const rawScenario = process.env.STUB_SCENARIO ?? "happy";
const SCENARIO: Scenario = VALID_SCENARIOS.has(rawScenario)
  ? (rawScenario as Scenario)
  : (() => {
      console.error(
        `[stub-worker] unknown STUB_SCENARIO="${rawScenario}", falling back to "happy"`
      );
      return "happy" as Scenario;
    })();

const SCENARIO_DURATIONS: Record<Scenario, { startMs: number; runMs: number }> =
  {
    happy: { startMs: 2000, runMs: 5000 },
    fail: { startMs: 2000, runMs: 3000 },
    stall: { startMs: 2000, runMs: Infinity },
    slow: { startMs: 2000, runMs: 30000 },
    "prompt-phase": { startMs: 500, runMs: 500 },
    "transition-race": { startMs: 2000, runMs: Infinity },
    "api-progress": { startMs: 2000, runMs: 1000 },
    "api-progress-unknown": { startMs: 2000, runMs: 1000 },
  };

function resolveCoreModuleUrl(): string {
  const workerPath = process.argv[1];
  if (!workerPath) {
    throw new Error("stub_worker_path_unavailable");
  }
  const workerDir = dirname(resolve(workerPath));
  for (const root of [
    workerDir,
    resolve(workerDir, ".."),
    resolve(workerDir, "../.."),
  ]) {
    const corePath = join(root, "packages/core/dist/index.js");
    if (existsSync(corePath)) {
      return pathToFileURL(corePath).href;
    }
  }
  throw new Error(`stub_core_module_not_found:${workerPath}`);
}

const ORCHESTRATOR_URL = process.env.SYMPHONY_ORCHESTRATOR_URL ?? "";
const ORCHESTRATOR_TOKEN = process.env.SYMPHONY_ORCHESTRATOR_TOKEN ?? "";

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
      runPhase:
        status === "running"
          ? "streaming_turn"
          : status === "failed"
            ? "failed"
            : status === "completed"
              ? "succeeded"
              : null,
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
      JSON.stringify(tokenUsage, null, 2)
    );
  } catch {
    // best-effort
  }
}

async function requestTransitionForRace(): Promise<void> {
  if (!ORCHESTRATOR_URL || !ORCHESTRATOR_TOKEN || !RUN_ID) {
    throw new Error("stub_worker_orchestrator_context_missing");
  }

  const expectedState = ISSUE_STATE ?? "Ready";
  const targetState = "In review";
  const commentBody = [
    `🔁 Status: \`${expectedState}\` → \`${targetState}\``,
    "",
    "Reason: E2E transition comment race",
    "Cycle: e2e transition-race",
  ].join("\n");
  const response = await fetch(`${ORCHESTRATOR_URL}/api/v1/tracker-state`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-symphony-run-id": RUN_ID,
      "x-symphony-orchestrator-token": ORCHESTRATOR_TOKEN,
    },
    body: JSON.stringify({
      type: "transition-request",
      expected_state: expectedState,
      target_state: targetState,
      reason: "E2E transition comment race",
      comment_body: commentBody,
    }),
  });
  const payload = (await response.json()) as {
    ok?: boolean;
    outcome?: string;
    state?: string | null;
    error?: string | null;
  };
  console.error(
    `[stub-worker] transition response status=${response.status} payload=${JSON.stringify(payload)}`
  );
  if (!response.ok || payload.ok !== true || payload.outcome !== "confirmed") {
    throw new Error(
      `stub_transition_failed:${payload.error ?? payload.outcome ?? response.status}`
    );
  }
}

async function requestAndConfirmApiProgress(): Promise<void> {
  if (!ORCHESTRATOR_URL || !ORCHESTRATOR_TOKEN || !RUN_ID) {
    throw new Error("stub_worker_orchestrator_context_missing");
  }

  const expectedState = ISSUE_STATE ?? "Ready";
  const transitionResponse = await fetch(
    `${ORCHESTRATOR_URL}/api/v1/tracker-state`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-symphony-run-id": RUN_ID,
        "x-symphony-orchestrator-token": ORCHESTRATOR_TOKEN,
      },
      body: JSON.stringify({
        type: "transition-request",
        expected_state: expectedState,
        target_state: "Done",
        reason: "E2E API-side lifecycle progress",
      }),
    }
  );
  const transition = (await transitionResponse.json()) as {
    ok?: boolean;
    outcome?: string;
    state?: string | null;
  };
  if (
    !transitionResponse.ok ||
    transition.ok !== true ||
    transition.outcome !== "confirmed" ||
    transition.state !== "Done"
  ) {
    throw new Error(
      `stub_api_progress_transition_failed:${JSON.stringify(transition)}`
    );
  }

  const readResponse = await fetch(`${ORCHESTRATOR_URL}/api/v1/tracker-state`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-symphony-run-id": RUN_ID,
      "x-symphony-orchestrator-token": ORCHESTRATOR_TOKEN,
    },
    body: JSON.stringify({ type: "state-read" }),
  });
  const readback = (await readResponse.json()) as {
    ok?: boolean;
    outcome?: string;
    state?: string | null;
  };
  console.error(
    `[stub-worker] api-progress readback status=${readResponse.status} payload=${JSON.stringify(readback)}`
  );
  if (
    !readResponse.ok ||
    readback.ok !== true ||
    readback.outcome !== "confirmed" ||
    readback.state !== "Done"
  ) {
    throw new Error(
      `stub_api_progress_readback_failed:${JSON.stringify(readback)}`
    );
  }
}

async function removeCanonicalTrackerItem(): Promise<void> {
  const issuesPath = process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH;
  if (!issuesPath) {
    throw new Error("stub_file_tracker_issues_path_missing");
  }
  await writeFile(issuesPath, "[]\n", "utf8");
  console.error("[stub-worker] api-progress canonical item removed");
}

async function run() {
  const durations = SCENARIO_DURATIONS[SCENARIO];

  console.error(`[stub-worker] scenario=${SCENARIO} runId=${RUN_ID}`);
  if (
    SCENARIO === "prompt-phase" &&
    !RENDERED_PROMPT.includes("phase=planning")
  ) {
    throw new Error(
      `stub_prompt_phase_missing:${JSON.stringify(RENDERED_PROMPT)}`
    );
  }
  // Record the starting event before loading the runtime dependency so a
  // resolution failure remains observable in both local and Docker E2E runs.
  status = "starting";
  lastEventAt = new Date().toISOString();
  console.error(`[stub-worker] status=starting`);
  emitOrchestratorEvent("starting");

  // Local and Docker builds emit the worker into different directories; find
  // the built core package relative to the emitted worker rather than /app.
  const { composeMcpServers } = (await import(resolveCoreModuleUrl())) as {
    composeMcpServers: (options: {
      repositoryDir: string;
      projectDir?: string;
    }) => Record<string, unknown>;
  };
  const mcpServers = composeMcpServers({
    repositoryDir: process.env.WORKING_DIRECTORY ?? process.cwd(),
    projectDir: process.env.SYMPHONY_PROJECT_DIR,
  });
  console.error(
    `[stub-worker] mcp_servers=${Object.keys(mcpServers).sort().join(",")}`
  );

  await sleep(durations.startMs);

  // Running phase
  status = "running";
  lastEventAt = new Date().toISOString();
  console.error(`[stub-worker] status=running`);
  emitOrchestratorEvent("running");
  if (SCENARIO === "transition-race") {
    await requestTransitionForRace();
  }
  if (
    SCENARIO === "api-progress" ||
    SCENARIO === "api-progress-unknown" ||
    SCENARIO === "prompt-phase"
  ) {
    await requestAndConfirmApiProgress();
  }
  if (SCENARIO === "api-progress-unknown") {
    await removeCanonicalTrackerItem();
  }
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
