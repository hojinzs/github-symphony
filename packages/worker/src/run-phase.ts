import type { RunAttemptPhase } from "@gh-symphony/core";

const TERMINAL_RUN_PHASES = new Set<RunAttemptPhase>([
  "succeeded",
  "failed",
  "timed_out",
  "stalled",
  "canceled_by_reconciliation",
]);

export function isTerminalRunPhase(
  runPhase: RunAttemptPhase | null
): runPhase is RunAttemptPhase {
  return runPhase !== null && TERMINAL_RUN_PHASES.has(runPhase);
}

export function resolveExitRunPhase(
  currentRunPhase: RunAttemptPhase | null,
  exit: {
    code: number | null;
    signal: NodeJS.Signals | null;
  }
): RunAttemptPhase {
  if (isTerminalRunPhase(currentRunPhase)) {
    return currentRunPhase;
  }

  return exit.code === 0 && !exit.signal ? "succeeded" : "failed";
}
