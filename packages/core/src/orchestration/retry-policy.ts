import {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  type RetryPolicyOptions
} from "../workflow/config.js";

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
