export type TrackerCredentialPreflightResult =
  | { ok: true }
  | { ok: false; reason: string };

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function remediation(env: NodeJS.ProcessEnv): string {
  const projectEnv = env.SYMPHONY_PROJECT_DIR?.trim();
  const projectEnvHint = projectEnv
    ? `Add the credential to ${projectEnv}/.env`
    : "Add the credential to the managed project .env";

  return `${projectEnvHint}, or authenticate the daemon environment and restart it.`;
}

/**
 * Verifies the credential available at the worker host boundary before an
 * agent runtime is launched. Tracker adapters own credential selection; this
 * guard only rejects an incomplete effective environment for hosted trackers.
 */
export function resolveTrackerCredentialPreflight(
  env: NodeJS.ProcessEnv
): TrackerCredentialPreflightResult {
  const adapter = env.SYMPHONY_TRACKER_ADAPTER?.trim().toLowerCase();

  if (adapter === "linear") {
    if (hasValue(env.LINEAR_AUTHORIZATION) || hasValue(env.LINEAR_API_KEY)) {
      return { ok: true };
    }

    return {
      ok: false,
      reason:
        "Worker Linear credential preflight failed: LINEAR_AUTHORIZATION or LINEAR_API_KEY is required. " +
        remediation(env),
    };
  }

  if (adapter === "github-project" || adapter === "github") {
    const hasDirectToken = hasValue(env.GITHUB_GRAPHQL_TOKEN);
    const hasCompleteBroker =
      hasValue(env.GITHUB_TOKEN_BROKER_URL) &&
      hasValue(env.GITHUB_TOKEN_BROKER_SECRET);
    if (hasDirectToken || hasCompleteBroker) {
      return { ok: true };
    }

    return {
      ok: false,
      reason:
        "Worker GitHub credential preflight failed: GITHUB_GRAPHQL_TOKEN or both GITHUB_TOKEN_BROKER_URL and GITHUB_TOKEN_BROKER_SECRET are required. " +
        remediation(env),
    };
  }

  return { ok: true };
}
