import {
  guardGitHubGraphQLRateLimitState,
  type GitHubRateLimitState,
} from "@gh-symphony/tool-github-graphql";

export function extractToolRateLimitPayload(
  output: string
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const rateLimits = parsed.rateLimits;
  return isRecord(rateLimits) ? { ...rateLimits } : null;
}

export function guardDynamicToolRateLimit(
  toolName: string,
  rateLimits: Record<string, unknown> | null,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<boolean> {
  if (
    toolName !== "github_graphql" ||
    !isRecord(rateLimits) ||
    rateLimits.source !== "github" ||
    (rateLimits.resource !== undefined && rateLimits.resource !== "graphql")
  ) {
    return Promise.resolve(false);
  }

  return guardGitHubGraphQLRateLimitState(
    rateLimits as GitHubRateLimitState,
    options
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
