import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  deriveIssueWorkspaceKeyFromIdentifier,
  type IssueOrchestrationRecord,
  type IssueWorkspaceRecord,
  type IssueStatusEvent,
  type OrchestratorEvent,
  type OrchestratorRunRecord,
  type OrchestratorStateStore,
  type OrchestratorProjectConfig,
  type ProjectStatusSnapshot,
} from "@gh-symphony/core";

export class OrchestratorFsStore implements OrchestratorStateStore {
  private readonly resolvedRuntimeRoot: string;
  private readonly resolvedEventsMirrorRoot: string | null;

  constructor(
    readonly runtimeRoot: string,
    options: {
      eventsMirrorRoot?: string;
    } = {}
  ) {
    this.resolvedRuntimeRoot = resolve(runtimeRoot);
    this.resolvedEventsMirrorRoot = options.eventsMirrorRoot
      ? resolve(options.eventsMirrorRoot)
      : null;
  }

  private projectsRoot(): string {
    return join(this.runtimeRoot, "projects");
  }

  projectDir(projectId: string): string {
    return join(this.projectsRoot(), projectId);
  }

  private projectRunsDir(projectId: string): string {
    return join(this.projectDir(projectId), "runs");
  }

  runDir(runId: string, projectId?: string): string {
    if (!projectId) {
      return join(this.runtimeRoot, "projects", "__unknown__", "runs", runId);
    }

    return join(this.projectRunsDir(projectId), runId);
  }

  async loadProjectConfig(
    projectId: string
  ): Promise<OrchestratorProjectConfig | null> {
    return readJsonFile<OrchestratorProjectConfig>(
      join(this.projectDir(projectId), "project.json")
    );
  }

  async saveProjectConfig(config: OrchestratorProjectConfig): Promise<void> {
    await writeJsonFile(
      join(this.projectDir(config.projectId), "project.json"),
      config
    );
  }

  async loadProjectIssueOrchestrations(
    projectId: string
  ): Promise<IssueOrchestrationRecord[]> {
    const issuesPath = join(this.projectDir(projectId), "issues.json");
    const issues = await readJsonFile<IssueOrchestrationRecord[]>(issuesPath);
    if (issues) {
      return issues;
    }

    const legacyLeases =
      (await readJsonFile<
        Array<{
          issueId: string;
          issueIdentifier: string;
          runId: string;
          status: "active" | "released";
          updatedAt: string;
        }>
      >(join(this.projectDir(projectId), "leases.json"))) ?? [];

    if (legacyLeases.length === 0) {
      return [];
    }

    const migratedIssues: IssueOrchestrationRecord[] = legacyLeases.map(
      (lease) => ({
        issueId: lease.issueId,
        identifier: lease.issueIdentifier,
        workspaceKey: deriveIssueWorkspaceKeyFromIdentifier(
          lease.issueIdentifier
        ),
        state: lease.status === "active" ? "claimed" : "released",
        currentRunId: lease.status === "active" ? lease.runId : null,
        retryEntry: null,
        updatedAt: lease.updatedAt,
      })
    );

    await this.saveProjectIssueOrchestrations(projectId, migratedIssues);
    return migratedIssues;
  }

