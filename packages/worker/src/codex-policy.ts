export const APPROVAL_POLICIES = [
  "never",
  "on-failure",
  "on-request",
  "untrusted",
] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const SANDBOX_POLICIES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
export type SandboxPolicyType = (typeof SANDBOX_POLICIES)[number];
export type TurnSandboxPolicy = { type: SandboxPolicyType } | undefined;
type CodexPolicyEnv = Partial<
  Record<
    | "SYMPHONY_APPROVAL_POLICY"
    | "SYMPHONY_THREAD_SANDBOX"
    | "SYMPHONY_TURN_SANDBOX_POLICY",
    string | undefined
  >
>;

export function resolveCodexPolicySettings(env: CodexPolicyEnv): {
  approvalPolicy: ApprovalPolicy;
  threadSandbox: SandboxPolicyType;
  turnSandboxPolicy: TurnSandboxPolicy;
} {
  const approvalPolicy = resolvePolicyValue(
    env.SYMPHONY_APPROVAL_POLICY,
    "never",
    APPROVAL_POLICIES,
    "SYMPHONY_APPROVAL_POLICY"
  );
  const threadSandbox = resolvePolicyValue(
    env.SYMPHONY_THREAD_SANDBOX,
    "danger-full-access",
    SANDBOX_POLICIES,
    "SYMPHONY_THREAD_SANDBOX"
  );

  return {
    approvalPolicy,
    threadSandbox,
    turnSandboxPolicy: env.SYMPHONY_TURN_SANDBOX_POLICY
      ? {
          type: resolvePolicyValue(
            env.SYMPHONY_TURN_SANDBOX_POLICY,
            undefined,
            SANDBOX_POLICIES,
            "SYMPHONY_TURN_SANDBOX_POLICY"
          ),
        }
      : undefined,
  };
}

function resolvePolicyValue<const T extends readonly string[]>(
  value: string | undefined,
  defaultValue: T[number] | undefined,
  allowedValues: T,
  variableName: string
): T[number] {
  const resolvedValue = value || defaultValue;

  if (resolvedValue && allowedValues.includes(resolvedValue)) {
    return resolvedValue;
  }

  throw new Error(
    `Invalid ${variableName} value ${JSON.stringify(resolvedValue)}. ` +
      `Expected one of: ${allowedValues.join(", ")}.`
  );
}
