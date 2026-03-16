export const RUN_ATTEMPT_PHASES = [
  "preparing_workspace",
  "building_prompt",
  "launching_agent",
  "initializing_session",
  "streaming_turn",
  "finishing",
  "succeeded",
  "failed",
  "timed_out",
  "stalled",
  "canceled_by_reconciliation",
] as const;

export type RunAttemptPhase = (typeof RUN_ATTEMPT_PHASES)[number];

export function isRunAttemptPhase(value: unknown): value is RunAttemptPhase {
  return (
    typeof value === "string" &&
    RUN_ATTEMPT_PHASES.includes(value as RunAttemptPhase)
  );
}
