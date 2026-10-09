import { afterEach, expect, it } from "vitest";
import {
  AggregationTemporality,
  DataPointType,
  type MetricData,
} from "@opentelemetry/sdk-metrics";
import {
  buildProjectSnapshot,
  buildProjectMetricProjection,
  type CommittedMetricSnapshot,
  type OrchestratorRunRecord,
} from "@gh-symphony/core";
import {
  createOwnedMetricProvider,
  METRIC_CATALOG,
  TICK_DURATION_BOUNDS,
} from "./metric-provider.js";

export const identity = {
  version: "test",
  projectId: "folder",
  projectSlug: "owner/repo",
  trackerKind: "file",
};
export function snapshot(sequence = 1): CommittedMetricSnapshot {
  return {
    projectId: "folder",
    instanceId: "facade-instance",
    sequence,
    projection: {
      sourceTime: "2026-10-09T00:00:00Z",
      activeRuns: 2,
      retryingRuns: 1,
      health: { idle: 0, running: 1, degraded: 0 },
      pollIntervalMs: 30000,
      tickOutcomes: { dispatched: 2, suppressed: 1, recovered: 3, skipped: 4 },
      tokensSupported: { codex: 1, claude: 0 },
      tokenTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      runtimeSeconds: 42,
    },
  };
}
const owners: ReturnType<typeof createOwnedMetricProvider>[] = [];
function owner() {
  const p = createOwnedMetricProvider(identity);
  owners.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(owners.splice(0).map((p) => p.provider.shutdown()));
});
async function metrics(p: ReturnType<typeof owner>) {
  const result = await p.reader.collect();
  expect(result.errors).toEqual([]);
  return Object.fromEntries(
    result.resourceMetrics.scopeMetrics.flatMap((scope) =>
      scope.metrics.map((m) => [m.descriptor.name, m])
    )
  );
}
const values = (m: MetricData) => m.dataPoints.map((p) => p.value);

it("OT-06 records committed outcomes once and never replays history on collection", async () => {
  const p = owner();
  expect(await metrics(p)).toEqual({});
  p.offerSnapshot(snapshot());
  p.offerSnapshot(snapshot());
  p.offerSnapshot(snapshot(0));
  p.offerSnapshot({ ...snapshot(2), projectId: "other" });
  p.offerSnapshot({ ...snapshot(2), instanceId: "other-process" });
  const first = (await metrics(p))[METRIC_CATALOG.outcomes.name]!;
  expect(first.dataPointType).toBe(DataPointType.SUM);
  expect(first.aggregationTemporality).toBe(AggregationTemporality.CUMULATIVE);
  expect(values(first)).toEqual([2, 1, 3, 4]);
  const second = (await metrics(p))[METRIC_CATALOG.outcomes.name]!;
  expect(second.dataPoints).toEqual(
    first.dataPoints.map((point, i) => ({
      ...point,
      endTime: second.dataPoints[i]!.endTime,
    }))
  );
  p.offerSnapshot(snapshot(2));
  expect(values((await metrics(p))[METRIC_CATALOG.outcomes.name]!)).toEqual([
    4, 2, 6, 8,
  ]);
  expect(p.status()).toEqual({ sequence: 2, hasSnapshot: true });
});

it("OT-05 coalesces immutable absolute gauges with bounded catalog attributes", async () => {
  const p = owner();
  for (let sequence = 1; sequence <= 10000; sequence++)
    p.offerSnapshot(snapshot(sequence));
  const offered = snapshot(10001);
  p.offerSnapshot(offered);
  Object.assign(offered.projection, { activeRuns: 999, runtimeSeconds: 999 });
  Object.assign(offered.projection.tokenTotals!, { totalTokens: 999 });
  const all = await metrics(p);
  expect(values(all[METRIC_CATALOG.active.name]!)).toEqual([2]);
  expect(values(all[METRIC_CATALOG.runtime.name]!)).toEqual([42]);
  expect(values(all[METRIC_CATALOG.tokens.name]!)).toEqual([10, 5, 15]);
  expect(values(all[METRIC_CATALOG.health.name]!)).toEqual([0, 1, 0]);
  expect(values(all[METRIC_CATALOG.poll.name]!)).toEqual([30000]);
  for (const m of Object.values(all)) {
    for (const point of m.dataPoints) {
      expect(
        Object.keys(point.attributes).every((key) =>
          ["outcome", "direction", "runtime", "state"].includes(key)
        )
      ).toBe(true);
    }
  }
  expect(p.status()).toEqual({ sequence: 10001, hasSnapshot: true });
  p.offerSnapshot({
    ...snapshot(10002),
    projection: {
      ...snapshot().projection,
      runtimeSeconds: 3,
      tokenTotals: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
    },
  });
  const corrected = await metrics(p);
  expect(values(corrected[METRIC_CATALOG.tokens.name]!)).toEqual([1, 0, 1]);
  expect(values(corrected[METRIC_CATALOG.runtime.name]!)).toEqual([3]);
});

