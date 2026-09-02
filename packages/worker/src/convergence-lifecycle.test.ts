import { classifySessionExit } from "@gh-symphony/core";
import { describe, expect, it, vi } from "vitest";
import { resolveFinalExecutionPhase } from "./execution-phase.js";
import {
  refreshTrackerState,
  resolveTrackerRefreshGate,
} from "./turn-lease.js";

async function runConvergenceThreshold(response: Response) {
  const trackerRefresh = await refreshTrackerState(
    {
      SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
      SYMPHONY_ORCHESTRATOR_TOKEN: "worker-token",
      SYMPHONY_RUN_ID: "run-1",
    },
    ["Ready", "In progress", "Land"],
    vi.fn().mockResolvedValue(response)
  );
  const refreshGate = resolveTrackerRefreshGate(
    trackerRefresh.state,
    0,
    1,
    "convergence"
  );

  if (refreshGate.action === "defer") {
    return {
      runPhase: "running",
      executionPhase: "implementation",
      exitClassification: null,
      lastError: null,
    };
  }

  if (refreshGate.action === "complete") {
    return {
      runPhase: "succeeded",
      executionPhase: resolveFinalExecutionPhase({
        currentPhase: "implementation",
        trackerState: "non-actionable",
        userInputRequired: false,
      }),
      exitClassification: classifySessionExit({
        runPhase: "succeeded",
        userInputRequired: false,
        budgetExceeded: false,
        convergenceDetected: false,
        maxTurnsReached: false,
      }),
      lastError: null,
    };
  }

  if (refreshGate.action === "fail-closed") {
    throw new Error("orchestrator_unavailable");
  }

  return {
    runPhase: "failed",
    executionPhase: "implementation",
    exitClassification: classifySessionExit({
      runPhase: "failed",
      userInputRequired: false,
      budgetExceeded: false,
      convergenceDetected: true,
      maxTurnsReached: false,
    }),
    lastError: "convergence_detected: workspace unchanged",
  };
}

async function runTurnBoundary(
  response: Response,
  currentCount = 0,
  activeStates = ["Ready", "In progress", "Land"]
) {
  const trackerRefresh = await refreshTrackerState(
    {
      SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
      SYMPHONY_ORCHESTRATOR_TOKEN: "worker-token",
      SYMPHONY_RUN_ID: "run-1",
    },
    activeStates,
    vi.fn().mockResolvedValue(response)
  );
  const trackerState = trackerRefresh.state;
  const refreshGate = resolveTrackerRefreshGate(trackerState, currentCount, 3);

  return refreshGate.action === "complete"
    ? {
        action: "complete",
        executionPhase: resolveFinalExecutionPhase({
          currentPhase: "implementation",
          trackerState,
          userInputRequired: false,
        }),
      }
    : {
        action: "continue",
        executionPhase: "implementation",
        count: refreshGate.count,
      };
}

describe("convergence threshold lifecycle", () => {
  it("keeps healthy confirmed per-turn refreshes active after dirty work", async () => {
    const healthyLinearRefresh = () =>
      new Response(
        JSON.stringify({
          ok: true,
          outcome: "confirmed",
          state: "In Progress",
          routable: true,
        })
      );

    let currentCount = 0;
    for (let turn = 1; turn <= 4; turn += 1) {
      const result = await runTurnBoundary(
        healthyLinearRefresh(),
        currentCount
      );

      expect(result).toEqual({
        action: "continue",
        executionPhase: "implementation",
        count: 0,
      });
      currentCount = result.count;
    }
  });

  it("maps a confirmed missing Linear issue to a non-actionable stop", async () => {
    await expect(
      runTurnBoundary(
        new Response(
          JSON.stringify({
            ok: true,
            outcome: "confirmed",
            state: "Missing",
            routable: false,
            routableReason: "tracker_issue_snapshot_missing",
          })
        )
      ),
      0,
      ["Missing"]
    ).resolves.toEqual({
      action: "complete",
      executionPhase: "awaiting-merge",
    });
  });

  it("accepts local convergence when tracker reads are permanently unsupported", async () => {
    const unsupported = new Response(
      JSON.stringify({
        ok: false,
        outcome: "rejected",
        error: "tracker_state_requests_unsupported",
      }),
      { status: 403 }
    );

    await expect(runTurnBoundary(unsupported.clone())).resolves.toEqual({
      action: "continue",
      executionPhase: "implementation",
      count: 0,
    });
    await expect(runConvergenceThreshold(unsupported)).resolves.toEqual({
      runPhase: "failed",
      executionPhase: "implementation",
      exitClassification: "convergence-detected",
      lastError: "convergence_detected: workspace unchanged",
    });
  });

  it("completes at the next turn boundary after canonical lifecycle progress", async () => {
    await expect(
      runTurnBoundary(
        new Response(
          JSON.stringify({
            ok: true,
            outcome: "confirmed",
            state: "In review",
            routable: true,
          })
        )
      )
    ).resolves.toEqual({
      action: "complete",
      executionPhase: "awaiting-merge",
    });
  });

  it("completes after confirmed API-side lifecycle progress", async () => {
    await expect(
      runConvergenceThreshold(
        new Response(
          JSON.stringify({
            ok: true,
            outcome: "confirmed",
            state: "Done",
            routable: true,
          })
        )
      )
    ).resolves.toEqual({
      runPhase: "succeeded",
      executionPhase: "awaiting-merge",
      exitClassification: "completed",
      lastError: null,
    });
  });

  it("preserves convergence failure while the item is active", async () => {
    await expect(
      runConvergenceThreshold(
        new Response(
          JSON.stringify({
            ok: true,
            outcome: "confirmed",
            state: "Land",
            routable: true,
          })
        )
      )
    ).resolves.toEqual({
      runPhase: "failed",
      executionPhase: "implementation",
      exitClassification: "convergence-detected",
      lastError: "convergence_detected: workspace unchanged",
    });
  });

  it("classifies unavailable readback as orchestrator failure", async () => {
    await expect(
      runConvergenceThreshold(new Response("unavailable", { status: 503 }))
    ).rejects.toThrow("orchestrator_unavailable");
  });
});
