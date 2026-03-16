import type { RunAttemptPhase } from "@gh-symphony/core";

const TERMINAL_RUN_PHASES = new Set<RunAttemptPhase>([
  "succeeded",
  "failed",
  "timed_out",
  "stalled",
  "canceled_by_reconciliation",
]);

export function resolveExitRunPhase(
  currentRunPhase: RunAttemptPhase | null,
  exit: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }
): RunAttemptPhase {
  if (currentRunPhase && TERMINAL_RUN_PHASES.has(currentRunPhase)) {
    return currentRunPhase;
  }

  return exit.code === 0 && !exit.signal ? "succeeded" : "failed";
}
