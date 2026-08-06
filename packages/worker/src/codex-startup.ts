import {
  resolveCodexPolicySettings,
  type CodexPolicyEnv,
  type CodexPolicySettings,
} from "./codex-policy.js";

export async function launchCodexWithValidatedPolicy<T>(
  env: CodexPolicyEnv,
  launch: () => T,
  onPolicyValidationFailure: (message: string) => Promise<void>
): Promise<{ child: T; policySettings: CodexPolicySettings } | null> {
  let policySettings: CodexPolicySettings;
  try {
    policySettings = resolveCodexPolicySettings(env);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown policy validation error";
    await onPolicyValidationFailure(
      `Codex policy validation failed: ${message}`
    );
    return null;
  }

  return {
    child: launch(),
    policySettings,
  };
}
