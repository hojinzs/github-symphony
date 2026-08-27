import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  getProcessIdentity,
  isProcessRunning,
  resolveProjectLockPath,
} from "@gh-symphony/orchestrator";
import {
  daemonPidPath,
  parseDaemonPidRecord,
  DEFAULT_CONFIG_DIR,
} from "./config.js";

const TTL_MS = 60_000;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export type InstanceEntry = {
  projectId: string;
  repo: string;
  repoPath: string;
  workspacePath: string;
  runtimeRoot: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string | null;
  processIdentity: string | null;
  endpoint?: string;
  phase?: string | null;
  standalone?: boolean;
};

export type ListedInstance = InstanceEntry & {
  status: "running" | "stale-registry" | "unregistered" | "stale-pidfile";
  uptimeMs: number;
};

/**
 * The registry namespace is distinct from runtime configuration. Daemon
 * children change the latter but inherit the former, keeping one host index.
 */
export function instancesRoot(): string {
  return (
    process.env.GH_SYMPHONY_INSTANCES_DIR ||
    join(process.env.GH_SYMPHONY_CONFIG_DIR || DEFAULT_CONFIG_DIR, "instances")
  );
}

function pathFor(
  entry: Pick<InstanceEntry, "runtimeRoot" | "projectId">
): string {
  const key = Buffer.from(
    `${resolve(entry.runtimeRoot)}\0${entry.projectId}`
  ).toString("base64url");
  return join(instancesRoot(), `${key}.json`);
}

async function ensureInstancesRoot(): Promise<void> {
  const root = instancesRoot();
  await mkdir(root, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(root, DIRECTORY_MODE);
}

export async function registerInstance(entry: InstanceEntry): Promise<void> {
  await ensureInstancesRoot();
  await writeFile(pathFor(entry), JSON.stringify(entry, null, 2) + "\n", {
    mode: FILE_MODE,
  });
}

export async function unregisterInstance(
  entry: Pick<InstanceEntry, "runtimeRoot" | "projectId">
): Promise<void> {
  await rm(pathFor(entry), { force: true });
}

export async function findLiveDuplicate(
  entry: Pick<InstanceEntry, "projectId" | "repoPath">
): Promise<InstanceEntry | null> {
  for (const candidate of await listInstances()) {
    if (
      candidate.repoPath === resolve(entry.repoPath) &&
      candidate.projectId === entry.projectId &&
      candidate.status === "running"
    )
      return candidate;
  }
  return null;
}

function isFresh(heartbeatAt: string | null | undefined, now: number): boolean {
  if (!heartbeatAt) return false;
  const timestamp = Date.parse(heartbeatAt);
  return Number.isFinite(timestamp) && now - timestamp <= TTL_MS;
}

function identityMatches(expected: string | null, pid: number): boolean {
  if (!isProcessRunning(pid)) return false;
  const actual = getProcessIdentity(pid);
  return expected === null || (actual !== null && expected === actual);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function isInstanceEntry(value: unknown): value is InstanceEntry {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as InstanceEntry).projectId === "string" &&
    typeof (value as InstanceEntry).runtimeRoot === "string" &&
    typeof (value as InstanceEntry).pid === "number"
  );
}

export async function listInstances(
  now = Date.now()
): Promise<ListedInstance[]> {
  let names: string[];
  try {
    names = await readdir(instancesRoot());
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const output: ListedInstance[] = [];
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    const entryPath = join(instancesRoot(), name);
    let entry: InstanceEntry;
    try {
      const parsed = await readJson(entryPath);
      if (!isInstanceEntry(parsed)) continue;
      entry = parsed;
    } catch {
      continue;
    }

    let lock: { heartbeatAt?: string | null } | null = null;
    try {
      lock = (await readJson(
        resolveProjectLockPath(entry.runtimeRoot, entry.projectId)
      )) as { heartbeatAt?: string | null };
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const running = Boolean(
      lock &&
      isFresh(lock.heartbeatAt, now) &&
      identityMatches(entry.processIdentity, entry.pid)
    );
    const pidRecord = parseDaemonPidRecord(
      await readFile(
        daemonPidPath(entry.runtimeRoot, entry.projectId),
        "utf8"
      ).catch(() => "")
    );
    const stalePidfile = Boolean(
      pidRecord && !identityMatches(pidRecord.processIdentity, pidRecord.pid)
    );
    const phase = await readCurrentPhase(entry.runtimeRoot, entry.projectId);
    output.push({
      ...entry,
      phase,
      status: !running
        ? "stale-registry"
        : stalePidfile
          ? "stale-pidfile"
          : "running",
      uptimeMs: Math.max(0, now - Date.parse(entry.startedAt)),
    });
  }
  return output;
}

async function readCurrentPhase(
  runtimeRoot: string,
  projectId: string
): Promise<string | null> {
  try {
    const status = (await readJson(
      join(runtimeRoot, "projects", projectId, "status.json")
    )) as {
      activeRuns?: Array<{ executionPhase?: unknown }>;
    };
    const phase = status.activeRuns?.[0]?.executionPhase;
    return typeof phase === "string" ? phase : null;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ((error as { code?: string }).code === "ENOENT" ||
      (error as { code?: string }).code === "ENOTDIR")
  );
}

export async function instancesRootMode(): Promise<number> {
  return (await stat(instancesRoot())).mode & 0o777;
}
