import * as os from "node:os";

// Context only: these observations never qualify, filter, or override a gate.
// Avoid process listings, hostnames, usernames and environment/credential data.
export function hostContext(source = os) {
  const cpus = source.cpus();
  return {
    capturedAt: new Date().toISOString(),
    uptimeSeconds: source.uptime(),
    loadAverage: source.loadavg(),
    logicalCpuCount: cpus.length,
    availableParallelism: source.availableParallelism(),
    cpuModel: cpus[0]?.model ?? "unknown",
    totalMemoryBytes: source.totalmem(),
    freeMemoryBytes: source.freemem(),
    // Cumulative counters across all logical CPUs; compare before/after deltas.
    cpuTimesMs: cpus.reduce((sum, cpu) => {
      for (const [key, value] of Object.entries(cpu.times)) {
        sum[key] = (sum[key] ?? 0) + value;
      }
      return sum;
    }, {}),
  };
}
