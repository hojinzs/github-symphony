import { expect, it } from "vitest";
const { evaluateSeries } = await import(
  new URL("../scripts/otlp-series.mjs", import.meta.url).href
);
const report = (delta = 0, control = false) => ({
  node: "v24",
  os: "fixture",
  candidateTarballSha256: "candidate",
  baselineTarballSha256: control ? "candidate" : "baseline",
  baseline: { startupMedianMs: 100, startupP95Ms: 150, rssMedianBytes: 100 },
  candidate: {
    startupMedianMs: 100 + delta,
    startupP95Ms: control ? 190 : 200,
    rssMedianBytes: 100,
  },
  measurements: Object.fromEntries(
    ["baseline", "candidate"].map((b) => [
      b,
      {
        startupMs: Array(30).fill(100),
        rssBytes: Array(30).fill(100),
      },
    ])
  ),
  offer: Object.fromEntries(
    ["healthy", "slow", "down"].map((m) => [m, { p95Ms: 0.1 }])
  ),
});
const series = (deltas: number[]) =>
  deltas.flatMap((d) => [report(d), report(0, true)]);
it("allows two of three medians, flags p95 beyond absolute control noise, and caps every comparison", () => {
  const result = evaluateSeries(series([10, 10, 20]));
  expect(result.pass).toBe(true);
  expect(result.noiseFloorMs).toBe(40);
  expect(result.rows[0].p95Flag).toBe(true);
  expect(evaluateSeries(series([10, 10, 20.01])).pass).toBe(false);
  expect(evaluateSeries(series([10, 11, 11])).pass).toBe(false);
});
it("keeps RSS, offer and identical controls as hard gates", () => {
  for (const index of [0, 1]) {
    const rss = series([0, 0, 0]);
    rss[index].candidate.rssMedianBytes += 5 * 1024 * 1024 + 1;
    expect(evaluateSeries(rss).pass).toBe(false);
    const offer = series([0, 0, 0]);
    offer[index].offer.down.p95Ms = 1;
    expect(evaluateSeries(offer).pass).toBe(false);
  }
  const controls = series([0, 0, 0]);
  controls[1].candidate.startupMedianMs = 111;
  expect(evaluateSeries(controls).pass).toBe(false);
});
it("rejects incomplete or mixed-artifact series", () => {
  expect(() => evaluateSeries(series([0, 0]))).toThrow();
  const mixed = series([0, 0, 0]);
  mixed[1].baselineTarballSha256 = "wrong";
  expect(() => evaluateSeries(mixed)).toThrow();
  const short = series([0, 0, 0]);
  short[0].measurements.baseline.startupMs.pop();
  expect(() => evaluateSeries(short)).toThrow();
});
