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
  OrchestratorTenantConfig,
  TenantLeaseRecord,
  TenantStatusSnapshot,
} from "@gh-symphony/core";

export class OrchestratorFsStore implements OrchestratorStateStore {
  constructor(readonly runtimeRoot: string) {}

  tenantDir(tenantId: string): string {
    return join(this.runtimeRoot, "orchestrator", "tenants", tenantId);
  }

  runsDir(): string {
    return join(this.runtimeRoot, "orchestrator", "runs");
  }

  runDir(runId: string): string {
    return join(this.runsDir(), runId);
  }

  async loadTenantConfigs(): Promise<OrchestratorTenantConfig[]> {
    const baseDir = join(this.runtimeRoot, "orchestrator", "tenants");
    const entries = await safeReadDir(baseDir);
    const configs = await Promise.all(
      entries.map(async (entry) => {
        const config = await readJsonFile<OrchestratorTenantConfig>(
          join(baseDir, entry, "config.json")
        );
        return config;
      })
    );

    return configs.filter((config): config is OrchestratorTenantConfig =>
      Boolean(config)
    );
  }

  async saveTenantConfig(
    config: OrchestratorTenantConfig
  ): Promise<void> {
    await writeJsonFile(
      join(this.tenantDir(config.tenantId), "config.json"),
      config
    );
  }

  async loadTenantLeases(
    tenantId: string
  ): Promise<TenantLeaseRecord[]> {
    return (
      (await readJsonFile<TenantLeaseRecord[]>(
        join(this.tenantDir(tenantId), "leases.json")
      )) ?? []
    );
  }

  async saveTenantLeases(
    tenantId: string,
    leases: TenantLeaseRecord[]
  ): Promise<void> {
    await writeJsonFile(
      join(this.tenantDir(tenantId), "leases.json"),
      leases
    );
  }

  async saveTenantStatus(status: TenantStatusSnapshot): Promise<void> {
    await writeJsonFile(
      join(this.tenantDir(status.tenantId), "status.json"),
      status
    );
  }

  async loadTenantStatus(
    tenantId: string
  ): Promise<TenantStatusSnapshot | null> {
    return (
      (await readJsonFile<TenantStatusSnapshot>(
        join(this.tenantDir(tenantId), "status.json")
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

  issueWorkspaceDir(tenantId: string, workspaceKey: string): string {
    return join(this.tenantDir(tenantId), "issues", workspaceKey);
  }

  async loadIssueWorkspace(
    tenantId: string,
    workspaceKey: string
  ): Promise<IssueWorkspaceRecord | null> {
    return (
      (await readJsonFile<IssueWorkspaceRecord>(
        join(
          this.issueWorkspaceDir(tenantId, workspaceKey),
          "workspace.json"
        )
      )) ?? null
    );
  }

  async loadIssueWorkspaces(
    tenantId: string
  ): Promise<IssueWorkspaceRecord[]> {
    const issuesDir = join(this.tenantDir(tenantId), "issues");
    const entries = await safeReadDir(issuesDir);
    const records = await Promise.all(
      entries.map((entry) => this.loadIssueWorkspace(tenantId, entry))
    );
    return records.filter((record): record is IssueWorkspaceRecord =>
      Boolean(record)
    );
  }

  async saveIssueWorkspace(record: IssueWorkspaceRecord): Promise<void> {
    await writeJsonFile(
      join(
        this.issueWorkspaceDir(record.tenantId, record.workspaceKey),
        "workspace.json"
      ),
      record
    );
  }

  async removeIssueWorkspace(
    tenantId: string,
    workspaceKey: string
  ): Promise<void> {
    const dir = this.issueWorkspaceDir(tenantId, workspaceKey);
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
