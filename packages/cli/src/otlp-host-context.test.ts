import { expect, it } from "vitest";

const { hostContext } = await import(
  new URL("../scripts/otlp-host-context.mjs", import.meta.url).href
);

it("retains host pressure and cumulative CPU context without host identity", () => {
  const snapshot = hostContext({
    cpus: () => [
      { model: "fixture CPU", times: { user: 10, sys: 20, idle: 30 } },
      { model: "fixture CPU", times: { user: 40, sys: 50, idle: 60 } },
    ],
    uptime: () => 123,
    loadavg: () => [7, 10, 9],
    availableParallelism: () => 2,
    totalmem: () => 4096,
    freemem: () => 1024,
  });
  expect(Number.isNaN(Date.parse(snapshot.capturedAt))).toBe(false);
  expect(snapshot).toEqual({
    capturedAt: expect.any(String),
    uptimeSeconds: 123,
    loadAverage: [7, 10, 9],
    logicalCpuCount: 2,
    availableParallelism: 2,
    cpuModel: "fixture CPU",
    totalMemoryBytes: 4096,
    freeMemoryBytes: 1024,
    cpuTimesMs: { user: 50, sys: 70, idle: 90 },
  });
});
