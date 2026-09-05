const CODEX_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT",
] as const;

type AgentRuntimeEnvSource = Record<string, string | undefined>;

export function extractEnvForCodex(
  env: AgentRuntimeEnvSource
): Record<string, string> {
  return pickRuntimeEnv(env, CODEX_ENV_KEYS);
}

function pickRuntimeEnv(
  env: AgentRuntimeEnvSource,
  keys: ReadonlyArray<string>
): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const key of keys) {
    const value = env[key];
    if (value) {
      resolved[key] = value;
    }
  }

  return resolved;
}
