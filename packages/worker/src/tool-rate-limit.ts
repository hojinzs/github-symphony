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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
