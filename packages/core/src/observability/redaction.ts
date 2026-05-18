const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_SUBSTRINGS = [
  "authorization",
  "secret",
  "apiKey",
  "api-key",
  "api_key",
];

export type RedactionClass =
  | "authorization_header"
  | "env_token"
  | "api_key"
  | "secret_key";

export type RedactionSummary = {
  class: RedactionClass;
  count: number;
};

export type RedactionResult<T> = {
  value: T;
  redactions: RedactionSummary[];
};

export function redactObservabilitySecrets<T>(value: T): T {
  return redactObservabilitySecretsWithStats(value).value;
}

export function redactObservabilitySecretsWithStats<T>(
  value: T
): RedactionResult<T> {
  const counts = createRedactionCounts();
  const redacted = redactValue(value, counts) as T;
  return { value: redacted, redactions: summarizeRedactionCounts(counts) };
}

export function redactObservabilityText(text: string): string {
  return redactObservabilityTextWithStats(text).value;
}

export function redactObservabilityTextWithStats(
  text: string
): RedactionResult<string> {
  const counts = createRedactionCounts();
  return {
    value: redactTextValue(text, counts),
    redactions: summarizeRedactionCounts(counts),
  };
}

function redactValue(
  value: unknown,
  counts: Map<RedactionClass, number>
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, counts));
  }

  if (typeof value === "string") {
    return redactTextValue(value, counts);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => {
      const redactionClass = redactionClassForKey(key);
      if (redactionClass) {
        incrementRedaction(counts, redactionClass);
        return [key, REDACTED];
      }

      return [key, redactValue(nested, counts)];
    })
  );
}

function redactionClassForKey(key: string): RedactionClass | null {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey.includes("authorization")) {
    return "authorization_header";
  }
  if (
    normalizedKey.includes("apikey") ||
    normalizedKey.includes("api-key") ||
    normalizedKey.includes("api_key")
  ) {
    return "api_key";
  }
  if (normalizedKey.includes("secret")) {
    return "secret_key";
  }
  if (normalizedKey === "token" || normalizedKey.endsWith("token")) {
    return "env_token";
  }
  if (
    SENSITIVE_KEY_SUBSTRINGS.some((pattern) =>
      normalizedKey.includes(pattern.toLowerCase())
    )
  ) {
    return "secret_key";
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function redactTextValue(
  text: string,
  counts: Map<RedactionClass, number>
): string {
  let redacted = replaceAndCount(
    text,
    /\b(Authorization\s*:\s*Bearer\s+)([^\s]+)/gi,
    "authorization_header",
    counts,
    "$1[REDACTED]"
  );
  redacted = replaceAndCount(
    redacted,
    /\b(X-API-Key\s*:\s*)([^\s]+)/gi,
    "api_key",
    counts,
    "$1[REDACTED]"
  );
  redacted = replaceAndCount(
    redacted,
    /^([A-Z0-9_]*(?:TOKEN)\w*\s*=\s*)([^\s]+)/gim,
    "env_token",
    counts,
    "$1[REDACTED]"
  );
  redacted = replaceAndCount(
    redacted,
    /^([A-Z0-9_]*(?:API_KEY)\w*\s*=\s*)([^\s]+)/gim,
    "api_key",
    counts,
    "$1[REDACTED]"
  );
  redacted = replaceAndCount(
    redacted,
    /^([A-Z0-9_]*(?:SECRET)\w*\s*=\s*)([^\s]+)/gim,
    "secret_key",
    counts,
    "$1[REDACTED]"
  );
  redacted = replaceAndCount(
    redacted,
    /\b(token\s*:\s*)([^\s,}\]]+)/gi,
    "env_token",
    counts,
    "$1[REDACTED]"
  );
  redacted = replaceAndCount(
    redacted,
    /\b(secret\s*:\s*)([^\s,}\]]+)/gi,
    "secret_key",
    counts,
    "$1[REDACTED]"
  );
  redacted = replaceAndCount(
    redacted,
    /\b(apiKey\s*:\s*)([^\s,}\]]+)/g,
    "api_key",
    counts,
    "$1[REDACTED]"
  );
  redacted = replaceAndCount(
    redacted,
    /\bghp_[A-Za-z0-9_]+/g,
    "env_token",
    counts,
    "[REDACTED]"
  );
  redacted = replaceAndCount(
    redacted,
    /\blin_[A-Za-z0-9_]+/g,
    "api_key",
    counts,
    "[REDACTED]"
  );
  redacted = replaceAndCount(
    redacted,
    /\bsk-[A-Za-z0-9_-]+/g,
    "api_key",
    counts,
    "[REDACTED]"
  );
  return redacted;
}

function replaceAndCount(
  text: string,
  pattern: RegExp,
  redactionClass: RedactionClass,
  counts: Map<RedactionClass, number>,
  replacement: string
): string {
  return text.replace(pattern, (...args: unknown[]) => {
    const matched = typeof args[0] === "string" ? args[0] : "";
    if (matched.includes(REDACTED)) {
      return matched;
    }
    incrementRedaction(counts, redactionClass);
    return replacement.replace(/\$(\d+)/g, (_placeholder, index: string) => {
      const group = args[Number.parseInt(index, 10)];
      return typeof group === "string" ? group : "";
    });
  });
}

function createRedactionCounts(): Map<RedactionClass, number> {
  return new Map<RedactionClass, number>();
}

function incrementRedaction(
  counts: Map<RedactionClass, number>,
  redactionClass: RedactionClass
): void {
  counts.set(redactionClass, (counts.get(redactionClass) ?? 0) + 1);
}

function summarizeRedactionCounts(
  counts: Map<RedactionClass, number>
): RedactionSummary[] {
  return Array.from(counts.entries())
    .filter(([, count]) => count > 0)
    .map(([redactionClass, count]) => ({ class: redactionClass, count }))
    .sort((left, right) => left.class.localeCompare(right.class));
}
