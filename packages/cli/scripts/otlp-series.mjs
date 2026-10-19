import assert from "node:assert/strict";
import { performanceGates } from "./otlp-performance-gates.mjs";

// Input order is predeclared: comparison, control, repeated three times.
// Recompute policy from retained summaries; never rewrite the input reports.
export function evaluateSeries(reports) {
  assert.equal(reports.length, 6, "A complete series requires six reports");
  const controls = reports.filter((_, i) => i % 2 === 1);
  const reference = reports[0];
  for (const [i, report] of reports.entries()) {
    assert.equal(report.node, reference.node, "Node must remain fixed");
    assert.equal(report.os, reference.os, "Platform must remain fixed");
    assert.equal(
      report.candidateTarballSha256,
      reference.candidateTarballSha256
    );
    assert.ok(report.candidateTarballSha256, "Candidate hash required");
    assert.equal(
      report.baselineTarballSha256,
      i % 2 ? reference.candidateTarballSha256 : reference.baselineTarballSha256
    );
    for (const build of ["baseline", "candidate"]) {
      assert.equal(report.measurements[build].startupMs.length, 30);
      assert.equal(report.measurements[build].rssBytes.length, 30);
    }
    for (const build of [report.baseline, report.candidate]) {
      for (const key of ["startupMedianMs", "startupP95Ms", "rssMedianBytes"]) {
        assert.ok(Number.isFinite(build[key]), "Finite summaries required");
      }
    }
    assert.deepEqual(Object.keys(report.offer).sort(), [
      "down",
      "healthy",
      "slow",
    ]);
    for (const result of Object.values(report.offer)) {
      assert.ok(Number.isFinite(result.p95Ms));
    }
  }
  const noiseFloorMs = Math.max(
    ...controls.map((r) =>
      Math.abs(r.candidate.startupP95Ms - r.baseline.startupP95Ms)
    )
  );
  const rows = reports.map((r) => {
    const gates = performanceGates(r.baseline, r.candidate, r.offer);
    const allowanceMs = Math.max(10, r.baseline.startupMedianMs * 0.05);
    const medianDeltaMs =
      r.candidate.startupMedianMs - r.baseline.startupMedianMs;
    const p95DeltaMs = r.candidate.startupP95Ms - r.baseline.startupP95Ms;
    return {
      gates,
      allowanceMs,
      medianDeltaMs,
      p95DeltaMs,
      p95Flag: p95DeltaMs > noiseFloorMs,
      withinDoubleAllowance: medianDeltaMs <= 2 * allowanceMs,
    };
  });
  const comparisonRows = rows.filter((_, i) => i % 2 === 0);
  const controlsPass = rows
    .filter((_, i) => i % 2 === 1)
    .every((r) => Object.values(r.gates).every(Boolean));
  return {
    noiseFloorMs,
    rows,
    controlsPass,
    pass:
      controlsPass &&
      comparisonRows.filter((r) => r.gates.startup).length >= 2 &&
      comparisonRows.every(
        (r) => r.withinDoubleAllowance && r.gates.rss && r.gates.offer
      ),
  };
}
