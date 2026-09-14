import {
  createHistoryBenchmarkFixture,
  HISTORY_BENCHMARK_LAYOUTS,
  HISTORY_BENCHMARK_SIZES,
  measureHistoryInventory,
  removeHistoryBenchmarkFixture,
  type HistoryBenchmarkMeasurement,
} from "./history-benchmark.js";

const POLLING_TICK_INVENTORY_PASSES = 5;

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
        ...(await measureHistoryInventory(
          fixture,
          POLLING_TICK_INVENTORY_PASSES
        )),
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
      pollingTickInventoryPasses: POLLING_TICK_INVENTORY_PASSES,
      results,
    },
    null,
    2
  )}\n`
);