it("OT-08 omits unmeasured tokens and absent poll interval but preserves measured zero", async () => {
  const p = owner();
  const s = snapshot();
  p.offerSnapshot({
    ...s,
    projection: {
      ...s.projection,
      tokenTotals: null,
      pollIntervalMs: undefined,
    },
  });
  let all = await metrics(p);
  expect(all[METRIC_CATALOG.tokens.name]).toBeUndefined();
  expect(all[METRIC_CATALOG.poll.name]).toBeUndefined();
  expect(
    all[METRIC_CATALOG.supported.name]!.dataPoints.map((point) => [
      point.attributes.runtime,
      point.value,
    ])
  ).toEqual([
    ["codex", 1],
    ["claude", 0],
  ]);
  p.offerSnapshot({
    ...snapshot(2),
    projection: {
      ...s.projection,
      tokenTotals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    },
  });
  all = await metrics(p);
  expect(values(all[METRIC_CATALOG.tokens.name]!)).toEqual([0, 0, 0]);
  expect(
    all[METRIC_CATALOG.tokens.name]!.dataPoints.every(
      (point) => point.attributes.runtime === "codex"
    )
  ).toBe(true);
  p.offerSnapshot({
    ...snapshot(3),
    projection: {
      ...s.projection,
      tokenTotals: null,
      pollIntervalMs: undefined,
    },
  });
  all = await metrics(p);
  expect(all[METRIC_CATALOG.tokens.name]).toBeUndefined();
  expect(all[METRIC_CATALOG.poll.name]).toBeUndefined();
});

it("OT-06 resets process counters and resource UUID without historical replay", async () => {
  const a = owner();
  a.offerSnapshot(snapshot());
  a.offerSnapshot(snapshot(2));
  const aMetrics = await metrics(a);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const b = owner();
  expect(b.resource.attributes["service.instance.id"]).not.toBe(
    a.resource.attributes["service.instance.id"]
  );
  expect(b.resource.attributes).toMatchObject({
    "service.name": "gh-symphony",
    "symphony.project.id": "folder",
  });
  expect(await metrics(b)).toEqual({});
  b.offerSnapshot({ ...snapshot(), instanceId: "restart" });
  const bMetrics = await metrics(b);
  expect(values(bMetrics[METRIC_CATALOG.outcomes.name]!)).toEqual([2, 1, 3, 4]);
  expect(values(bMetrics[METRIC_CATALOG.tokens.name]!)).toEqual(
    values(aMetrics[METRIC_CATALOG.tokens.name]!)
  );
  expect(
    bMetrics[METRIC_CATALOG.outcomes.name]!.dataPoints[0]!.startTime
  ).not.toEqual(
    aMetrics[METRIC_CATALOG.outcomes.name]!.dataPoints[0]!.startTime
  );
});

it("exports cumulative success/failure duration and bounded nonrecursive loss instruments", async () => {
  const p = owner();
  p.observeTick({ durationSeconds: 0.02, outcome: "success" });
  p.observeTick({ durationSeconds: 2, outcome: "failure" });
  p.observeTick({ durationSeconds: -1, outcome: "success" });
  p.recordLoss("logs", "queue_full", 2);
  p.recordLoss("metrics", "partial", 1);
  p.recordLoss("metrics", "partial", -1);
  p.stop();
  p.observeTick({ durationSeconds: 4, outcome: "success" });
  p.recordLoss("metrics", "partial", 10);
  p.offerSnapshot(snapshot());
  const all = await metrics(p);
  expect(all[METRIC_CATALOG.active.name]).toBeUndefined();
  const histogram = all[METRIC_CATALOG.duration.name]!;
  expect(histogram.dataPointType).toBe(DataPointType.HISTOGRAM);
  expect(histogram.aggregationTemporality).toBe(
    AggregationTemporality.CUMULATIVE
  );
  expect(histogram.dataPoints.map((point) => point.value)).toMatchObject([
    { count: 1, sum: 0.02, buckets: { boundaries: TICK_DURATION_BOUNDS } },
    { count: 1, sum: 2, buckets: { boundaries: TICK_DURATION_BOUNDS } },
  ]);
  const second = (await metrics(p))[METRIC_CATALOG.duration.name]!;
  expect(values(second)).toEqual(values(histogram));
  expect(
    all[METRIC_CATALOG.dropped.name]!.dataPoints.map((point) => [
      point.attributes,
      point.value,
    ])
  ).toEqual([
    [{ signal: "logs", reason: "queue_full" }, 2],
    [{ signal: "metrics", reason: "partial" }, 1],
  ]);
});

