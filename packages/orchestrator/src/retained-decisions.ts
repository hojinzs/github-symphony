import { scheduleRetryAt, type RetryPolicyOptions } from "@gh-symphony/core";

export type FinalTrackerProgress =
  | { state: "active" | "non-actionable" }
  | {
      state: "unknown";
      reason:
        | "workflow-unavailable"
        | "tracker-item-missing"
        | "tracker-read-failed";
      error: string;
    };

export type FinalizationDisposition =
  | { action: "complete" }
  | {
      action: "defer-finalization";
      consecutiveDeferrals: number;
      exhausted: false;
    }
  | {
      action: "enter-failure/continuation-retry";
      consecutiveDeferrals: number;
      exhausted: boolean;
    };

export function decideFinalizationDisposition(input: {
  trackerProgress: FinalTrackerProgress | null;
  currentDeferralCount: number;
  maxDeferrals: number;
}): FinalizationDisposition {
  if (input.trackerProgress?.state === "non-actionable") {
    return { action: "complete" };
  }
  if (input.trackerProgress?.state !== "unknown") {
    return {
      action: "enter-failure/continuation-retry",
      consecutiveDeferrals: 0,
      exhausted: false,
    };
  }

  const consecutiveDeferrals = input.currentDeferralCount + 1;
  if (consecutiveDeferrals < input.maxDeferrals) {
    return {
      action: "defer-finalization",
      consecutiveDeferrals,
      exhausted: false,
    };
  }
  return {
    action: "enter-failure/continuation-retry",
    consecutiveDeferrals,
    exhausted: true,
  };
}

type RetryKind = "continuation" | "failure";
type PersistedRetryKind = RetryKind | "recovery";

export type CompletedRunRetryDisposition =
  | {
      action: "suppress";
      attempt: number;
      failureRetryCount: number;
      persistedRetryKind: null;
      nextRetryAt: null;
      delayClass: "none";
    }
  | {
      action: "retry";
      attempt: number;
      failureRetryCount: number;
      persistedRetryKind: PersistedRetryKind;
      nextRetryAt: string;
      delayClass: "continuation" | "failure-policy" | "failure-fallback";
    };

export function decideCompletedRunRetry(input: {
  retryKind: RetryKind;
  recoveryPresent: boolean;
  currentAttempt: number;
  durableFailureCount: number;
  maxFailureRetries: number;
  now: Date;
  retryPolicy: RetryPolicyOptions | null;
  defaultFailureBackoffMs: number;
  continuationDelayMs: number;
}): CompletedRunRetryDisposition {
  const failureRetryCount =
    input.durableFailureCount + (input.retryKind === "failure" ? 1 : 0);
  if (
    input.retryKind === "failure" &&
    failureRetryCount >= input.maxFailureRetries
  ) {
    return {
      action: "suppress",
      attempt: input.currentAttempt,
      failureRetryCount,
      persistedRetryKind: null,
      nextRetryAt: null,
      delayClass: "none",
    };
  }

  const persistedRetryKind = input.recoveryPresent
    ? "recovery"
    : input.retryKind;
  const attempt =
    persistedRetryKind === "continuation" ? 1 : input.currentAttempt + 1;
  if (input.recoveryPresent || input.retryKind === "continuation") {
    return {
      action: "retry",
      attempt,
      failureRetryCount,
      persistedRetryKind,
      nextRetryAt: new Date(
        input.now.getTime() + input.continuationDelayMs
      ).toISOString(),
      delayClass: "continuation",
    };
  }

  return {
    action: "retry",
    attempt,
    failureRetryCount,
    persistedRetryKind,
    nextRetryAt: (input.retryPolicy
      ? scheduleRetryAt(input.now, input.currentAttempt + 1, input.retryPolicy)
      : new Date(input.now.getTime() + input.defaultFailureBackoffMs)
    ).toISOString(),
    delayClass: input.retryPolicy ? "failure-policy" : "failure-fallback",
  };
}

export function decideRetryRequeue(input: {
  currentAttempt: number;
  durableFailureCount: number;
  maxFailureRetries: number;
  now: Date;
  countFailure: boolean;
  advanceAttempt: boolean;
  retainedDueAt: string | null;
  pollIntervalMs: number;
  retryPolicy: RetryPolicyOptions | null;
  defaultFailureBackoffMs: number;
}): {
  suppressed: boolean;
  attempt: number;
  failureRetryCount: number;
  nextRetryAt: string | null;
  delayClass:
    | "none"
    | "retained"
    | "poll"
    | "failure-policy"
    | "failure-fallback";
} {
  const attempt = input.currentAttempt + (input.advanceAttempt ? 1 : 0);
  const failureRetryCount =
    input.durableFailureCount + (input.countFailure ? 1 : 0);
  const suppressed =
    input.countFailure && failureRetryCount >= input.maxFailureRetries;
  if (suppressed) {
    return {
      suppressed,
      attempt,
      failureRetryCount,
      nextRetryAt: null,
      delayClass: "none",
    };
  }
  if (!input.advanceAttempt && input.retainedDueAt !== null) {
    return {
      suppressed,
      attempt,
      failureRetryCount,
      nextRetryAt: input.retainedDueAt,
      delayClass: "retained",
    };
  }
  if (!input.advanceAttempt) {
    return {
      suppressed,
      attempt,
      failureRetryCount,
      nextRetryAt: new Date(
        input.now.getTime() + input.pollIntervalMs
      ).toISOString(),
      delayClass: "poll",
    };
  }
  return {
    suppressed,
    attempt,
    failureRetryCount,
    nextRetryAt: (input.retryPolicy
      ? scheduleRetryAt(input.now, attempt, input.retryPolicy)
      : new Date(input.now.getTime() + input.defaultFailureBackoffMs)
    ).toISOString(),
    delayClass: input.retryPolicy ? "failure-policy" : "failure-fallback",
  };
}