  async saveProjectIssueOrchestrations(
    projectId: string,
    issues: IssueOrchestrationRecord[]
  ): Promise<void> {
    await writeJsonFile(
      join(this.projectDir(projectId), "issues.json"),
      issues
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

  async loadRun(
    runId: string,
    projectId?: string
  ): Promise<OrchestratorRunRecord | null> {
    const runDirectory =
      projectId !== undefined
        ? this.runDir(runId, projectId)
        : await this.findRunDir(runId);
    if (!runDirectory) {
      return null;
    }

    return (
      (await readJsonFile<OrchestratorRunRecord>(
        join(runDirectory, "run.json")
      )) ?? null
    );
  }

  async loadAllRuns(): Promise<OrchestratorRunRecord[]> {
    const projectIds = await safeReadDir(this.projectsRoot());
    const runDirectories = await Promise.all(
      projectIds.map(async (projectId) => {
        const entries = await safeReadDir(this.projectRunsDir(projectId));
        return entries.map((entry) => this.runDir(entry, projectId));
      })
    );
    const runs = await Promise.all(
      runDirectories
        .flat()
        .map((directory) =>
          readJsonFile<OrchestratorRunRecord>(join(directory, "run.json"))
        )
    );
    return runs.filter((run): run is OrchestratorRunRecord => Boolean(run));
  }

  async saveRun(run: OrchestratorRunRecord): Promise<void> {
    await writeJsonFile(
      join(this.runDir(run.runId, run.projectId), "run.json"),
      run
    );
  }

  async appendRunEvent(runId: string, event: OrchestratorEvent): Promise<void> {
    const resolvedProjectId =
      "projectId" in event && typeof event.projectId === "string"
        ? event.projectId
        : undefined;
    const runDirectory =
      resolvedProjectId !== undefined
        ? this.runDir(runId, resolvedProjectId)
        : await this.findRunDir(runId);
    if (!runDirectory) {
      throw new Error(
        `Unable to resolve run directory for event append: ${runId}`
      );
    }

    const path = join(runDirectory, "events.ndjson");
    const resolvedPath = resolve(path);
    const serializedEvent = JSON.stringify(event) + "\n";
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, serializedEvent, {
      encoding: "utf8",
      mode: 0o666,
    });

    const mirrorPath = this.resolveMirroredEventsPath(resolvedPath);
    if (!mirrorPath) {
      return;
    }

    try {
      await mkdir(dirname(mirrorPath), { recursive: true });
      await appendFile(mirrorPath, serializedEvent, {
        encoding: "utf8",
        mode: 0o666,
      });
    } catch (error) {
      console.warn(
        `Failed to mirror orchestrator event log to ${mirrorPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async loadRecentRunEvents(
    runId: string,
    limit = 20,
    projectId?: string
  ): Promise<IssueStatusEvent[]> {
    const runDirectory =
      projectId !== undefined
        ? this.runDir(runId, projectId)
        : await this.findRunDir(runId);
    if (!runDirectory) {
      return [];
    }

    const path = join(runDirectory, "events.ndjson");
    try {
      if (limit <= 0) {
        return [];
      }

      const handle = await open(path, "r");
      try {
        const stats = await handle.stat();
        let position = stats.size;
        let tail = Buffer.alloc(0);

        while (position > 0) {
          const readSize = Math.min(position, 4_096);
          position -= readSize;

          const chunk = Buffer.allocUnsafe(readSize);
          await handle.read(chunk, 0, readSize, position);
          tail = Buffer.concat([chunk, tail]);

          const events = parseRecentEvents(tail.toString("utf8"), limit, {
            allowPartialFirstLine: position > 0,
          });
          if (events.length >= limit) {
            return events;
          }
        }

        return parseRecentEvents(tail.toString("utf8"), limit, {
          allowPartialFirstLine: false,
        });
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isFileMissing(error)) {
        return [];
      }

      throw error;
    }
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
        join(this.issueWorkspaceDir(projectId, workspaceKey), "workspace.json")
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

  private async findRunDir(runId: string): Promise<string | null> {
    const projectIds = await safeReadDir(this.projectsRoot());
    for (const projectId of projectIds) {
      const candidate = this.runDir(runId, projectId);
      const run = await readJsonFile<OrchestratorRunRecord>(
        join(candidate, "run.json")
      );
      if (run || (await pathExists(join(candidate, "events.ndjson")))) {
        return candidate;
      }
    }

    return null;
  }

  private resolveMirroredEventsPath(primaryPath: string): string | null {
    if (!this.resolvedEventsMirrorRoot) {
      return null;
    }

    const relativePath = relative(this.resolvedRuntimeRoot, primaryPath);
    if (relativePath.startsWith("..")) {
      return null;
    }

    const mirrorPath = join(this.resolvedEventsMirrorRoot, relativePath);
    return mirrorPath === primaryPath ? null : mirrorPath;
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isFileMissing(error)) {
      return false;
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

function formatEventMessage(event: OrchestratorEvent): string | null {
  switch (event.event) {
    case "run-dispatched":
      return event.issueState
        ? `Dispatched from ${event.issueState}`
        : "Dispatched";
    case "run-recovered":
      return "Recovered existing run";
    case "run-retried":
      return `Retry ${event.attempt} scheduled (${event.retryKind})`;
    case "run-failed":
      return event.lastError;
    case "run-suppressed":
      return event.reason;
    case "hook-executed":
      return `${event.hook}: ${event.outcome}`;
    case "hook-failed":
      return event.error;
    case "workspace-cleanup":
      return event.error ? `${event.outcome}: ${event.error}` : event.outcome;
    case "worker-error":
      return event.error;
    default:
      return null;
  }
}

function parseRecentEvents(
  raw: string,
  limit: number,
  options: { allowPartialFirstLine: boolean }
): IssueStatusEvent[] {
  const lines = raw.split("\n");
  if (options.allowPartialFirstLine) {
    lines.shift();
  }

  const events: IssueStatusEvent[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    const event = parseRunEventLine(line);
    if (!event) {
      continue;
    }

    events.push({
      at: event.at,
      event: event.event,
      message: formatEventMessage(event),
    });
    if (events.length === limit) {
      break;
    }
  }

  return events.reverse();
}

function parseRunEventLine(line: string): OrchestratorEvent | null {
  try {
    return JSON.parse(line) as OrchestratorEvent;
  } catch {
    return null;
  }
}
