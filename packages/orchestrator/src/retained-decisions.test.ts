import { describe, expect, it } from "vitest";
import {
  decideCompletedRunRetry,
  decideFinalizationDisposition,
  decideRetryRequeue,
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
      exhausted: false,
    });
    expect(
      decideFinalizationDisposition({
        trackerProgress,
        currentDeferralCount: 2,
        maxDeferrals: 3,
      })
    ).toEqual({
      action: "enter-failure/continuation-retry",
      consecutiveDeferrals: 3,
      exhausted: true,
    });
  });

  it.each([
    ["non-actionable", "complete"],
    ["active", "enter-failure/continuation-retry"],
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

describe("decideCompletedRunRetry", () => {
  const now = new Date("2026-09-14T00:00:00.000Z");
  const base = {
    currentAttempt: 4,
    durableFailureCount: 1,
    maxFailureRetries: 3,
    now,
    retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 30_000 },
    defaultFailureBackoffMs: 30_000,
    continuationDelayMs: 1_000,
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
        decideCompletedRunRetry({ ...base, retryKind, recoveryPresent })
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
      decideCompletedRunRetry({
        ...base,
        retryKind: "failure",
        recoveryPresent: false,
        durableFailureCount: 2,
      })
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

describe("decideRetryRequeue", () => {
  it("retains the due time without advancing capacity-postponed retries", () => {
    expect(
      decideRetryRequeue({
        currentAttempt: 2,
        durableFailureCount: 1,
        maxFailureRetries: 3,
        now: new Date("2026-09-14T00:00:00.000Z"),
        countFailure: false,
        advanceAttempt: false,
        retainedDueAt: "2026-09-13T23:59:00.000Z",
        pollIntervalMs: 30_000,
        retryPolicy: null,
        defaultFailureBackoffMs: 30_000,
      })
    ).toMatchObject({
      suppressed: false,
      attempt: 2,
      failureRetryCount: 1,
      nextRetryAt: "2026-09-13T23:59:00.000Z",
      delayClass: "retained",
    });
  });
});
