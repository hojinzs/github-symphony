const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_SUBSTRINGS = [
  "authorization",
  "secret",
  "apikey",
  "api-key",
  "api_key",
  "api.key",
  "credential",
  "password",
  "passwd",
  "privatekey",
  "private-key",
  "private_key",
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
  const redacted = redactValue(value, counts, {
    redactStringValues: true,
  }) as T;
  return { value: redacted, redactions: summarizeRedactionCounts(counts) };
}

export function redactObservabilityDiagnosticsWithStats<T>(
  value: T
): RedactionResult<T> {
  const counts = createRedactionCounts();
  const redacted = redactValue(value, counts, {
    redactStringValues: true,
  }) as T;
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
  counts: Map<RedactionClass, number>,
  options: { redactStringValues: boolean }
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, counts, options));
  }

  if (typeof value === "string" && options.redactStringValues) {
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

      return [key, redactValue(nested, counts, options)];
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
    /\b(Authorization\s*[:=]\s*)(?:Bearer\s+|Basic\s+|token\s+)?([^\s,;"'}\]]+)/gi,
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
    /(https?:\/\/)([^\s/@]+@)/gi,
    "secret_key",
    counts,
    "$1[REDACTED]@"
  );
  redacted = replaceAndCount(
    redacted,
    /([?&](?:[^\s&#=]*(?:token|secret|api[-_.]?key|password|passwd|credential|authorization)[^\s&#=]*)=)([^\s&#"'}\]]*)/gi,
    "secret_key",
    counts,
    "$1[REDACTED]"
  );
  redacted = replaceSensitiveKeyAndCount(
    redacted,
    /((?:["'])?\b([A-Za-z0-9_.-]+)(?:["'])?\s*[:=]\s*)(["'])((?:\\.|\3\3|(?!\3)[^\\])*)\3/gi,
    counts,
    "$1$3[REDACTED]$3"
  );
  redacted = replaceSensitiveKeyAndCount(
    redacted,
    /((?:")?\b([A-Za-z0-9_.-]+)(?:")?\s*:\s*)(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=\s*[,}\]])/gi,
    counts,
    '$1"[REDACTED]"'
  );
  redacted = replaceSensitiveKeyAndCount(
    redacted,
    /((?:["'])?\b([A-Za-z0-9_.-]+)(?:["'])?\s*=\s*)(?!["']|\[REDACTED\])([^\s]+?)(?=[,;](?=[A-Za-z0-9_.-]+\s*=)|\s|$)/gi,
    counts,
    "$1[REDACTED]"
  );
  redacted = replaceSensitiveKeyAndCount(
    redacted,
    /((?:["'])?\b([A-Za-z0-9_.-]+)(?:["'])?\s*:\s*)(?!["']|\[REDACTED\])([^\s}\]"']+?)(?=[,;](?=[A-Za-z0-9_.-]+\s*=)|\s|[}\]"']|$)/gi,
    counts,
    "$1[REDACTED]"
  );
  redacted = replaceAndCount(
    redacted,
    /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g,
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
  return redactHighEntropyValues(redacted, counts);
}

function replaceSensitiveKeyAndCount(
  text: string,
  pattern: RegExp,
  counts: Map<RedactionClass, number>,
  replacement: string
): string {
  return text.replace(pattern, (...args: unknown[]) => {
    const matched = typeof args[0] === "string" ? args[0] : "";
    const key = typeof args[2] === "string" ? args[2] : "";
    const redactionClass = redactionClassForKey(key);
    if (!redactionClass || matched.includes(REDACTED)) {
      return matched;
    }

    incrementRedaction(counts, redactionClass);
    return replacement.replace(/\$(\d+)/g, (_placeholder, index: string) => {
      const group = args[Number.parseInt(index, 10)];
      return typeof group === "string" ? group : "";
    });
  });
}

function redactHighEntropyValues(
  text: string,
  counts: Map<RedactionClass, number>
): string {
  return text.replace(
    /[A-Za-z0-9+/_-]{32,}={0,2}/g,
    (candidate, offset: number, source: string) => {
      if (isLikelyFilesystemPath(candidate, source, offset)) {
        return candidate;
      }

      const separatorCount = candidate.match(/[_-]/g)?.length ?? 0;
      if (
        separatorCount > 2 ||
        !/[a-z]/.test(candidate) ||
        !/[A-Z]/.test(candidate) ||
        !/\d/.test(candidate) ||
        shannonEntropy(candidate) < 4
      ) {
        return candidate;
      }

      incrementRedaction(counts, "secret_key");
      return REDACTED;
    }
  );
}

function isLikelyFilesystemPath(
  candidate: string,
  source: string,
  offset: number
): boolean {
  const segments = candidate.split("/");
  if (segments.length < 3) {
    return false;
  }

  const preceding = source[offset - 1] ?? "";
  const startsAtPathBoundary =
    offset === 0 || /[\s([{"'=]/.test(preceding) || preceding === ".";
  if (!startsAtPathBoundary) {
    return false;
  }

  if (candidate.startsWith("/") || preceding === ".") {
    return true;
  }

  return segments.some((segment) => /[-_]/.test(segment));
}

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }

  return Array.from(frequencies.values()).reduce((entropy, frequency) => {
    const probability = frequency / value.length;
    return entropy - probability * Math.log2(probability);
  }, 0);
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
