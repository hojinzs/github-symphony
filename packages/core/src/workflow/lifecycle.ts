export type WorkflowLifecycleConfig = {
  stateFieldName: string;
  planningStates: string[];
  humanReviewStates: string[];
  implementationStates: string[];
  awaitingMergeStates: string[];
  completedStates: string[];
  planningCompleteState: string;
  implementationCompleteState: string;
  mergeCompleteState: string;
};

export type WorkflowExecutionPhase =
  | "planning"
  | "human-review"
  | "implementation"
  | "awaiting-merge"
  | "completed"
  | "unknown";

export const DEFAULT_WORKFLOW_LIFECYCLE: WorkflowLifecycleConfig = {
  stateFieldName: "Status",
  planningStates: ["Todo"],
  humanReviewStates: ["Plan Review"],
  implementationStates: ["In Progress"],
  awaitingMergeStates: ["In Review"],
  completedStates: ["Done"],
  planningCompleteState: "Plan Review",
  implementationCompleteState: "In Review",
  mergeCompleteState: "Done"
};

export function resolveWorkflowExecutionPhase(
  state: string,
  lifecycle: WorkflowLifecycleConfig
): WorkflowExecutionPhase {
  if (matchesWorkflowState(state, lifecycle.planningStates)) {
    return "planning";
  }

  if (matchesWorkflowState(state, lifecycle.humanReviewStates)) {
    return "human-review";
  }

  if (matchesWorkflowState(state, lifecycle.implementationStates)) {
    return "implementation";
  }

  if (matchesWorkflowState(state, lifecycle.awaitingMergeStates)) {
    return "awaiting-merge";
  }

  if (matchesWorkflowState(state, lifecycle.completedStates)) {
    return "completed";
  }

  return "unknown";
}

export function isWorkflowPhaseActionable(phase: WorkflowExecutionPhase): boolean {
  return phase === "planning" || phase === "implementation";
}

export function isWorkflowPhaseTerminal(phase: WorkflowExecutionPhase): boolean {
  return phase === "completed";
}

export function isWorkflowStateActionable(
  state: string,
  lifecycle: WorkflowLifecycleConfig
): boolean {
  return isWorkflowPhaseActionable(resolveWorkflowExecutionPhase(state, lifecycle));
}

export function matchesWorkflowState(
  state: string,
  candidates: readonly string[]
): boolean {
  const normalizedState = normalizeWorkflowState(state);
  return candidates.some((candidate) => normalizeWorkflowState(candidate) === normalizedState);
}

export function normalizeWorkflowState(state: string): string {
  return state.trim().toLowerCase();
}
