export type RetryPolicyOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
};

const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;

export function calculateRetryDelay(
  attempt: number,
  options: RetryPolicyOptions = {}
): number {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const normalizedAttempt = Math.max(1, attempt);
  const delay = baseDelayMs * 2 ** (normalizedAttempt - 1);

  return Math.min(delay, maxDelayMs);
}

export function scheduleRetryAt(
  now: Date,
  attempt: number,
  options: RetryPolicyOptions = {}
): Date {
  return new Date(now.getTime() + calculateRetryDelay(attempt, options));
}
