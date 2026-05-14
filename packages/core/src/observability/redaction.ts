const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_SUBSTRINGS = [
  "authorization",
  "secret",
  "apiKey",
  "api-key",
  "api_key",
];

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
  const normalizedKey = key.toLowerCase();
  return (
    normalizedKey === "token" ||
    normalizedKey.endsWith("token") ||
    SENSITIVE_KEY_SUBSTRINGS.some((pattern) =>
      normalizedKey.includes(pattern.toLowerCase())
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}
