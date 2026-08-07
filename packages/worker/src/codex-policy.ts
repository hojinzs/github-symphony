/**
 * Keep these values aligned with the Codex contracts used by the worker:
 * string variants of `AskForApproval`, `SandboxMode`, and `SandboxPolicy`
 * from `codex app-server generate-ts`@0.147.0
 * (`v2/AskForApproval.ts`, `v2/SandboxMode.ts`, and
 * `v2/SandboxPolicy.ts`). The granular approval object and structured turn
 * sandbox variants cannot be represented by the current string environment
 * settings, so they are intentionally not accepted here. `codex.command`
 * is user-configurable; update these lists when the targeted Codex protocol
 * changes.
 */
export const APPROVAL_POLICIES = ["never", "on-request", "untrusted"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const THREAD_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
export type ThreadSandboxMode = (typeof THREAD_SANDBOX_MODES)[number];

export const TURN_SANDBOX_POLICY_TYPES = ["dangerFullAccess"] as const;
export type TurnSandboxPolicyType = (typeof TURN_SANDBOX_POLICY_TYPES)[number];
export type TurnSandboxPolicy = { type: TurnSandboxPolicyType } | undefined;
export type CodexPolicyEnv = Partial<
  Record<
    | "SYMPHONY_APPROVAL_POLICY"
    | "SYMPHONY_THREAD_SANDBOX"
    | "SYMPHONY_TURN_SANDBOX_POLICY",
    string | undefined
  >
>;

export type CodexPolicySettings = {
  approvalPolicy: ApprovalPolicy;
  threadSandbox: ThreadSandboxMode;
  turnSandboxPolicy: TurnSandboxPolicy;
};

export function resolveCodexPolicySettings(
  env: CodexPolicyEnv
): CodexPolicySettings {
  const approvalPolicy = resolvePolicyValue(
    env.SYMPHONY_APPROVAL_POLICY,
    "never",
    APPROVAL_POLICIES,
    "SYMPHONY_APPROVAL_POLICY"
  );
  const threadSandbox = resolvePolicyValue(
    env.SYMPHONY_THREAD_SANDBOX,
    "danger-full-access",
    THREAD_SANDBOX_MODES,
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
            TURN_SANDBOX_POLICY_TYPES,
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
