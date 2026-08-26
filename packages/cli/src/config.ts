import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { getProcessIdentity } from "@gh-symphony/orchestrator";
import { normalizeOrchestratorProjectConfig } from "@gh-symphony/core";
import type {
  OrchestratorProjectConfig,
  OrchestratorTrackerSettingValue,
  RepositoryRef,
} from "@gh-symphony/core";

export const DEFAULT_CONFIG_DIR = join(homedir(), ".gh-symphony");
export const CONFIG_FILE = "config.json";
export const DAEMON_PID_FILE = "daemon.pid";
export const ORCHESTRATOR_LOG_FILE = "orchestrator.log";
export const HTTP_STATUS_FILE = "http.json";
export const REPO_RUNTIME_DIR = join(".runtime", "orchestrator");
const CONFIG_LOCK_FILE = ".config.lock";
const CONFIG_LOCK_TTL_MS = 30_000;
const CONFIG_LOCK_RETRY_MS = 20;
const CONFIG_LOCK_RETRY_LIMIT =
  Math.ceil(CONFIG_LOCK_TTL_MS / CONFIG_LOCK_RETRY_MS) + 50;

type ConfigLockRecord = {
  ownerToken: string;
  pid: number;
  startedAt: string;
  processIdentity: string | null;
};

export type DaemonPidRecord = {
  pid: number;
  startedAt: string;
  processIdentity: string | null;
  cwd: string | null;
};

export type CliGlobalConfig = {
  activeProject: string | null;
  projects: string[];
};

export type CliProjectTrackerSettings = Record<
  string,
  OrchestratorTrackerSettingValue
> & {
  projectId?: string;
  repository?: string;
  assignedOnly?: boolean;
  timeoutMs?: number;
};

export type CliProjectConfig = Omit<
  OrchestratorProjectConfig,
  "repository" | "tracker"
> & {
  displayName?: string;
  repository?: RepositoryRef;
  tracker: Omit<OrchestratorProjectConfig["tracker"], "settings"> & {
    settings?: CliProjectTrackerSettings;
  };
};

export type StateRole = "active" | "wait" | "terminal";

export type StateMapping = { role: StateRole; goal?: string };

export function resolveConfigDir(override?: string): string {
  if (override) {
    return override;
  }
  if (process.env.GH_SYMPHONY_CONFIG_DIR) {
    return process.env.GH_SYMPHONY_CONFIG_DIR;
  }

  const repoRuntimeDir = resolve(process.cwd(), REPO_RUNTIME_DIR);
  if (existsSync(configFilePath(repoRuntimeDir))) {
    return repoRuntimeDir;
  }

  return DEFAULT_CONFIG_DIR;
}

export function configFilePath(configDir: string): string {
  return join(configDir, CONFIG_FILE);
}

export function projectConfigDir(configDir: string, projectId: string): string {
  return join(configDir, "projects", projectId);
}

export function projectConfigPath(
  configDir: string,
  projectId: string
): string {
  return join(projectConfigDir(configDir, projectId), "project.json");
}

export function daemonPidPath(configDir: string, projectId: string): string {
  return join(projectConfigDir(configDir, projectId), DAEMON_PID_FILE);
}

export function orchestratorLogPath(
  configDir: string,
  projectId: string
): string {
  return join(projectConfigDir(configDir, projectId), ORCHESTRATOR_LOG_FILE);
}

export function orchestratorWorkspaceRuntimeDir(
  configDir: string,
  projectId: string
): string {
  return join(configDir, "orchestrator", "workspaces", projectId);
}

export function httpStatusPath(configDir: string, projectId: string): string {
  return join(
    orchestratorWorkspaceRuntimeDir(configDir, projectId),
    HTTP_STATUS_FILE
  );
}

export async function loadGlobalConfig(
  configDir: string
): Promise<CliGlobalConfig | null> {
  const raw = await readJsonFile<Partial<CliGlobalConfig>>(
    configFilePath(configDir)
  );
  if (!raw) {
    return null;
  }

  return {
    activeProject:
      typeof raw.activeProject === "string" ? raw.activeProject : null,
    projects: Array.isArray(raw.projects)
      ? raw.projects.filter(
          (projectId): projectId is string => typeof projectId === "string"
        )
      : [],
  };
}

export async function saveGlobalConfig(
  configDir: string,
  config: CliGlobalConfig
): Promise<void> {
  await withConfigLock(configDir, () =>
    writeJsonFile(configFilePath(configDir), config)
  );
}

export async function updateGlobalConfig(
  configDir: string,
  update: (config: CliGlobalConfig) => CliGlobalConfig | null
): Promise<boolean> {
  return withConfigLock(configDir, async () => {
    const current =
      (await loadGlobalConfig(configDir)) ??
      ({ activeProject: null, projects: [] } satisfies CliGlobalConfig);
    const next = update(current);
    if (!next) {
      return false;
    }
    await writeJsonFile(configFilePath(configDir), next);
    return true;
  });
}

export async function loadProjectConfig(
  configDir: string,
  projectId: string
): Promise<CliProjectConfig | null> {
  const config = await readJsonFile<CliProjectConfig>(
    projectConfigPath(configDir, projectId)
  );
  return config
    ? (normalizeOrchestratorProjectConfig(
        config as OrchestratorProjectConfig
      ) as CliProjectConfig)
    : null;
}

