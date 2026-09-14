import { describe, expect, it } from "vitest";
import {
  decideFinalizationDisposition,
  planCompletedRunRetry,
  planRetryRequeue,
  resolveCompletedRunRetry,
  resolveRetryRequeue,
} from "./retained-decisions.js";

describe("decideFinalizationDisposition", () => {
  it("retains finalization below the bound and falls through at the bound", () => {
    const trackerProgress = {
      state: "unknown" as const,
      reason: "tracker-read-failed" as const,
      error: "unavailable",
    };
    expect(
      decideFinalizationDisposition({
        trackerProgress,
        currentDeferralCount: 1,
        maxDeferrals: 3,
      })
    ).toEqual({
      action: "defer-finalization",
      consecutiveDeferrals: 2,
      reason: "tracker-read-failed",
      error: "unavailable",
    });
    expect(
      decideFinalizationDisposition({
        trackerProgress,
        currentDeferralCount: 2,
        maxDeferrals: 3,
      })
    ).toEqual({
      action: "record-exhausted-deferral",
      consecutiveDeferrals: 3,
      reason: "tracker-read-failed",
      error: "unavailable",
    });
  });

  it.each([
    ["non-actionable", "complete"],
    ["active", "retry"],
  ] as const)("maps %s tracker progress to %s", (state, action) => {
    expect(
      decideFinalizationDisposition({
        trackerProgress: { state },
        currentDeferralCount: 0,
        maxDeferrals: 3,
      }).action
    ).toBe(action);
  });
});

describe("completed run retry decisions", () => {
  const now = new Date("2026-09-14T00:00:00.000Z");
  const base = {
    currentAttempt: 4,
    durableFailureCount: 1,
    maxFailureRetries: 3,
  };

  it.each([
    ["continuation", false, 1, 1, "continuation"],
    ["failure", true, 5, 2, "recovery"],
    ["failure", false, 5, 2, "failure"],
  ] as const)(
    "preserves %s attempt and budget accounting",
    (
      retryKind,
      recoveryPresent,
      attempt,
      failureRetryCount,
      persistedRetryKind
    ) => {
      expect(
        planCompletedRunRetry({ ...base, retryKind, recoveryPresent })
      ).toMatchObject({
        action: "retry",
        attempt,
        failureRetryCount,
        persistedRetryKind,
      });
    }
  );

  it("suppresses a failure exactly at the retry bound", () => {
    expect(
      resolveCompletedRunRetry(
        planCompletedRunRetry({
          ...base,
          retryKind: "failure",
          recoveryPresent: false,
          durableFailureCount: 2,
        }),
        {
          now,
          retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 30_000 },
          defaultFailureBackoffMs: 30_000,
          continuationDelayMs: 1_000,
        }
      )
    ).toEqual({
      action: "suppress",
      attempt: 4,
      failureRetryCount: 3,
      persistedRetryKind: null,
      nextRetryAt: null,
      delayClass: "none",
    });
  });
});

describe("retry requeue decisions", () => {
  const now = new Date("2026-09-14T00:00:00.000Z");
  const retainedDueAt = "2026-09-13T23:59:00.000Z";

  it.each([
    [true, true, null, 3, "none", null],
    [false, false, retainedDueAt, 2, "retained", retainedDueAt],
    [false, false, null, 2, "poll", "2026-09-14T00:00:30.000Z"],
    [true, true, null, 3, "failure-policy", "2026-09-14T00:00:04.000Z"],
    [true, true, null, 3, "failure-fallback", "2026-09-14T00:00:30.000Z"],
  ] as const)(
    "resolves countFailure=%s advanceAttempt=%s as %s",
    (
      countFailure,
      advanceAttempt,
      retained,
      attempt,
      delayClass,
      nextRetryAt
    ) => {
      const plan = planRetryRequeue({
        currentAttempt: 2,
        durableFailureCount: countFailure && delayClass === "none" ? 2 : 1,
        maxFailureRetries: 3,
        countFailure,
        advanceAttempt,
        retainedDueAt: retained,
      });
      const disposition = resolveRetryRequeue(plan, {
        now,
        pollIntervalMs: delayClass === "poll" ? 30_000 : null,
        retryPolicy:
          delayClass === "failure-policy"
            ? { baseDelayMs: 1_000, maxDelayMs: 30_000 }
            : null,
        defaultFailureBackoffMs: 30_000,
      });
      expect(disposition).toMatchObject({ attempt, delayClass, nextRetryAt });
    }
  );

  it("requires failure accounting before suppressing", () => {
    expect(
      planRetryRequeue({
        currentAttempt: 2,
        durableFailureCount: 3,
        maxFailureRetries: 3,
        countFailure: false,
        advanceAttempt: false,
        retainedDueAt,
      }).suppressed
    ).toBe(false);
  });

  it("schedules policy backoff with the advanced attempt", () => {
    const plan = planRetryRequeue({
      currentAttempt: 2,
      durableFailureCount: 0,
      maxFailureRetries: 3,
      countFailure: true,
      advanceAttempt: true,
      retainedDueAt: null,
    });
    expect(
      resolveRetryRequeue(plan, {
        now,
        pollIntervalMs: null,
        retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 30_000 },
        defaultFailureBackoffMs: 30_000,
      }).nextRetryAt
    ).toBe("2026-09-14T00:00:04.000Z");
  });
});
