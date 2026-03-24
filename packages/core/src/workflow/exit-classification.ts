import type { SessionExitClassification } from "../contracts/status-surface.js";
import type { RunAttemptPhase } from "../contracts/run-attempt-phase.js";

export function classifySessionExit(params: {
  runPhase: RunAttemptPhase | null;
  userInputRequired: boolean;
  budgetExceeded: boolean;
  maxTurnsReached: boolean;
}): SessionExitClassification {
  if (params.userInputRequired) {
    return "user-input-required";
  }

  if (params.budgetExceeded) {
    return "budget-exceeded";
  }

  if (params.runPhase === "timed_out" || params.runPhase === "stalled") {
    return "timeout";
  }

  if (params.maxTurnsReached) {
    return "max-turns-reached";
  }

  if (params.runPhase === "succeeded") {
    return "completed";
  }

  return "error";
}