export async function saveProjectConfig(
  configDir: string,
  projectId: string,
  config: CliProjectConfig
): Promise<void> {
  await withConfigLock(configDir, () =>
    writeJsonFile(
      projectConfigPath(configDir, projectId),
      normalizeOrchestratorProjectConfig(
        config as OrchestratorProjectConfig
      ) as CliProjectConfig
    )
  );
}

/** Writes a project config while the caller already owns the config lock. */
export async function saveProjectConfigWithinLock(
  configDir: string,
  projectId: string,
  config: CliProjectConfig
): Promise<void> {
  await writeJsonFile(
    projectConfigPath(configDir, projectId),
    normalizeOrchestratorProjectConfig(
      config as OrchestratorProjectConfig
    ) as CliProjectConfig
  );
}

export async function loadActiveProjectConfig(
  configDir: string
): Promise<CliProjectConfig | null> {
  const global = await loadGlobalConfig(configDir);
  if (!global?.activeProject) {
    return null;
  }
  return loadProjectConfig(configDir, global.activeProject);
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

export async function writeJsonFile(
  path: string,
  value: unknown
): Promise<void> {
  await writeFileAtomically(path, JSON.stringify(value, null, 2) + "\n");
}

async function writeFileAtomically(path: string, data: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  let temporaryExists = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    temporaryExists = false;
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (temporaryExists) {
      await rm(temporaryPath, { force: true });
    }
  }
}

export function parseDaemonPidRecord(raw: string): DaemonPidRecord | null {
  const legacyPid = Number(raw.trim());
  if (Number.isInteger(legacyPid) && legacyPid > 0) {
    return {
      pid: legacyPid,
      startedAt: "",
      processIdentity: null,
      cwd: null,
    };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<DaemonPidRecord>;
    if (
      !Number.isInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      typeof parsed.startedAt !== "string" ||
      (parsed.processIdentity !== null &&
        typeof parsed.processIdentity !== "string") ||
      (parsed.cwd !== undefined &&
        parsed.cwd !== null &&
        typeof parsed.cwd !== "string")
    ) {
      return null;
    }
    return { ...parsed, cwd: parsed.cwd ?? null } as DaemonPidRecord;
  } catch {
    return null;
  }
}

export async function withConfigLock<T>(
  configDir: string,
  action: () => Promise<T>
): Promise<T> {
  await mkdir(configDir, { recursive: true });
  const lockPath = join(configDir, CONFIG_LOCK_FILE);
  const record: ConfigLockRecord = {
    ownerToken: `${process.pid}:${randomUUID()}`,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    processIdentity: getProcessIdentity(process.pid),
  };

  for (let attempt = 0; ; attempt += 1) {
    try {
      await publishConfigLock(lockPath, record);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      if (await isStaleConfigLock(lockPath)) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (attempt >= CONFIG_LOCK_RETRY_LIMIT) {
        throw new Error(`Timed out waiting for config lock at "${lockPath}".`);
      }
      await delay(CONFIG_LOCK_RETRY_MS);
    }
  }

  try {
    return await action();
  } finally {
    try {
      const current = JSON.parse(
        await readFile(lockPath, "utf8")
      ) as Partial<ConfigLockRecord>;
      if (current.ownerToken === record.ownerToken) {
        await rm(lockPath, { force: true });
      }
    } catch (error) {
      if (!isFileMissing(error)) {
        console.warn(
          `Failed to release config lock at "${lockPath}": ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
}

async function publishConfigLock(
  lockPath: string,
  record: ConfigLockRecord
): Promise<void> {
  const temporaryPath = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, lockPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function isStaleConfigLock(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf8");
    let record: Partial<ConfigLockRecord>;
    try {
      record = JSON.parse(raw) as Partial<ConfigLockRecord>;
    } catch {
      return isExpiredConfigLockFile(path);
    }
    if (
      !Number.isInteger(record.pid) ||
      (record.pid ?? 0) <= 0 ||
      typeof record.startedAt !== "string"
    ) {
      return isExpiredConfigLockFile(path);
    }
    if (!Number.isFinite(Date.parse(record.startedAt))) {
      return true;
    }
    try {
      process.kill(record.pid!, 0);
    } catch (error) {
      const processIsGone = Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ESRCH"
      );
      return processIsGone || (await isExpiredConfigLockFile(path));
    }
    const actualIdentity = getProcessIdentity(record.pid!);
    if (record.processIdentity && actualIdentity) {
      return record.processIdentity !== actualIdentity;
    }

    // A process that is positively identified as the original owner can hold
    // the lock through an arbitrarily long interactive confirmation. When
    // identity is unavailable, retain the TTL recovery path for orphaned or
    // recycled-PID locks instead of wedging the config directory forever.
    return isExpiredConfigLockFile(path);
  } catch (error) {
    if (isFileMissing(error)) {
      return false;
    }
    throw error;
  }
}

async function isExpiredConfigLockFile(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return Math.abs(Date.now() - metadata.mtimeMs) > CONFIG_LOCK_TTL_MS;
  } catch (error) {
    if (isFileMissing(error)) {
      return false;
    }
    throw error;
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function isFileMissing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
