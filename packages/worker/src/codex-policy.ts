export type TurnSandboxPolicy = { type: string } | undefined;
type CodexPolicyEnv = Partial<
  Record<
    | "SYMPHONY_APPROVAL_POLICY"
    | "SYMPHONY_THREAD_SANDBOX"
    | "SYMPHONY_TURN_SANDBOX_POLICY",
    string | undefined
  >
>;

export function resolveCodexPolicySettings(
  env: CodexPolicyEnv
): {
  approvalPolicy: string;
  threadSandbox: string;
  turnSandboxPolicy: TurnSandboxPolicy;
} {
  return {
    approvalPolicy: env.SYMPHONY_APPROVAL_POLICY || "never",
    threadSandbox: env.SYMPHONY_THREAD_SANDBOX || "danger-full-access",
    turnSandboxPolicy: env.SYMPHONY_TURN_SANDBOX_POLICY
      ? { type: env.SYMPHONY_TURN_SANDBOX_POLICY }
      : undefined,
  };
}
