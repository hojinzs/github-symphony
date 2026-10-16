// Review thresholds from the approved OTLP design. Size is reported separately.
export function performanceGates(baseline, candidate, offers) {
  return {
    startup:
      candidate.startupP95Ms - baseline.startupP95Ms <=
      Math.max(10, baseline.startupP95Ms * 0.05),
    rss: candidate.rssMedianBytes - baseline.rssMedianBytes <= 5 * 1024 * 1024,
    offer: Object.values(offers).every((result) => result.p95Ms < 1),
  };
}
// Counterbalance pair order so neither build always follows the other's I/O
// and neither consistently occupies the later position during host-load drift.
export function startupBuildOrder(sampleIndex) {
  return sampleIndex % 2 === 0
    ? ["baseline", "candidate"]
    : ["candidate", "baseline"];
}
