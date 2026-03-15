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
  OrchestratorProjectConfig,
  ProjectLeaseRecord,
  ProjectStatusSnapshot,
} from "@gh-symphony/core";

export class OrchestratorFsStore implements OrchestratorStateStore {
  constructor(readonly runtimeRoot: string) {}

  projectDir(projectId: string): string {
    return join(this.runtimeRoot, "orchestrator", "projects", projectId);
  }

  runsDir(): string {
    return join(this.runtimeRoot, "orchestrator", "runs");
  }

  runDir(runId: string): string {
    return join(this.runsDir(), runId);
  }

  async loadProjectConfigs(): Promise<OrchestratorProjectConfig[]> {
    const baseDir = join(this.runtimeRoot, "orchestrator", "projects");
    const entries = await safeReadDir(baseDir);
    const configs = await Promise.all(
      entries.map(async (entry) => {
        const config = await readJsonFile<OrchestratorProjectConfig>(
          join(baseDir, entry, "config.json")
        );
        return config;
      })
    );

    return configs.filter((config): config is OrchestratorProjectConfig =>
      Boolean(config)
    );
  }

  async saveProjectConfig(
    config: OrchestratorProjectConfig
  ): Promise<void> {
    await writeJsonFile(
      join(this.projectDir(config.projectId), "config.json"),
      config
    );
  }

  async loadProjectLeases(
    projectId: string
  ): Promise<ProjectLeaseRecord[]> {
    return (
      (await readJsonFile<ProjectLeaseRecord[]>(
        join(this.projectDir(projectId), "leases.json")
      )) ?? []
    );
  }

  async saveProjectLeases(
    projectId: string,
    leases: ProjectLeaseRecord[]
  ): Promise<void> {
    await writeJsonFile(
      join(this.projectDir(projectId), "leases.json"),
      leases
    );
  }

  async saveProjectStatus(status: ProjectStatusSnapshot): Promise<void> {
    await writeJsonFile(
      join(this.projectDir(status.projectId), "status.json"),
      status
    );
  }

  async loadProjectStatus(
    projectId: string
  ): Promise<ProjectStatusSnapshot | null> {
    return (
      (await readJsonFile<ProjectStatusSnapshot>(
        join(this.projectDir(projectId), "status.json")
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

  issueWorkspaceDir(projectId: string, workspaceKey: string): string {
    return join(this.projectDir(projectId), "issues", workspaceKey);
  }

  async loadIssueWorkspace(
    projectId: string,
    workspaceKey: string
  ): Promise<IssueWorkspaceRecord | null> {
    return (
      (await readJsonFile<IssueWorkspaceRecord>(
        join(
          this.issueWorkspaceDir(projectId, workspaceKey),
          "workspace.json"
        )
      )) ?? null
    );
  }

  async loadIssueWorkspaces(
    projectId: string
  ): Promise<IssueWorkspaceRecord[]> {
    const issuesDir = join(this.projectDir(projectId), "issues");
    const entries = await safeReadDir(issuesDir);
    const records = await Promise.all(
      entries.map((entry) => this.loadIssueWorkspace(projectId, entry))
    );
    return records.filter((record): record is IssueWorkspaceRecord =>
      Boolean(record)
    );
  }

  async saveIssueWorkspace(record: IssueWorkspaceRecord): Promise<void> {
    await writeJsonFile(
      join(
        this.issueWorkspaceDir(record.projectId, record.workspaceKey),
        "workspace.json"
      ),
      record
    );
  }

  async removeIssueWorkspace(
    projectId: string,
    workspaceKey: string
  ): Promise<void> {
    const dir = this.issueWorkspaceDir(projectId, workspaceKey);
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
