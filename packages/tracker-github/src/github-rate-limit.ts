import { TrackerRateLimitError } from "@gh-symphony/core";

const DEFAULT_SOFT_THRESHOLD = 100;
const DEFAULT_HARD_THRESHOLD = 0;
const DEFAULT_MAX_WAIT_MS = 60_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;

export type GitHubRateLimitState = Record<string, unknown> & {
  remaining?: number | null;
  reset?: number | null;
  resetAt?: string | null;
};

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
    private readonly options: {
      softThreshold?: number;
      hardThreshold?: number;
      maxWaitMs?: number;
      retryAttempts?: number;
      retryBaseMs?: number;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
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
      await this.guard(tokenKey);

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

  private async guard(tokenKey: string): Promise<void> {
    const rateLimits = this.states.get(tokenKey) ?? null;
    if (!rateLimits) {
      return;
    }

    const remaining = finiteNumber(rateLimits.remaining);
    const softThreshold = this.options.softThreshold ?? DEFAULT_SOFT_THRESHOLD;
    if (remaining === null || remaining > softThreshold) {
      return;
    }

    const resetAtMs = resolveResetAtMs(rateLimits);
    const hardThreshold = this.options.hardThreshold ?? DEFAULT_HARD_THRESHOLD;
    if (resetAtMs === null) {
      if (remaining <= hardThreshold) {
        throw this.buildGuardError(rateLimits, null);
      }
      return;
    }

    const waitMs = Math.max(0, resetAtMs - this.now());
    if (waitMs > this.maxWaitMs()) {
      if (remaining <= hardThreshold) {
        throw this.buildGuardError(rateLimits, resetAtMs);
      }
      return;
    }

    this.states.delete(tokenKey);
    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
  }

  private buildGuardError(
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
    const sleepImpl =
      this.options.sleep ??
      ((delayMs: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    return sleepImpl(ms);
  }
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
