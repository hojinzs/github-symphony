import {
  createHistoryBenchmarkFixture,
  HISTORY_BENCHMARK_LAYOUTS,
  HISTORY_BENCHMARK_SIZES,
  measureHistoryInventory,
  measureHistoryReconciliationTick,
  removeHistoryBenchmarkFixture,
  type HistoryBenchmarkMeasurement,
} from "./history-benchmark.js";

type BenchmarkResult = HistoryBenchmarkMeasurement & {
  historicalRunCount: number;
  scenario: "inventory" | "polling-tick";
};

const results: BenchmarkResult[] = [];

for (const historicalRunCount of HISTORY_BENCHMARK_SIZES) {
  for (const layout of HISTORY_BENCHMARK_LAYOUTS) {
    const fixture = await createHistoryBenchmarkFixture(
      historicalRunCount,
      layout
    );
    try {
      results.push({
        ...(await measureHistoryInventory(fixture, 1)),
        historicalRunCount,
        scenario: "inventory",
      });
      results.push({
        ...(await measureHistoryReconciliationTick(fixture)),
        historicalRunCount,
        scenario: "polling-tick",
      });
    } finally {
      await removeHistoryBenchmarkFixture(fixture);
    }
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      note: "Warm-cache isolated filesystem measurements; not production latency.",
      results,
    },
    null,
    2
  )}\n`
);
