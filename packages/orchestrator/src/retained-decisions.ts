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
      reason: Extract<FinalTrackerProgress, { state: "unknown" }>["reason"];
      error: string;
    }
  | {
      action: "record-exhausted-deferral";
      consecutiveDeferrals: number;
      reason: Extract<FinalTrackerProgress, { state: "unknown" }>["reason"];
      error: string;
    }
  | { action: "retry" };

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
      action: "retry",
    };
  }

  const consecutiveDeferrals = input.currentDeferralCount + 1;
  if (consecutiveDeferrals < input.maxDeferrals) {
    return {
      action: "defer-finalization",
      consecutiveDeferrals,
      reason: input.trackerProgress.reason,
      error: input.trackerProgress.error,
    };
  }
  return {
    action: "record-exhausted-deferral",
    consecutiveDeferrals,
    reason: input.trackerProgress.reason,
    error: input.trackerProgress.error,
  };
}

type RetryKind = "continuation" | "failure";
type PersistedRetryKind = RetryKind | "recovery";

export type CompletedRunRetryPlan =
  | {
      action: "suppress";
      attempt: number;
      failureRetryCount: number;
      persistedRetryKind: null;
      delayClass: "none";
    }
  | {
      action: "retry";
      attempt: number;
      failureRetryCount: number;
      persistedRetryKind: PersistedRetryKind;
      delayClass: "continuation" | "failure";
    };

export function planCompletedRunRetry(input: {
  retryKind: RetryKind;
  recoveryPresent: boolean;
  currentAttempt: number;
  durableFailureCount: number;
  maxFailureRetries: number;
}): CompletedRunRetryPlan {
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
      delayClass: "continuation",
    };
  }

  return {
    action: "retry",
    attempt,
    failureRetryCount,
    persistedRetryKind,
    delayClass: "failure",
  };
}

export function resolveCompletedRunRetry(
  plan: CompletedRunRetryPlan,
  input: {
    now: Date;
    retryPolicy: RetryPolicyOptions | null;
    defaultFailureBackoffMs: number;
    continuationDelayMs: number;
  }
) {
  if (plan.action === "suppress") {
    return { ...plan, nextRetryAt: null };
  }
  if (plan.delayClass === "continuation") {
    return {
      ...plan,
      nextRetryAt: new Date(
        input.now.getTime() + input.continuationDelayMs
      ).toISOString(),
    };
  }
  return {
    ...plan,
    nextRetryAt: (input.retryPolicy
      ? scheduleRetryAt(input.now, plan.attempt, input.retryPolicy)
      : new Date(input.now.getTime() + input.defaultFailureBackoffMs)
    ).toISOString(),
    delayClass: input.retryPolicy
      ? ("failure-policy" as const)
      : ("failure-fallback" as const),
  };
}

export type RetryRequeuePlan = {
  suppressed: boolean;
  attempt: number;
  failureRetryCount: number;
  retainedDueAt: string | null;
  delayClass: "none" | "retained" | "poll" | "failure";
};

export function planRetryRequeue(input: {
  currentAttempt: number;
  durableFailureCount: number;
  maxFailureRetries: number;
  countFailure: boolean;
  advanceAttempt: boolean;
  retainedDueAt: string | null;
}): RetryRequeuePlan {
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
      retainedDueAt: null,
      delayClass: "none",
    };
  }
  if (!input.advanceAttempt && input.retainedDueAt !== null) {
    return {
      suppressed,
      attempt,
      failureRetryCount,
      retainedDueAt: input.retainedDueAt,
      delayClass: "retained",
    };
  }
  if (!input.advanceAttempt) {
    return {
      suppressed,
      attempt,
      failureRetryCount,
      retainedDueAt: null,
      delayClass: "poll",
    };
  }
  return {
    suppressed,
    attempt,
    failureRetryCount,
    retainedDueAt: null,
    delayClass: "failure",
  };
}

export function resolveRetryRequeue(
  plan: RetryRequeuePlan,
  input: {
    now: Date;
    pollIntervalMs: number | null;
    retryPolicy: RetryPolicyOptions | null;
    defaultFailureBackoffMs: number;
  }
) {
  if (plan.delayClass === "none") return { ...plan, nextRetryAt: null };
  if (plan.delayClass === "retained") {
    return { ...plan, nextRetryAt: plan.retainedDueAt };
  }
  if (plan.delayClass === "poll") {
    if (input.pollIntervalMs === null) {
      throw new Error("poll interval is required for a poll retry");
    }
    return {
      ...plan,
      nextRetryAt: new Date(
        input.now.getTime() + input.pollIntervalMs
      ).toISOString(),
    };
  }
  return {
    ...plan,
    nextRetryAt: (input.retryPolicy
      ? scheduleRetryAt(input.now, plan.attempt, input.retryPolicy)
      : new Date(input.now.getTime() + input.defaultFailureBackoffMs)
    ).toISOString(),
    delayClass: input.retryPolicy
      ? ("failure-policy" as const)
      : ("failure-fallback" as const),
  };
}
