import { describe, expect, it } from "vitest";
import { calculateRetryDelay, scheduleRetryAt } from "./retry-policy.js";

describe("calculateRetryDelay", () => {
  it("uses exponential backoff", () => {
    expect(calculateRetryDelay(1, { baseDelayMs: 1000, maxDelayMs: 30000 })).toBe(1000);
    expect(calculateRetryDelay(2, { baseDelayMs: 1000, maxDelayMs: 30000 })).toBe(2000);
    expect(calculateRetryDelay(3, { baseDelayMs: 1000, maxDelayMs: 30000 })).toBe(4000);
  });

  it("caps the retry delay at the configured maximum", () => {
    expect(calculateRetryDelay(8, { baseDelayMs: 1000, maxDelayMs: 5000 })).toBe(5000);
  });
});

describe("scheduleRetryAt", () => {
  it("computes the next retry timestamp from the current attempt", () => {
    const now = new Date("2026-03-07T09:00:00.000Z");

    expect(scheduleRetryAt(now, 3, { baseDelayMs: 1000, maxDelayMs: 30000 }).toISOString()).toBe(
      "2026-03-07T09:00:04.000Z"
    );
  });
});
