import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  acquireProjectLock,
  releaseProjectLock,
  type ProjectLockHandle,
} from "@gh-symphony/orchestrator";
import {
  LIMITS,
  uuidSchema,
  type EnrollmentResponse,
  type ProjectObservation,
} from "@gh-symphony/management-protocol";

export interface AgentIdentity {
  environmentId: string;
  agentId: string;
  credential: string;
  serverOrigin: string;
}
export interface RegisteredProject {
  localProjectId: string;
  canonicalPath: string;
  registeredPath: string;
}
interface RegistryState {
  version: 1;
  identity: AgentIdentity | null;
  projects: RegisteredProject[];
}
/** Local metadata only; the server assigns aggregate project UUIDs. */
export type LocalInventory = Omit<ProjectObservation, "projectId">;
export interface LocalProjectMetadata {
  workflowRevision?: string;
  trackerScope?: {
    adapter: string;
    bindingId: string;
    repository: string;
    activeStates: string[];
    includeLabels: string[];
    excludeLabels: string[];
  };
}
export interface LocalInventoryReader {
  inspect(project: RegisteredProject): Promise<
    Pick<LocalInventory, "validation" | "process" | "runs"> & {
      metadata?: LocalProjectMetadata;
    }
  >;
}

/** Exactly the existing CLI folder-derived ID algorithm (no realpath inside it). */
export function localProjectId(projectDirInput: string): string {
  const path = resolve(projectDirInput);
  const slug = basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "project"}-${createHash("sha256").update(path).digest("hex").slice(0, 8)}`;
}

/** One instance owns all local configuration writes until close. */
export class AgentRegistry {
  private closed = false;
  private writes: Promise<unknown> = Promise.resolve();
  private constructor(
    readonly directory: string,
    private readonly lock: ProjectLockHandle,
    private state: RegistryState
  ) {}

  static async open(directory: string): Promise<AgentRegistry> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const canonicalDirectory = await realpath(directory);
    await chmod(canonicalDirectory, 0o700);
    const lock = await acquireProjectLock({
      runtimeRoot: canonicalDirectory,
      projectId: "management-agent",
      projectLabel: "management agent",
      lockPath: join(canonicalDirectory, "agent.lock"),
      cwd: canonicalDirectory,
    });
    try {
      const path = join(canonicalDirectory, "registry.json");
      let state: RegistryState = { version: 1, identity: null, projects: [] };
      try {
        const metadata = await lstat(path);
        if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
          throw new Error("Agent registry must be a user-only regular file");
        }
        state = parseState(await readFile(path, "utf8"));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      return new AgentRegistry(canonicalDirectory, lock, state);
    } catch (error) {
      await releaseProjectLock(lock);
      throw error;
    }
  }

  get identity(): AgentIdentity | null {
    this.assertOpen();
    return this.state.identity ? { ...this.state.identity } : null;
  }
  list(): RegisteredProject[] {
    this.assertOpen();
    return this.state.projects.map((project) => ({ ...project }));
  }
  async saveIdentity(
    serverOrigin: string,
    enrollment: EnrollmentResponse
  ): Promise<void> {
    const url = new URL(serverOrigin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("Agent server must be an HTTPS origin");
    }
    const identity: AgentIdentity = {
      environmentId: enrollment.environmentId,
      agentId: enrollment.agentId,
      credential: enrollment.credential,
      serverOrigin: url.origin,
    };
    validateIdentity(identity);
    await this.update((state) => {
      if (
        state.identity &&
        (state.identity.environmentId !== identity.environmentId ||
          state.identity.agentId !== identity.agentId ||
          state.identity.serverOrigin !== identity.serverOrigin)
      ) {
        throw new Error("Enrollment cannot replace another agent identity");
      }
      return { ...state, identity };
    });
  }
  async add(path: string): Promise<RegisteredProject> {
    const registeredPath = resolve(path);
    const canonicalPath = await realpath(registeredPath);
    if (!(await stat(canonicalPath)).isDirectory())
      throw new Error("Project must be a directory");
    const project = {
      registeredPath,
      canonicalPath,
      localProjectId: localProjectId(canonicalPath),
    };
    let result = project;
    await this.update((state) => {
      const existing = state.projects.find(
        (entry) => entry.canonicalPath === canonicalPath
      );
      if (existing) {
        result = { ...existing };
        return state;
      }
      if (state.projects.length >= LIMITS.managedProjectsPerAgent)
        throw new Error("Agent project limit reached");
      return { ...state, projects: [...state.projects, project] };
    });
    return result;
  }
  async remove(id: string): Promise<void> {
    // Configuration removal never signals, stops, or deletes a local runtime.
    await this.update((state) => ({
      ...state,
      projects: state.projects.filter((entry) => entry.localProjectId !== id),
    }));
  }
  async resolveManaged(id: string): Promise<RegisteredProject> {
    this.assertOpen();
    const project = this.state.projects.find(
      (entry) => entry.localProjectId === id
    );
    if (!project) throw new Error("project_unmanaged");
    try {
      if (
        (await realpath(project.registeredPath)) === project.canonicalPath &&
        (await realpath(project.canonicalPath)) === project.canonicalPath &&
        (await stat(project.canonicalPath)).isDirectory()
      ) {
        return { ...project };
      }
    } catch {
      // Missing, moved, or inaccessible folders revoke control identically.
    }
    throw new Error(
      "project_unmanaged: registered folder changed; re-register locally"
    );
  }
  async inventory(
    reader: LocalInventoryReader,
    cliVersion: string
  ): Promise<LocalInventory[]> {
    const projects = this.list();
    return Promise.all(
      projects.map(async (project) => {
        const observedAt = new Date().toISOString();
        const base = {
          localProjectId: project.localProjectId,
          canonicalPath: project.canonicalPath,
          displayName: basename(project.canonicalPath),
          cliVersion,
          observedAt,
        };
        try {
          const checked = await this.resolveManaged(project.localProjectId);
          const inspected = await reader.inspect(checked);
          // Explicit projection prevents accidental upload of workflow/config/credentials.
          return {
            ...base,
            validation: inspected.validation,
            process:
              inspected.process.state === "running"
                ? {
                    state: "running" as const,
                    pid: inspected.process.pid,
                    observedAt: inspected.process.observedAt,
                    // Wire process identity is opaque; keep raw OS command identity
                    // only in the local adapter/journal, never upload it.
                    identity: createHash("sha256")
                      .update(inspected.process.identity)
                      .digest("hex"),
                  }
                : inspected.process,
            runs: inspected.runs.map((run) => ({
              runId: run.runId,
              status: run.status,
              startedAt: run.startedAt,
              updatedAt: run.updatedAt,
            })),
            ...(inspected.metadata
              ? { snapshot: metadataSnapshot(inspected.metadata) }
              : {}),
          };
        } catch {
          const diagnostic = {
            code: "project_unmanaged" as const,
            message:
              "Registered folder unavailable or changed; inspect local registration",
          };
          return {
            ...base,
            validation: { state: "invalid" as const, diagnostic },
            process: { state: "unknown" as const, observedAt, diagnostic },
            runs: [],
          };
        }
      })
    );
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.writes;
    await releaseProjectLock(this.lock);
  }
  private assertOpen(): void {
    if (this.closed) throw new Error("Agent registry is closed");
  }
  private async update(
    transform: (state: RegistryState) => RegistryState
  ): Promise<void> {
    this.assertOpen();
    const task = this.writes.then(async () => {
      const next = transform(this.state);
      const path = join(this.directory, "registry.json");
      const temporary = join(this.directory, `.registry-${randomUUID()}`);
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(next) + "\n");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
        const directoryHandle = await open(dirname(path), "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
        this.state = next;
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.writes = task.catch(() => {});
    await task;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function validateIdentity(identity: AgentIdentity): void {
  uuidSchema.parse(identity.environmentId);
  uuidSchema.parse(identity.agentId);
  if (typeof identity.credential !== "string" || !identity.credential) {
    throw new Error("Invalid agent identity");
  }
  const origin = new URL(identity.serverOrigin);
  if (origin.protocol !== "https:" || origin.origin !== identity.serverOrigin)
    throw new Error("Invalid agent server origin");
}
function parseState(raw: string): RegistryState {
  const value = JSON.parse(raw) as RegistryState;
  if (
    value.version !== 1 ||
    !Array.isArray(value.projects) ||
    value.projects.length > LIMITS.managedProjectsPerAgent
  )
    throw new Error("Invalid agent registry");
  if (value.identity !== null) validateIdentity(value.identity);
  const ids = new Set<string>();
  for (const project of value.projects) {
    if (
      typeof project.canonicalPath !== "string" ||
      resolve(project.canonicalPath) !== project.canonicalPath ||
      typeof project.registeredPath !== "string" ||
      resolve(project.registeredPath) !== project.registeredPath ||
      project.localProjectId !== localProjectId(project.canonicalPath) ||
      ids.has(project.localProjectId)
    )
      throw new Error("Invalid registered project");
    ids.add(project.localProjectId);
  }
  return value;
}

function metadataSnapshot(metadata: LocalProjectMetadata): {
  [key: string]: import("@gh-symphony/management-protocol").JsonValue;
} {
  const scope = metadata.trackerScope;
  return {
    ...(metadata.workflowRevision
      ? { workflowRevision: metadata.workflowRevision }
      : {}),
    ...(scope
      ? {
          trackerScope: {
            adapter: scope.adapter,
            bindingId: scope.bindingId,
            repository: scope.repository,
            activeStates: [...scope.activeStates],
            includeLabels: [...scope.includeLabels],
            excludeLabels: [...scope.excludeLabels],
          },
        }
      : {}),
  };
}
