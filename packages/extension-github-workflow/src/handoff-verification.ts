import type { WorkflowExecutionPhase } from "@gh-symphony/core";

export type HandoffVerificationInput = {
  runId: string;
  issueIdentifier: string;
  phase: WorkflowExecutionPhase;
  expectedTransition: string | null;
  actualState: string | null;
};

export type HandoffVerificationResult = {
  verified: boolean;
  runId: string;
  issueIdentifier: string;
  phase: WorkflowExecutionPhase;
  expectedTransition: string | null;
  actualState: string | null;
  error: string | null;
};

/**
 * Verify that after a run completes, the expected handoff mutation
 * actually occurred. If the expected state transition did not happen,
 * record an operator-visible handoff failure.
 *
 * This is called by the GitHub workflow extension after a run exits to
 * check that the runtime tool actually performed the expected GitHub
 * Project state transition.
 */
export function verifyHandoff(
  input: HandoffVerificationInput
): HandoffVerificationResult {
  if (!input.expectedTransition) {
    return {
      verified: true,
      runId: input.runId,
      issueIdentifier: input.issueIdentifier,
      phase: input.phase,
      expectedTransition: null,
      actualState: input.actualState,
      error: null,
    };
  }

  if (!input.actualState) {
    return {
      verified: false,
      runId: input.runId,
      issueIdentifier: input.issueIdentifier,
      phase: input.phase,
      expectedTransition: input.expectedTransition,
      actualState: null,
      error: `Handoff verification failed: expected transition to "${input.expectedTransition}" but actual state is unknown.`,
    };
  }

  const verified = input.actualState === input.expectedTransition;
  return {
    verified,
    runId: input.runId,
    issueIdentifier: input.issueIdentifier,
    phase: input.phase,
    expectedTransition: input.expectedTransition,
    actualState: input.actualState,
    error: verified
      ? null
      : `Handoff verification failed: expected "${input.expectedTransition}" but found "${input.actualState}".`,
  };
}

export type HandoffRepairAction = {
  kind: "retry" | "force-transition" | "operator-required";
  description: string;
};

/**
 * Suggest repair actions when handoff verification fails.
 */
export function suggestHandoffRepair(
  result: HandoffVerificationResult
): HandoffRepairAction {
  if (result.verified) {
    return { kind: "retry", description: "No repair needed." };
  }

  if (!result.actualState) {
    return {
      kind: "operator-required",
      description: `Cannot determine current state for ${result.issueIdentifier}. Operator intervention required.`,
    };
  }

  return {
    kind: "force-transition",
    description: `Issue ${result.issueIdentifier} is in "${result.actualState}" but expected "${result.expectedTransition}". Force transition or investigate.`,
  };
}
