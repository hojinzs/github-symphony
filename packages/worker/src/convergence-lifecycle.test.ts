import { classifySessionExit } from "@gh-symphony/core";
import { describe, expect, it, vi } from "vitest";
import { resolveConvergenceThresholdAction } from "./convergence-detection.js";
import { resolveFinalExecutionPhase } from "./execution-phase.js";
import {
  refreshTrackerState,
  updateRefreshFailureCount,
} from "./turn-lease.js";

async function runConvergenceThreshold(response: Response) {
  const trackerState = await refreshTrackerState(
    {
      SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
      SYMPHONY_ORCHESTRATOR_TOKEN: "worker-token",
      SYMPHONY_RUN_ID: "run-1",
    },
    ["Ready", "In progress", "Land"],
    vi.fn().mockResolvedValue(response)
  );

  if (resolveConvergenceThresholdAction(trackerState) === "complete") {
    return {
      runPhase: "succeeded",
      executionPhase: resolveFinalExecutionPhase({
        currentPhase: "implementation",
        trackerState,
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

  if (trackerState === "unknown") {
    const refreshFailures = updateRefreshFailureCount(trackerState, 0, 1);
    if (refreshFailures.failClosed) {
      throw new Error("orchestrator_unavailable");
    }
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

async function runTurnBoundary(response: Response) {
  const trackerState = await refreshTrackerState(
    {
      SYMPHONY_ORCHESTRATOR_URL: "http://localhost:4680",
      SYMPHONY_ORCHESTRATOR_TOKEN: "worker-token",
      SYMPHONY_RUN_ID: "run-1",
    },
    ["Ready", "In progress", "Land"],
    vi.fn().mockResolvedValue(response)
  );

  return trackerState === "non-actionable"
    ? {
        action: "complete",
        executionPhase: resolveFinalExecutionPhase({
          currentPhase: "implementation",
          trackerState,
          userInputRequired: false,
        }),
      }
    : { action: "continue", executionPhase: "implementation" };
}

describe("convergence threshold lifecycle", () => {
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
