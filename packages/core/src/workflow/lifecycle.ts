export type WorkflowLifecycleConfig = {
  stateFieldName: string;
  activeStates: string[];
  terminalStates: string[];
  planningStates: string[];
  /** Normalized required tracker labels; omitted legacy configs are unrestricted. */
  requiredLabels?: string[];
};

export const DEFAULT_WORKFLOW_LIFECYCLE: WorkflowLifecycleConfig = {
  stateFieldName: "Status",
  activeStates: ["Todo", "In Progress"],
  terminalStates: ["Done"],
  planningStates: [],
  requiredLabels: [],
};

export function isStateActive(
  state: string,
  lifecycle: WorkflowLifecycleConfig
): boolean {
  return matchesWorkflowState(state, lifecycle.activeStates);
}

export function isStateTerminal(
  state: string,
  lifecycle: WorkflowLifecycleConfig
): boolean {
  return matchesWorkflowState(state, lifecycle.terminalStates);
}

export function matchesWorkflowState(
  state: string,
  candidates: readonly string[]
): boolean {
  const normalizedState = normalizeWorkflowState(state);
  return candidates.some(
    (candidate) => normalizeWorkflowState(candidate) === normalizedState
  );
}

export function normalizeWorkflowState(state: string): string {
  return state.trim().toLowerCase();
}

export function resolveWorkflowExecutionPhase(input: {
  issueState: string | null | undefined;
  planningStates: readonly string[];
  activeStates: readonly string[];
}): "planning" | "implementation" | null {
  if (!input.issueState) {
    return null;
  }
  if (matchesWorkflowState(input.issueState, input.planningStates)) {
    return "planning";
  }
  if (matchesWorkflowState(input.issueState, input.activeStates)) {
    return "implementation";
  }
  return null;
}
