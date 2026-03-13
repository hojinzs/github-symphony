export type WorkflowLifecycleConfig = {
  stateFieldName: string;
  activeStates: string[];
  terminalStates: string[];
  blockerCheckStates: string[];
};

export const DEFAULT_WORKFLOW_LIFECYCLE: WorkflowLifecycleConfig = {
  stateFieldName: "Status",
  activeStates: ["Todo", "In Progress"],
  terminalStates: ["Done"],
  blockerCheckStates: ["Todo"],
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
  return candidates.some((candidate) => normalizeWorkflowState(candidate) === normalizedState);
}

export function normalizeWorkflowState(state: string): string {
  return state.trim().toLowerCase();
}
