import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { OrchestratorRunRecord } from "@gh-symphony/core";
import { OrchestratorFsStore } from "./fs-store.js";
import { OrchestratorService } from "./service.js";

export const HISTORY_BENCHMARK_SIZES = [100, 1_000, 10_000] as const;
export const HISTORY_BENCHMARK_LAYOUTS = ["legacy", "shared"] as const;

export type HistoryBenchmarkLayout = (typeof HISTORY_BENCHMARK_LAYOUTS)[number];

export type HistoryBenchmarkFixture = {
  activeRunId: string;
  expectedRunCount: number;
  layout: HistoryBenchmarkLayout;
  projectId: string;
  runtimeRoot: string;
  store: OrchestratorFsStore;
  readCounter: { count: number };
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
  const readCounter = { count: 0 };
  const store = new OrchestratorFsStore(runtimeRoot, {
    onRunRecordRead: () => {
      readCounter.count += 1;
    },
  });
  const activeRunId = "active-run";

  try {
    const records = Array.from({ length: historicalRunCount }, (_, index) =>
      createRunRecord(`historical-${index}`, "succeeded")
    );
    records.push(createRunRecord(activeRunId, "running"));

    for (let offset = 0; offset < records.length; offset += 100) {
      await Promise.all(
        records.slice(offset, offset + 100).map(async (record) => {
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
    }

    return {
      activeRunId,
      expectedRunCount: records.length,
      layout,
      projectId: PROJECT_ID,
      runtimeRoot,
      store,
      readCounter,
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
  fixture.readCounter.count = 0;
  const resourceBefore = process.resourceUsage();
  const startedAt = performance.now();

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const inventory = fixture.store.loadAllRuns();
    const activeUpdate =
      iteration === 0
        ? updateActiveRun(
            fixture,
            {
              ...createRunRecord(fixture.activeRunId, "running"),
              updatedAt: "2026-09-14T00:00:00.001Z",
            },
            iteration
          )
        : Promise.resolve();
    const runs = await inventory;
    if (runs.length !== fixture.expectedRunCount) {
      throw new Error(
        `Expected ${fixture.expectedRunCount} runs, received ${runs.length}.`
      );
    }
    await activeUpdate;
  }

  const elapsedMs = performance.now() - startedAt;
  const resourceAfter = process.resourceUsage();
  return {
    elapsedMs,
    fsReadCount: fixture.readCounter.count,
    iterations,
    layout: fixture.layout,
    maxRssDeltaKb: Math.max(0, resourceAfter.maxRSS - resourceBefore.maxRSS),
    runCount: fixture.expectedRunCount,
    userCpuMs: (resourceAfter.userCPUTime - resourceBefore.userCPUTime) / 1_000,
    systemCpuMs:
      (resourceAfter.systemCPUTime - resourceBefore.systemCPUTime) / 1_000,
  };
}

export async function measureHistoryReconciliationTick(
  fixture: HistoryBenchmarkFixture
): Promise<HistoryBenchmarkMeasurement> {
  const issuesPath = join(fixture.runtimeRoot, "benchmark-issues.json");
  const workflowPath = join(fixture.runtimeRoot, "WORKFLOW.md");
  await writeFile(issuesPath, "[]\n", "utf8");
  await writeFile(
    workflowPath,
    "---\ntracker:\n  kind: file\n---\nBenchmark reconciliation.\n",
    "utf8"
  );
  await fixture.store.loadAllRuns();
  fixture.readCounter.count = 0;

  const projectConfig = {
    projectId: fixture.projectId,
    slug: fixture.projectId,
    workspaceDir: join(fixture.runtimeRoot, "workspaces"),
    repository: {
      owner: "benchmark",
      name: "repo",
      cloneUrl: join(fixture.runtimeRoot, "repository"),
    },
    workflowSource: { type: "external" as const, path: workflowPath },
    tracker: {
      adapter: "file" as const,
      bindingId: "history-benchmark",
      settings: {
        issuesPath,
        repository: "benchmark/repo",
      },
    },
  };
  const service = new OrchestratorService(fixture.store, projectConfig, {
    isProcessRunning: () => true,
    killImpl: () => {},
    now: () => new Date("2026-09-14T00:00:00.100Z"),
  });
  const loadAllRuns = fixture.store.loadAllRuns.bind(fixture.store);
  let iterations = 0;
  fixture.store.loadAllRuns = async () => {
    iterations += 1;
    return loadAllRuns();
  };

  const activeUpdate = updateActiveRun(
    fixture,
    {
      ...createRunRecord(fixture.activeRunId, "running"),
      updatedAt: "2026-09-14T00:00:00.002Z",
    },
    0
  );
  const resourceBefore = process.resourceUsage();
  const startedAt = performance.now();
  await service.runOnce();
  const elapsedMs = performance.now() - startedAt;
  const resourceAfter = process.resourceUsage();
  await activeUpdate;
  fixture.store.loadAllRuns = loadAllRuns;

  return {
    elapsedMs,
    fsReadCount: fixture.readCounter.count,
    iterations,
    layout: fixture.layout,
    maxRssDeltaKb: Math.max(0, resourceAfter.maxRSS - resourceBefore.maxRSS),
    runCount: fixture.expectedRunCount,
    userCpuMs: (resourceAfter.userCPUTime - resourceBefore.userCPUTime) / 1_000,
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
    processId: status === "running" ? process.pid : null,
    port: null,
    workingDirectory: `/tmp/workspace-${runId}/repository`,
    issueWorkspaceKey: `workspace-${runId}`,
    workspaceRuntimeDir: `/tmp/workspace-${runId}`,
    workflowPath: null,
    retryKind: null,
    createdAt: "2026-09-14T00:00:00.000Z",
    startedAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:00:00.000Z",
    completedAt: status === "running" ? null : "2026-09-14T00:01:00.000Z",
    lastError: null,
    nextRetryAt: null,
  };
}
