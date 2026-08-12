import { createHash } from "node:crypto";
import { chmod, mkdir, open, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  deriveIssueWorkspaceKeyFromIdentifier,
  isFileMissing,
  type IssueOrchestrationRecord,
  type IssueWorkspaceRecord,
  type IssueStatusEvent,
  type OrchestratorEvent,
  type OrchestratorRunRecord,
  type OrchestratorStateStore,
  type OrchestratorProjectConfig,
  parseRecentEvents,
  redactObservabilitySecrets,
  type ProjectStatusSnapshot,
  readJsonFile,
  safeReadDir,
} from "@gh-symphony/core";
import { appendFileDurably, writeFileAtomically } from "./durable-file.js";

const PROJECTS_DIR = "projects";
const SECURE_DIRECTORY_MODE = 0o700;

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

  projectDir(projectId?: string): string {
    if (!projectId) {
      return this.runtimeRoot;
    }

    return join(this.runtimeRoot, PROJECTS_DIR, encodeProjectId(projectId));
  }

  private legacyProjectDir(): string {
    return this.runtimeRoot;
  }

  private async ensureProjectDirectory(projectId?: string): Promise<void> {
    if (!projectId) {
      return;
    }

    const path = this.projectDir(projectId);
    await mkdir(path, { recursive: true, mode: SECURE_DIRECTORY_MODE });
    await chmod(path, SECURE_DIRECTORY_MODE);
  }

  private runsDir(projectId?: string): string {
    return join(this.projectDir(projectId), "runs");
  }

  runDir(runId: string, projectId?: string): string {
    return join(this.runsDir(projectId), runId);
  }

  async loadProjectConfig(
    projectId?: string
  ): Promise<OrchestratorProjectConfig | null> {
    const config =
      (await readJsonFile<OrchestratorProjectConfig>(
        join(this.projectDir(projectId), "project.json")
      )) ??
      (projectId
        ? await readJsonFile<OrchestratorProjectConfig>(
            join(this.legacyProjectDir(), "project.json")
          )
        : null);

    return config ? normalizeProjectConfig(config) : null;
  }

  async saveProjectConfig(config: OrchestratorProjectConfig): Promise<void> {
    await this.ensureProjectDirectory(config.projectId);
    await writeJsonFile(
      join(this.projectDir(config.projectId), "project.json"),
      normalizeProjectConfig(config)
    );
  }

  async loadProjectIssueOrchestrations(
    projectId?: string
  ): Promise<IssueOrchestrationRecord[]> {
    const issues =
      (await readJsonFile<IssueOrchestrationRecord[]>(
        join(this.projectDir(projectId), "issues.json")
      )) ??
      (projectId
        ? await readJsonFile<IssueOrchestrationRecord[]>(
            join(this.legacyProjectDir(), "issues.json")
          )
        : null);
    if (issues) {
      return issues.map((issue) => ({
        ...issue,
        completedOnce: issue.completedOnce ?? false,
        failureRetryCount: issue.failureRetryCount ?? 0,
      }));
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
      >(join(this.projectDir(projectId), "leases.json"))) ??
      (projectId
        ? await readJsonFile<
            Array<{
              issueId: string;
              issueIdentifier: string;
              runId: string;
              status: "active" | "released";
              updatedAt: string;
            }>
          >(join(this.legacyProjectDir(), "leases.json"))
        : null) ??
      [];

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
        completedOnce: false,
        failureRetryCount: 0,
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
    projectId: string | undefined,
    issues: IssueOrchestrationRecord[]
  ): Promise<void> {
    await this.ensureProjectDirectory(projectId);
    await writeJsonFile(
      join(this.projectDir(projectId), "issues.json"),
      issues
    );
  }

  async saveProjectStatus(status: ProjectStatusSnapshot): Promise<void> {
    const projectId = resolveProjectScopedStatusProjectId(status);
    await this.ensureProjectDirectory(projectId);
    await writeJsonFile(
      join(this.projectDir(projectId), "status.json"),
      status
    );
  }

  async loadProjectStatus(
    projectId?: string
  ): Promise<ProjectStatusSnapshot | null> {
    const status = await readJsonFile<ProjectStatusSnapshot>(
      join(this.projectDir(projectId), "status.json")
    );
    if (status || !projectId) {
      return status ?? null;
    }

    return (
      (await readJsonFile<ProjectStatusSnapshot>(
        join(this.legacyProjectDir(), "status.json")
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
    const projectIds = await this.listProjectIds();
    const runPaths = (await safeReadDir(this.runsDir())).map((runId) =>
      join(this.runDir(runId), "run.json")
    );
    for (const projectId of projectIds) {
      const runIds = await safeReadDir(this.runsDir(projectId));
      runPaths.push(
        ...runIds.map((runId) =>
          join(this.runDir(runId, projectId), "run.json")
        )
      );
    }
    const runs = await Promise.all(
      runPaths.map((runPath) => readJsonFile<OrchestratorRunRecord>(runPath))
    );
    return runs.filter((run): run is OrchestratorRunRecord => Boolean(run));
  }

  async saveRun(run: OrchestratorRunRecord): Promise<void> {
    await this.ensureProjectDirectory(run.projectId);
    await writeJsonFile(
      join(this.runDir(run.runId, run.projectId), "run.json"),
      redactObservabilitySecrets(run)
    );
  }

  async appendRunEvent(runId: string, event: OrchestratorEvent): Promise<void> {
    const redactedEvent = redactObservabilitySecrets(event);
    const resolvedProjectId =
      "projectId" in redactedEvent &&
      typeof redactedEvent.projectId === "string"
        ? redactedEvent.projectId
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
    const eventPayload = JSON.stringify(redactedEvent);
    const integrity = `sha256:${createHash("sha256")
      .update(eventPayload)
      .digest("hex")}`;
    const serializedEvent = `${eventPayload.slice(
      0,
      -1
    )},"integrity":"${integrity}"}\n`;
    await this.ensureProjectDirectory(resolvedProjectId);
    await appendFileDurably(path, serializedEvent, { mode: 0o644 });

    const mirrorPath = this.resolveMirroredEventsPath(resolvedPath);
    if (!mirrorPath) {
      return;
    }

    try {
      await appendFileDurably(mirrorPath, serializedEvent, { mode: 0o644 });
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

  issueWorkspaceDir(
    projectId: string | undefined,
    workspaceKey: string
  ): string {
    return join(this.projectDir(projectId), workspaceKey);
  }

  async loadIssueWorkspace(
    projectId: string | undefined,
    workspaceKey: string
  ): Promise<IssueWorkspaceRecord | null> {
    return (
      (await readJsonFile<IssueWorkspaceRecord>(
        join(this.issueWorkspaceDir(projectId, workspaceKey), "workspace.json")
      )) ??
      (projectId
        ? await readJsonFile<IssueWorkspaceRecord>(
            join(this.legacyProjectDir(), workspaceKey, "workspace.json")
          )
        : null)
    );
  }

  async loadIssueWorkspaces(
    projectId?: string
  ): Promise<IssueWorkspaceRecord[]> {
    const entries = [
      ...(await safeReadDir(this.projectDir(projectId))),
      ...(projectId ? await safeReadDir(this.legacyProjectDir()) : []),
    ];
    const uniqueEntries = [...new Set(entries)];
    const records = await Promise.all(
      uniqueEntries.map(async (entry) => {
        if (!(await this.isIssueWorkspaceEntry(projectId, entry))) {
          return null;
        }

        return (
          (await this.loadIssueWorkspace(projectId, entry)) ??
          (projectId
            ? await readJsonFile<IssueWorkspaceRecord>(
                join(this.legacyProjectDir(), entry, "workspace.json")
              )
            : null)
        );
      })
    );
    return records.filter((record): record is IssueWorkspaceRecord =>
      Boolean(record)
    );
  }

  private async isIssueWorkspaceEntry(
    projectId: string | undefined,
    entry: string
  ): Promise<boolean> {
    if (
      entry.startsWith(".") ||
      entry === "cache" ||
      entry === "issues.json" ||
      entry === PROJECTS_DIR ||
      entry === "project.json" ||
      entry === "runs" ||
      entry === "status.json"
    ) {
      return false;
    }

    try {
      const primary = join(this.projectDir(projectId), entry);
      if ((await pathExists(primary)) && (await stat(primary)).isDirectory()) {
        return true;
      }

      if (!projectId) {
        return false;
      }

      const legacy = join(this.legacyProjectDir(), entry);
      return (await pathExists(legacy)) && (await stat(legacy)).isDirectory();
    } catch {
      return false;
    }
  }

  async saveIssueWorkspace(record: IssueWorkspaceRecord): Promise<void> {
    await this.ensureProjectDirectory(record.projectId);
    await writeJsonFile(
      join(
        this.issueWorkspaceDir(record.projectId, record.workspaceKey),
        "workspace.json"
      ),
      record
    );
  }

  async removeIssueWorkspace(
    projectId: string | undefined,
    workspaceKey: string
  ): Promise<void> {
    const dir = this.issueWorkspaceDir(projectId, workspaceKey);
    await rm(dir, { recursive: true, force: true });
  }

  private async findRunDir(runId: string): Promise<string | null> {
    const candidate = this.runDir(runId);
    const run = await readJsonFile<OrchestratorRunRecord>(
      join(candidate, "run.json")
    );
    if (run || (await pathExists(join(candidate, "events.ndjson")))) {
      return candidate;
    }

    for (const projectId of await this.listProjectIds()) {
      const projectCandidate = this.runDir(runId, projectId);
      const projectRun = await readJsonFile<OrchestratorRunRecord>(
        join(projectCandidate, "run.json")
      );
      if (
        projectRun ||
        (await pathExists(join(projectCandidate, "events.ndjson")))
      ) {
        return projectCandidate;
      }
    }

    return null;
  }

  private async listProjectIds(): Promise<string[]> {
    const entries = await safeReadDir(join(this.runtimeRoot, PROJECTS_DIR));
    const ids: string[] = [];
    for (const entry of entries) {
      try {
        if (
          (
            await stat(join(this.runtimeRoot, PROJECTS_DIR, entry))
          ).isDirectory()
        ) {
          ids.push(decodeProjectId(entry));
        }
      } catch {
        // Ignore entries that disappear during concurrent reads.
      }
    }
    return ids;
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

function normalizeProjectConfig(
  config: OrchestratorProjectConfig
): OrchestratorProjectConfig {
  const workflowSource = config.workflowSource ?? { type: "repo" };

  if (workflowSource.type === "external") {
    if (!workflowSource.path) {
      throw new Error("External workflow source requires a path.");
    }
    if (!isAbsolute(workflowSource.path)) {
      throw new Error("External workflow source path must be absolute.");
    }
  }

  return {
    ...config,
    workflowSource,
    populateStrategy: config.populateStrategy ?? "clone",
  };
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFileAtomically(path, JSON.stringify(value, null, 2) + "\n");
}

function encodeProjectId(projectId: string): string {
  return encodeURIComponent(projectId);
}

function decodeProjectId(encodedProjectId: string): string {
  try {
    return decodeURIComponent(encodedProjectId);
  } catch {
    return encodedProjectId;
  }
}

function resolveProjectScopedStatusProjectId(
  status: ProjectStatusSnapshot
): string {
  if ("projectId" in status && typeof status.projectId === "string") {
    return status.projectId;
  }

  throw new Error("Project status writes require a projectId.");
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
