const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN =
  /(^|_|\b)(authorization|linear_api_key|github_graphql_token|token|api_key|secret)(_|$|\b)/i;

export function redactObservabilitySecrets<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      shouldRedactKey(key) ? REDACTED : redactValue(nested),
    ])
  );
}

function shouldRedactKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}
