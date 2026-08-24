import {
  resolveWorkflowExecutionPhase,
  type WorkflowExecutionPhase,
} from "@gh-symphony/core";

export type WorkerTrackerState = "active" | "non-actionable" | "unknown";

export function resolveInitialExecutionPhase(input: {
  issueState: string | null | undefined;
  planningStates: string[];
  activeStates: string[];
}): WorkflowExecutionPhase | null {
  return resolveWorkflowExecutionPhase(input);
}

export function resolvePausedExecutionPhase(
  currentPhase: WorkflowExecutionPhase | null
): WorkflowExecutionPhase | null {
  if (currentPhase === "planning") {
    return "human-review";
  }
  if (currentPhase === "implementation") {
    return "awaiting-merge";
  }
  return null;
}

export function resolveFinalExecutionPhase(input: {
  currentPhase: WorkflowExecutionPhase | null;
  trackerState: WorkerTrackerState;
  userInputRequired: boolean;
}): WorkflowExecutionPhase | null {
  if (input.userInputRequired || input.trackerState !== "non-actionable") {
    return input.currentPhase;
  }
  return resolvePausedExecutionPhase(input.currentPhase) ?? input.currentPhase;
}