it("OT-06/08 consumes authoritative recovered session deltas and omits Claude history", async () => {
  const repository = {
    owner: "owner",
    name: "repo",
    cloneUrl: "https://github.com/owner/repo.git",
  };
  const base: OrchestratorRunRecord = {
    runId: "session-1",
    projectId: "folder",
    projectSlug: "owner/repo",
    issueId: "private-issue",
    issueSubjectId: "subject",
    issueIdentifier: "owner/repo#42",
    issueState: "Done",
    repository,
    status: "succeeded",
    attempt: 1,
    processId: null,
    port: null,
    workingDirectory: "/tmp/work",
    workspaceRuntimeDir: "/tmp/runtime",
    workflowPath: "WORKFLOW.md",
    retryKind: null,
    createdAt: "2026-10-09T00:00:00Z",
    updatedAt: "2026-10-09T00:00:01Z",
    startedAt: null,
    completedAt: null,
    lastError: null,
    nextRetryAt: null,
    runtimeKind: "codex-app-server",
    tokenUsageMeasured: true,
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cumulativeTotalTokens: 999,
    },
    runtimeLifecycleId: "recovered-lifecycle",
    cumulativeRuntimeMs: 1000,
  };
  const claude: OrchestratorRunRecord = {
    ...base,
    runId: "claude",
    issueId: "claude-issue",
    runtimeKind: "claude-print",
    runtimeLifecycleId: "claude-lifecycle",
    cumulativeRuntimeMs: 10000,
  };
  const runs = [
    base,
    {
      ...base,
      runId: "session-2",
      updatedAt: "2026-10-09T00:00:02Z",
      cumulativeRuntimeMs: 4000,
      tokenUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    },
    claude,
    {
      ...base,
      runId: "legacy",
      issueId: "legacy-issue",
      runtimeKind: undefined,
      tokenUsageMeasured: undefined,
      runtimeLifecycleId: "legacy-lifecycle",
      cumulativeRuntimeMs: 0,
    },
  ];
  const project = {
    projectId: "folder",
    slug: "owner/repo",
    workspaceDir: "/tmp/runtime",
    repository,
    tracker: { adapter: "file" as const, bindingId: "fixture" },
  };
  const input = {
    project,
    activeRuns: [],
    allRuns: runs,
    summary: { dispatched: 0, suppressed: 0, recovered: 1 },
    lastTickAt: "2026-10-09T00:00:03Z",
    lastError: null,
  };
  const status = buildProjectSnapshot(input);
  const original = JSON.stringify(status);
  const p = owner();
  p.offerSnapshot({
    ...snapshot(),
    projection: buildProjectMetricProjection(status, runs),
  });
  // The consumer's collection must not access history, even after it is changed.
  runs.splice(0);
  let all = await metrics(p);
  expect(values(all[METRIC_CATALOG.tokens.name]!)).toEqual([12, 6, 18]);
  expect(values(all[METRIC_CATALOG.runtime.name]!)).toEqual([14]);
  expect(values(all[METRIC_CATALOG.outcomes.name]!)).toEqual([0, 0, 1, 0]);
  all = await metrics(p);
  expect(values(all[METRIC_CATALOG.tokens.name]!)).toEqual([12, 6, 18]);
  expect(JSON.stringify(status)).toBe(original);
  const claudeStatus = buildProjectSnapshot({ ...input, allRuns: [claude] });
  p.offerSnapshot({
    ...snapshot(2),
    projection: buildProjectMetricProjection(claudeStatus, [claude]),
  });
  all = await metrics(p);
  expect(all[METRIC_CATALOG.tokens.name]).toBeUndefined();
  expect(values(all[METRIC_CATALOG.runtime.name]!)).toEqual([10]);
  expect(
    all[METRIC_CATALOG.supported.name]!.dataPoints.find(
      (point) => point.attributes.runtime === "claude"
    )!.value
  ).toBe(0);
});
