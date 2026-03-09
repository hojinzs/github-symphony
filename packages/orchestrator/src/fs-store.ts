import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  IssueWorkspaceRecord,
  OrchestratorEvent,
  OrchestratorRunRecord,
  OrchestratorStateStore,
  OrchestratorWorkspaceConfig,
  WorkspaceLeaseRecord,
  WorkspaceStatusSnapshot,
} from "@github-symphony/core";

export class OrchestratorFsStore implements OrchestratorStateStore {
  constructor(readonly runtimeRoot: string) {}

  workspaceDir(workspaceId: string): string {
    return join(this.runtimeRoot, "orchestrator", "workspaces", workspaceId);
  }

  runsDir(): string {
    return join(this.runtimeRoot, "orchestrator", "runs");
  }

  runDir(runId: string): string {
    return join(this.runsDir(), runId);
  }

  async loadWorkspaceConfigs(): Promise<OrchestratorWorkspaceConfig[]> {
    const baseDir = join(this.runtimeRoot, "orchestrator", "workspaces");
    const entries = await safeReadDir(baseDir);
    const configs = await Promise.all(
      entries.map(async (entry) => {
        const config = await readJsonFile<OrchestratorWorkspaceConfig>(
          join(baseDir, entry, "config.json")
        );
        return config;
      })
    );

    return configs.filter((config): config is OrchestratorWorkspaceConfig =>
      Boolean(config)
    );
  }

  async saveWorkspaceConfig(
    config: OrchestratorWorkspaceConfig
  ): Promise<void> {
    await writeJsonFile(
      join(this.workspaceDir(config.workspaceId), "config.json"),
      config
    );
  }

  async loadWorkspaceLeases(
    workspaceId: string
  ): Promise<WorkspaceLeaseRecord[]> {
    return (
      (await readJsonFile<WorkspaceLeaseRecord[]>(
        join(this.workspaceDir(workspaceId), "leases.json")
      )) ?? []
    );
  }

  async saveWorkspaceLeases(
    workspaceId: string,
    leases: WorkspaceLeaseRecord[]
  ): Promise<void> {
    await writeJsonFile(
      join(this.workspaceDir(workspaceId), "leases.json"),
      leases
    );
  }

  async saveWorkspaceStatus(status: WorkspaceStatusSnapshot): Promise<void> {
    await writeJsonFile(
      join(this.workspaceDir(status.workspaceId), "status.json"),
      status
    );
  }

  async loadWorkspaceStatus(
    workspaceId: string
  ): Promise<WorkspaceStatusSnapshot | null> {
    return (
      (await readJsonFile<WorkspaceStatusSnapshot>(
        join(this.workspaceDir(workspaceId), "status.json")
      )) ?? null
    );
  }

  async loadRun(runId: string): Promise<OrchestratorRunRecord | null> {
    return (
      (await readJsonFile<OrchestratorRunRecord>(
        join(this.runDir(runId), "run.json")
      )) ?? null
    );
  }

  async loadAllRuns(): Promise<OrchestratorRunRecord[]> {
    const entries = await safeReadDir(this.runsDir());
    const runs = await Promise.all(entries.map((entry) => this.loadRun(entry)));
    return runs.filter((run): run is OrchestratorRunRecord => Boolean(run));
  }

  async saveRun(run: OrchestratorRunRecord): Promise<void> {
    await writeJsonFile(join(this.runDir(run.runId), "run.json"), run);
  }

  async appendRunEvent(runId: string, event: OrchestratorEvent): Promise<void> {
    const path = join(this.runDir(runId), "events.ndjson");
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(event) + "\n", "utf8");
  }

  issueWorkspaceDir(workspaceId: string, workspaceKey: string): string {
    return join(this.workspaceDir(workspaceId), "issues", workspaceKey);
  }

  async loadIssueWorkspace(
    workspaceId: string,
    workspaceKey: string
  ): Promise<IssueWorkspaceRecord | null> {
    return (
      (await readJsonFile<IssueWorkspaceRecord>(
        join(
          this.issueWorkspaceDir(workspaceId, workspaceKey),
          "workspace.json"
        )
      )) ?? null
    );
  }

  async loadIssueWorkspaces(
    workspaceId: string
  ): Promise<IssueWorkspaceRecord[]> {
    const issuesDir = join(this.workspaceDir(workspaceId), "issues");
    const entries = await safeReadDir(issuesDir);
    const records = await Promise.all(
      entries.map((entry) => this.loadIssueWorkspace(workspaceId, entry))
    );
    return records.filter((record): record is IssueWorkspaceRecord =>
      Boolean(record)
    );
  }

  async saveIssueWorkspace(record: IssueWorkspaceRecord): Promise<void> {
    await writeJsonFile(
      join(
        this.issueWorkspaceDir(record.workspaceId, record.workspaceKey),
        "workspace.json"
      ),
      record
    );
  }

  async removeIssueWorkspace(
    workspaceId: string,
    workspaceKey: string
  ): Promise<void> {
    const dir = this.issueWorkspaceDir(workspaceId, workspaceKey);
    await rm(dir, { recursive: true, force: true });
  }
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (isFileMissing(error)) {
      return null;
    }

    throw error;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporaryPath, path);
}

async function safeReadDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (isFileMissing(error)) {
      return [];
    }

    throw error;
  }
}

function isFileMissing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
