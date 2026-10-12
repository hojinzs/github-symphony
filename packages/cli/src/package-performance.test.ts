import { describe, it, expect } from "vitest";

const { performanceGates } = await import(
  new URL("../scripts/otlp-performance-gates.mjs", import.meta.url).href
);
const baseline = { startupP95Ms: 100, rssMedianBytes: 80 * 1024 * 1024 };
const offers = {
  healthy: { p95Ms: 0.1 },
  slow: { p95Ms: 0.2 },
  down: { p95Ms: 0.3 },
};

describe("packed OTLP release performance gates", () => {
  it("allows the larger 10ms startup allowance, including its boundary", () => {
    expect(
      performanceGates(baseline, { ...baseline, startupP95Ms: 110 }, offers)
        .startup
    ).toBe(true);
  });
  it("rejects startup beyond the absolute allowance", () => {
    expect(
      performanceGates(baseline, { ...baseline, startupP95Ms: 110.01 }, offers)
        .startup
    ).toBe(false);
  });
  it("uses the larger five-percent allowance on slower baselines", () => {
    expect(
      performanceGates(
        { ...baseline, startupP95Ms: 1000 },
        { ...baseline, startupP95Ms: 1050 },
        offers
      ).startup
    ).toBe(true);
  });
  it("allows exactly five MiB RSS growth", () => {
    expect(
      performanceGates(
        baseline,
        {
          ...baseline,
          rssMedianBytes: baseline.rssMedianBytes + 5 * 1024 * 1024,
        },
        offers
      ).rss
    ).toBe(true);
  });
  it("rejects RSS growth beyond five MiB", () => {
    expect(
      performanceGates(
        baseline,
        {
          ...baseline,
          rssMedianBytes: baseline.rssMedianBytes + 5 * 1024 * 1024 + 1,
        },
        offers
      ).rss
    ).toBe(false);
  });
  it.each(["healthy", "slow", "down"])(
    "requires %s offers strictly below one millisecond",
    (mode) => {
      expect(performanceGates(baseline, baseline, offers).offer).toBe(true);
      expect(
        performanceGates(baseline, baseline, {
          ...offers,
          [mode]: { p95Ms: 1 },
        }).offer
      ).toBe(false);
    }
  );
});
