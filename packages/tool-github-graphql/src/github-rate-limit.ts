import { createHash } from "node:crypto";
import { TrackerRateLimitError } from "@gh-symphony/core";

const DEFAULT_SOFT_THRESHOLD = 100;
const DEFAULT_HARD_THRESHOLD = 0;
const DEFAULT_MAX_WAIT_MS = 60_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;

export type GitHubGraphQLRateLimitGuardOptions = {
  softThreshold?: number;
  hardThreshold?: number;
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type GitHubRateLimitState = Record<string, unknown> & {
  remaining?: number | null;
  reset?: number | null;
  resetAt?: string | null;
};

export type GraphQLRateLimitField = {
  cost: number;
  remaining: number;
  resetAt: string;
};

export type GitHubRateLimitPayload = {
  source: "github";
  limit: number | null;
  remaining: number | null;
  used: number | null;
  reset: number | null;
  resetAt: string | null;
  resource: string | null;
  cost?: number;
  cycleCost?: number;
  queryCosts?: Record<
    string,
    {
      requestCount: number;
      cost: number;
    }
  >;
  fieldRateLimits?: GraphQLRateLimitField;
  headerRateLimits?: GitHubRateLimitHeaderPayload | null;
};

export type GitHubRateLimitHeaderPayload = Omit<
  GitHubRateLimitPayload,
  "cost" | "cycleCost" | "queryCosts" | "fieldRateLimits" | "headerRateLimits"
>;

export type GitHubGraphQLAttemptResult<
  T,
  TRateLimits extends GitHubRateLimitState = GitHubRateLimitState,
> =
  | {
      ok: true;
      value: T;
      rateLimits: TRateLimits | null;
    }
  | {
      ok: false;
      status: number;
      details: string;
      rateLimits: TRateLimits | null;
      retryAfterMs: number | null;
      rateLimited: boolean;
    };

export class GitHubGraphQLRateLimitError extends TrackerRateLimitError {
  readonly name = "GitHubGraphQLRateLimitError";

  constructor(
    message: string,
    readonly status: number | null,
    readonly details: string,
    rateLimits: GitHubRateLimitState | null,
    readonly retryAfterMs: number | null,
    retryAt: string | null
  ) {
    super(message, rateLimits, retryAt);
  }
}

export class GitHubGraphQLRateLimitPolicy {
  private readonly states = new Map<string, GitHubRateLimitState | null>();
  private readonly queueTails = new Map<string, Promise<void>>();

  constructor(
    private readonly options: GitHubGraphQLRateLimitGuardOptions & {
      retryAttempts?: number;
      retryBaseMs?: number;
    } = {}
  ) {}

  get(tokenKey: string): GitHubRateLimitState | null {
    return this.states.get(tokenKey) ?? null;
  }

  set(tokenKey: string, state: GitHubRateLimitState | null): void {
    this.states.set(tokenKey, state);
  }

  async execute<
    T,
    TRateLimits extends GitHubRateLimitState = GitHubRateLimitState,
  >(
    tokenKey: string,
    attempt: () => Promise<GitHubGraphQLAttemptResult<T, TRateLimits>>
  ): Promise<GitHubGraphQLAttemptResult<T, TRateLimits>> {
    return this.runSerialized(tokenKey, async () => {
      await guardGraphQLRateLimit(this, tokenKey);

      const retryAttempts =
        this.options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
      for (let retry = 0; retry < retryAttempts; retry += 1) {
        const result = await attempt();
        this.states.set(tokenKey, result.rateLimits);
        if (result.ok || !result.rateLimited) {
          return result;
        }

        const error = this.buildRateLimitError(result);
        if (retry + 1 >= retryAttempts) {
          throw error;
        }

        const delayMs = this.resolveRetryDelay(error, retry);
        if (delayMs === null) {
          throw error;
        }
        await this.sleep(delayMs);
      }

      throw new Error("GitHub GraphQL rate-limit retry loop exhausted");
    });
  }

  reset(): void {
    this.states.clear();
    this.queueTails.clear();
  }

  async guard(tokenKey: string): Promise<void> {
    const rateLimits = this.states.get(tokenKey) ?? null;
    const waited = await guardGitHubGraphQLRateLimitState(rateLimits, {
      softThreshold: this.options.softThreshold,
      hardThreshold: this.options.hardThreshold,
      maxWaitMs: this.options.maxWaitMs,
      now: () => this.now(),
      sleep: (ms) => this.sleep(ms),
    });
    if (waited) {
      this.states.delete(tokenKey);
    }
  }

  private buildRateLimitError(
    result: Extract<GitHubGraphQLAttemptResult<unknown>, { ok: false }>
  ): GitHubGraphQLRateLimitError {
    const retryAfterAtMs =
      result.retryAfterMs === null ? null : this.now() + result.retryAfterMs;
    const remaining = finiteNumber(result.rateLimits?.remaining);
    const hardThreshold = this.options.hardThreshold ?? DEFAULT_HARD_THRESHOLD;
    const primaryResetAtMs =
      remaining !== null && remaining <= hardThreshold
        ? resolveResetAtMs(result.rateLimits)
        : null;
    const retryAtMs = maxNullable(primaryResetAtMs, retryAfterAtMs);
    return new GitHubGraphQLRateLimitError(
      `GitHub GraphQL rate limited request with status ${result.status}`,
      result.status,
      result.details,
      result.rateLimits,
      result.retryAfterMs,
      toIsoTimestamp(retryAtMs)
    );
  }

  private resolveRetryDelay(
    error: GitHubGraphQLRateLimitError,
    retry: number
  ): number | null {
    const retryBaseMs = this.options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    const exponentialMs = Math.min(this.maxWaitMs(), retryBaseMs * 2 ** retry);
    const retryAtMs = parseTimestampMs(error.retryAt);
    const providerWaitMs =
      retryAtMs === null ? 0 : Math.max(0, retryAtMs - this.now());
    const delayMs = Math.max(exponentialMs, providerWaitMs);
    return delayMs <= this.maxWaitMs() ? delayMs : null;
  }

  private async runSerialized<T>(
    tokenKey: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.queueTails.get(tokenKey) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.queueTails.set(tokenKey, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.queueTails.get(tokenKey) === tail) {
        this.queueTails.delete(tokenKey);
      }
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private maxWaitMs(): number {
    return this.options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  private sleep(ms: number): Promise<void> {
    return (this.options.sleep ?? defaultSleep)(ms);
  }
}

export const githubGraphQLRateLimitPolicy = new GitHubGraphQLRateLimitPolicy();

export async function guardGitHubGraphQLRateLimitState(
  rateLimits: GitHubRateLimitState | null | undefined,
  options: GitHubGraphQLRateLimitGuardOptions = {}
): Promise<boolean> {
  if (!rateLimits) {
    return false;
  }

  const remaining = finiteNumber(rateLimits.remaining);
  const softThreshold = options.softThreshold ?? DEFAULT_SOFT_THRESHOLD;
  if (remaining === null || remaining > softThreshold) {
    return false;
  }

  const resetAtMs = resolveResetAtMs(rateLimits);
  const hardThreshold = options.hardThreshold ?? DEFAULT_HARD_THRESHOLD;
  if (resetAtMs === null) {
    if (remaining <= hardThreshold) {
      throw buildGuardError(rateLimits, null);
    }
    return false;
  }

  const now = options.now ?? Date.now;
  const waitMs = Math.max(0, resetAtMs - now());
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  if (waitMs > maxWaitMs) {
    if (remaining <= hardThreshold) {
      throw buildGuardError(rateLimits, resetAtMs);
    }
    return false;
  }

  if (waitMs > 0) {
    await (options.sleep ?? defaultSleep)(waitMs);
    return true;
  }

  return false;
}

export function guardGraphQLRateLimit(
  policy: GitHubGraphQLRateLimitPolicy,
  tokenKey: string
): Promise<void> {
  return policy.guard(tokenKey);
}

function buildGuardError(
  rateLimits: GitHubRateLimitState,
  retryAtMs: number | null
): GitHubGraphQLRateLimitError {
  return new GitHubGraphQLRateLimitError(
    "GitHub GraphQL rate limit near exhaustion",
    null,
    "Cached GitHub GraphQL rate limit is exhausted.",
    rateLimits,
    null,
    toIsoTimestamp(retryAtMs)
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function fingerprintGitHubToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function extractGitHubRateLimits(
  headers: Pick<Headers, "get"> | null | undefined,
  fieldRateLimits: GraphQLRateLimitField | null = null
): GitHubRateLimitPayload | null {
  const headerRateLimits = extractGitHubRateLimitHeaders(headers);
  if (!fieldRateLimits) {
    return headerRateLimits;
  }

  return {
    source: "github",
    limit: headerRateLimits?.limit ?? null,
    remaining: fieldRateLimits.remaining,
    used: headerRateLimits?.used ?? null,
    reset: headerRateLimits?.reset ?? null,
    resetAt: fieldRateLimits.resetAt,
    resource: headerRateLimits?.resource ?? "graphql",
    cost: fieldRateLimits.cost,
    fieldRateLimits,
    headerRateLimits,
  };
}

export function extractGraphQLRateLimitField(
  value: unknown
): GraphQLRateLimitField | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const cost = finiteNumber(record.cost);
  const remaining = finiteNumber(record.remaining);
  const resetAt = record.resetAt;
  if (
    cost === null ||
    remaining === null ||
    typeof resetAt !== "string" ||
    parseTimestampMs(resetAt) === null
  ) {
    return null;
  }

  return { cost, remaining, resetAt };
}

function extractGitHubRateLimitHeaders(
  headers: Pick<Headers, "get"> | null | undefined
): GitHubRateLimitHeaderPayload | null {
  if (!headers || typeof headers.get !== "function") {
    return null;
  }

  const limit = parseIntegerHeader(headers.get("x-ratelimit-limit"));
  const remaining = parseIntegerHeader(headers.get("x-ratelimit-remaining"));
  const used = parseIntegerHeader(headers.get("x-ratelimit-used"));
  const reset = parseIntegerHeader(headers.get("x-ratelimit-reset"));
  const resource = headers.get("x-ratelimit-resource");

  if (
    limit === null &&
    remaining === null &&
    used === null &&
    reset === null &&
    resource === null
  ) {
    return null;
  }

  return {
    source: "github",
    limit,
    remaining,
    used,
    reset,
    resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    resource,
  };
}

export function isGitHubRateLimitResponse(
  status: number,
  details: string,
  headers: Pick<Headers, "get"> | null | undefined
): boolean {
  if (status === 429) {
    return true;
  }
  if (status !== 403) {
    return false;
  }

  const remaining = finiteNumber(headers?.get("x-ratelimit-remaining"));
  if (remaining === 0 || headers?.get("retry-after")) {
    return true;
  }

  const normalizedDetails = details.toLowerCase();
  return (
    normalizedDetails.includes("rate limit") ||
    normalizedDetails.includes("abuse detection")
  );
}

export function parseGitHubRetryAfterMs(
  value: string | null,
  now: number = Date.now()
): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  const retryAtMs = Date.parse(value);
  return Number.isFinite(retryAtMs) ? Math.max(0, retryAtMs - now) : null;
}

function resolveResetAtMs(
  rateLimits: GitHubRateLimitState | null
): number | null {
  if (!rateLimits) {
    return null;
  }
  return (
    parseTimestampMs(
      typeof rateLimits.resetAt === "string" ? rateLimits.resetAt : null
    ) ??
    (typeof rateLimits.reset === "number" ? rateLimits.reset * 1_000 : null)
  );
}

function parseIntegerHeader(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestampMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function maxNullable(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Math.max(left, right);
}

function toIsoTimestamp(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}
