import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { OrchestratorRunRecord } from "@gh-symphony/core";
import { OrchestratorFsStore } from "./fs-store.js";

export const HISTORY_BENCHMARK_SIZES = [100, 1_000, 10_000] as const;
export const HISTORY_BENCHMARK_LAYOUTS = ["legacy", "shared"] as const;

export type HistoryBenchmarkLayout =
  (typeof HISTORY_BENCHMARK_LAYOUTS)[number];

export type HistoryBenchmarkFixture = {
  activeRunId: string;
  expectedRunCount: number;
  layout: HistoryBenchmarkLayout;
  projectId: string;
  runtimeRoot: string;
  store: OrchestratorFsStore;
};

export type HistoryBenchmarkMeasurement = {
  elapsedMs: number;
  fsReadCount: number;
  iterations: number;
  layout: HistoryBenchmarkLayout;
  maxRssDeltaKb: number;
  runCount: number;
  userCpuMs: number;
  systemCpuMs: number;
};

const PROJECT_ID = "benchmark-project";

export async function createHistoryBenchmarkFixture(
  historicalRunCount: number,
  layout: HistoryBenchmarkLayout
): Promise<HistoryBenchmarkFixture> {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "symphony-history-bench-"));
  const store = new OrchestratorFsStore(runtimeRoot);
  const activeRunId = "active-run";

  try {
    const records = Array.from({ length: historicalRunCount }, (_, index) =>
      createRunRecord(`historical-${index}`, "succeeded")
    );
    records.push(createRunRecord(activeRunId, "running"));

    await Promise.all(
      records.map(async (record) => {
        const runDirectory =
          layout === "shared"
            ? store.runDir(record.runId, PROJECT_ID)
            : store.runDir(record.runId);
        await mkdir(runDirectory, { recursive: true });
        await writeFile(
          join(runDirectory, "run.json"),
          `${JSON.stringify(record)}\n`,
          "utf8"
        );
      })
    );

    return {
      activeRunId,
      expectedRunCount: records.length,
      layout,
      projectId: PROJECT_ID,
      runtimeRoot,
      store,
    };
  } catch (error) {
    await rm(runtimeRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function removeHistoryBenchmarkFixture(
  fixture: HistoryBenchmarkFixture
): Promise<void> {
  await rm(fixture.runtimeRoot, { recursive: true, force: true });
}

export async function measureHistoryInventory(
  fixture: HistoryBenchmarkFixture,
  iterations: number
): Promise<HistoryBenchmarkMeasurement> {
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error("History benchmark iterations must be a positive integer.");
  }

  await fixture.store.loadAllRuns();
  const resourceBefore = process.resourceUsage();
  const startedAt = performance.now();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const activeUpdate = createRunRecord(fixture.activeRunId, "running");
    activeUpdate.updatedAt = new Date(
      Date.parse(activeUpdate.updatedAt) + iteration + 1
    ).toISOString();
    const runs = await Promise.all([
      fixture.store.loadAllRuns(),
      updateActiveRun(fixture, activeUpdate, iteration),
    ]).then(([inventory]) => inventory);
    if (runs.length !== fixture.expectedRunCount) {
      throw new Error(
        `Expected ${fixture.expectedRunCount} runs, received ${runs.length}.`
      );
    }
  }

  const elapsedMs = performance.now() - startedAt;
  const resourceAfter = process.resourceUsage();
  return {
    elapsedMs,
    fsReadCount: fixture.expectedRunCount * iterations,
    iterations,
    layout: fixture.layout,
    maxRssDeltaKb: Math.max(
      0,
      resourceAfter.maxRSS - resourceBefore.maxRSS
    ),
    runCount: fixture.expectedRunCount,
    userCpuMs:
      (resourceAfter.userCPUTime - resourceBefore.userCPUTime) / 1_000,
    systemCpuMs:
      (resourceAfter.systemCPUTime - resourceBefore.systemCPUTime) / 1_000,
  };
}

async function updateActiveRun(
  fixture: HistoryBenchmarkFixture,
  activeUpdate: OrchestratorRunRecord,
  iteration: number
): Promise<void> {
  if (fixture.layout === "shared") {
    await fixture.store.saveRun(activeUpdate);
    return;
  }

  const runDirectory = fixture.store.runDir(activeUpdate.runId);
  const temporaryPath = join(runDirectory, `run.json.${iteration}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(activeUpdate)}\n`, "utf8");
  await rename(temporaryPath, join(runDirectory, "run.json"));
}

function createRunRecord(
  runId: string,
  status: OrchestratorRunRecord["status"]
): OrchestratorRunRecord {
  return {
    runId,
    projectId: PROJECT_ID,
    issueId: `issue-${runId}`,
    issueIdentifier: `benchmark/repo#${runId}`,
    issueTitle: `Benchmark ${runId}`,
    projectSlug: PROJECT_ID,
    issueState: status === "running" ? "In progress" : "Done",
    issueSubjectId: `subject-${runId}`,
    repository: {
      owner: "benchmark",
      name: "repo",
      cloneUrl: "https://github.com/benchmark/repo.git",
    },
    status,
    attempt: 1,
    processId: null,
    port: null,
    workingDirectory: `/tmp/workspace-${runId}/repository`,
    issueWorkspaceKey: `workspace-${runId}`,
    workspaceRuntimeDir: `/tmp/workspace-${runId}`,
    workflowPath: null,
    retryKind: null,
    createdAt: "2026-09-14T00:00:00.000Z",
    startedAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    completedAt:
      status === "running" ? null : "2026-09-14T00:01:00.000Z",
    lastError: null,
    nextRetryAt: null,
  };
}
