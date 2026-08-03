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
  redacted = redactYamlBlockScalars(redacted, counts);
  redacted = replaceSensitiveKeyAndCount(
    redacted,
    /(^|\r?\n)([ \t]*)(-\s+)?([A-Za-z0-9_.-]+)(\s*:\s+)(?!["']|\[REDACTED\])([^\r\n]*?\S)([ \t]+#.*)?(?=\r?\n|$)/gm,
    counts,
    "$1$2$3$4$5[REDACTED]$7",
    4
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
  replacement: string,
  keyGroupIndex = 2
): string {
  return text.replace(pattern, (...args: unknown[]) => {
    const matched = typeof args[0] === "string" ? args[0] : "";
    const key =
      typeof args[keyGroupIndex] === "string" ? args[keyGroupIndex] : "";
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

  if (preceding === ".") {
    return true;
  }

  const pathSegments = candidate.startsWith("/") ? segments.slice(1) : segments;
  if (pathSegments.some(isReadableFilesystemSegment)) {
    return true;
  }

  const pathContext = source.slice(Math.max(0, offset - 80), offset);
  if (
    /\b(?:artifact|cwd|directory|file|path|repo(?:sitory)?|workspace|working\s+directory)\s*(?:is|at|=|:)?\s*$/i.test(
      pathContext
    )
  ) {
    return true;
  }

  return false;
}

function isReadableFilesystemSegment(segment: string): boolean {
  if (
    segment.length > 24 ||
    !/^[A-Za-z0-9._-]+$/.test(segment) ||
    /\d/.test(segment)
  ) {
    return false;
  }

  return /[a-z]{3,}/.test(segment) || /[A-Z]{3,}/.test(segment);
}

type TextLine = {
  content: string;
  ending: "" | "\n" | "\r\n";
};

function redactYamlBlockScalars(
  text: string,
  counts: Map<RedactionClass, number>
): string {
  const lines = splitTextLines(text);

  for (let index = 0; index < lines.length; index += 1) {
    const match =
      /^([ \t]*)(-\s+)?([A-Za-z0-9_.-]+)(\s*:\s+)(?!["']|\[REDACTED\])([|>])(?:[-+]?\d?)([ \t]+#.*)?$/.exec(
        lines[index].content
      );
    if (!match) {
      continue;
    }

    const redactionClass = redactionClassForKey(match[3]);
    if (!redactionClass) {
      continue;
    }

    const headerIndent = match[1].length;
    let end = index + 1;
    let hasPayload = false;
    while (end < lines.length) {
      const content = lines[end].content;
      const indentation = content.match(/^[ \t]*/)?.[0].length ?? 0;
      if (content.trim() === "") {
        const nextContent = lines[end + 1]?.content ?? "";
        const nextIndentation = nextContent.match(/^[ \t]*/)?.[0].length ?? 0;
        if (nextContent.trim() !== "" && nextIndentation <= headerIndent) {
          break;
        }
        end += 1;
        continue;
      }
      if (indentation <= headerIndent) {
        break;
      }
      hasPayload = true;
      end += 1;
    }

    incrementRedaction(counts, redactionClass);
    lines[index] = {
      content: `${match[1]}${match[2] ?? ""}${match[3]}${match[4]}${REDACTED}${match[6] ?? ""}`,
      ending: lines[index].ending,
    };
    if (hasPayload || end > index + 1) {
      lines.splice(index + 1, end - index - 1);
    }
  }

  return lines.map((line) => `${line.content}${line.ending}`).join("");
}

function splitTextLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      lines.push({ content: text.slice(start), ending: "" });
      return lines;
    }

    const hasCarriageReturn = newline > start && text[newline - 1] === "\r";
    lines.push({
      content: text.slice(start, hasCarriageReturn ? newline - 1 : newline),
      ending: hasCarriageReturn ? "\r\n" : "\n",
    });
    start = newline + 1;
  }

  if (text.length === 0 || text.endsWith("\n")) {
    lines.push({ content: "", ending: "" });
  }
  return lines;
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
