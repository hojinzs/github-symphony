import {
  resolveCodexPolicySettings,
  type CodexPolicyEnv,
  type CodexPolicySettings,
} from "./codex-policy.js";

export function launchCodexWithValidatedPolicy<T>(
  env: CodexPolicyEnv,
  launch: () => T
): { child: T; policySettings: CodexPolicySettings } {
  const policySettings = resolveCodexPolicySettings(env);

  return {
    child: launch(),
    policySettings,
  };
}
