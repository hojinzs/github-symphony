import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
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
  projectConfigPath,
} from "./config.js";

const TTL_MS = 60_000;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const RUNTIME_ROOTS_FILE = "runtime-roots.json";

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
  endpoint?: string | null;
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
  await sweepStaleRecords();
  await rememberRuntimeRoot(entry.runtimeRoot);
  await writeFile(pathFor(entry), JSON.stringify(entry, null, 2) + "\n", {
    mode: FILE_MODE,
  });
}

export async function unregisterInstance(
  entry: Pick<InstanceEntry, "runtimeRoot" | "projectId" | "pid" | "startedAt">
): Promise<void> {
  const current = await readJson(pathFor(entry)).catch(() => null);
  if (
    !isInstanceEntry(current) ||
    (current.pid === entry.pid && current.startedAt === entry.startedAt)
  ) {
    await rm(pathFor(entry), { force: true });
  }
  await forgetRuntimeRootIfInactive(entry.runtimeRoot);
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
  const registeredKeys = new Set<string>();
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    if (name === RUNTIME_ROOTS_FILE) continue;
    const entryPath = join(instancesRoot(), name);
    let entry: InstanceEntry;
    try {
      const parsed = await readJson(entryPath);
      if (!isInstanceEntry(parsed)) continue;
      entry = parsed;
      registeredKeys.add(instanceKey(entry));
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
    const status = !running
      ? "stale-registry"
      : stalePidfile
        ? "stale-pidfile"
        : "running";
    output.push({
      ...entry,
      phase: status === "stale-registry" ? null : phase,
      ...(status === "stale-registry" ? { endpoint: null } : {}),
      status,
      uptimeMs: uptimeMs(entry.startedAt, now, status === "stale-registry"),
    });
  }
  output.push(...(await discoverUnregistered(registeredKeys, now)));
  return output;
}

function instanceKey(
  entry: Pick<InstanceEntry, "runtimeRoot" | "projectId">
): string {
  return `${resolve(entry.runtimeRoot)}\0${entry.projectId}`;
}

async function rememberRuntimeRoot(runtimeRoot: string): Promise<void> {
  const roots = await readRuntimeRoots();
  const resolvedRoot = resolve(runtimeRoot);
  if (!roots.includes(resolvedRoot)) {
    await writeRuntimeRoots([...roots, resolvedRoot]);
  }
}

async function forgetRuntimeRootIfInactive(runtimeRoot: string): Promise<void> {
  const resolvedRoot = resolve(runtimeRoot);
  if (await runtimeRootIsActive(resolvedRoot)) return;
  const roots = await readRuntimeRoots();
  await writeRuntimeRoots(roots.filter((root) => root !== resolvedRoot));
}

async function runtimeRootIsActive(runtimeRoot: string): Promise<boolean> {
  const names = await readdir(instancesRoot()).catch(() => []);
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    if (name === RUNTIME_ROOTS_FILE) continue;
    const entry = await readJson(join(instancesRoot(), name)).catch(() => null);
    if (isInstanceEntry(entry) && resolve(entry.runtimeRoot) === runtimeRoot) {
      return true;
    }
  }
  const projectIds = await readdir(join(runtimeRoot, "projects")).catch(
    () => []
  );
  return (
    await Promise.all(
      projectIds.map(async (projectId) => {
        const lock = (await readJson(
          resolveProjectLockPath(runtimeRoot, projectId)
        ).catch(() => null)) as {
          pid?: unknown;
          heartbeatAt?: unknown;
          processIdentity?: unknown;
        } | null;
        return Boolean(
          lock &&
          typeof lock.pid === "number" &&
          isFresh(
            typeof lock.heartbeatAt === "string" ? lock.heartbeatAt : null,
            Date.now()
          ) &&
          identityMatches(
            typeof lock.processIdentity === "string"
              ? lock.processIdentity
              : null,
            lock.pid
          )
        );
      })
    )
  ).some(Boolean);
}

function runtimeRootsPath(): string {
  return join(instancesRoot(), RUNTIME_ROOTS_FILE);
}

async function readRuntimeRoots(): Promise<string[]> {
  const existing = await readJson(runtimeRootsPath()).catch(() => []);
  return Array.isArray(existing)
    ? existing.filter((value): value is string => typeof value === "string")
    : [];
}

async function writeRuntimeRoots(roots: string[]): Promise<void> {
  const path = runtimeRootsPath();
  const temporaryPath = join(
    instancesRoot(),
    `.${RUNTIME_ROOTS_FILE}.${process.pid}.${randomUUID()}.tmp`
  );
  await writeFile(temporaryPath, JSON.stringify(roots, null, 2) + "\n", {
    mode: FILE_MODE,
  });
  await rename(temporaryPath, path);
}

async function sweepStaleRecords(): Promise<void> {
  const names = await readdir(instancesRoot()).catch(() => []);
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    if (name === RUNTIME_ROOTS_FILE) continue;
    const entryPath = join(instancesRoot(), name);
    const entry = await readJson(entryPath).catch(() => null);
    if (!isInstanceEntry(entry)) continue;
    const lock = (await readJson(
      resolveProjectLockPath(entry.runtimeRoot, entry.projectId)
    ).catch(() => null)) as { heartbeatAt?: unknown } | null;
    if (
      !lock ||
      !isFresh(
        typeof lock.heartbeatAt === "string" ? lock.heartbeatAt : null,
        Date.now()
      ) ||
      !identityMatches(entry.processIdentity, entry.pid)
    ) {
      await rm(entryPath, { force: true });
      await forgetRuntimeRootIfInactive(entry.runtimeRoot);
    }
  }
}

async function discoverUnregistered(
  registeredKeys: Set<string>,
  now: number
): Promise<ListedInstance[]> {
  const roots = await readRuntimeRoots();
  const discovered: ListedInstance[] = [];
  for (const runtimeRoot of roots.filter(
    (value): value is string => typeof value === "string"
  )) {
    const projectIds = await readdir(join(runtimeRoot, "projects")).catch(
      () => []
    );
    for (const projectId of projectIds) {
      if (registeredKeys.has(instanceKey({ runtimeRoot, projectId }))) continue;
      const lock = (await readJson(
        resolveProjectLockPath(runtimeRoot, projectId)
      ).catch(() => null)) as {
        pid?: unknown;
        startedAt?: unknown;
        heartbeatAt?: unknown;
        processIdentity?: unknown;
        cwd?: unknown;
      } | null;
      if (
        !lock ||
        typeof lock.pid !== "number" ||
        typeof lock.startedAt !== "string" ||
        !isFresh(
          typeof lock.heartbeatAt === "string" ? lock.heartbeatAt : null,
          now
        ) ||
        !identityMatches(
          typeof lock.processIdentity === "string"
            ? lock.processIdentity
            : null,
          lock.pid
        )
      )
        continue;
      const config = (await readJson(
        projectConfigPath(runtimeRoot, projectId)
      ).catch(() => null)) as {
        repository?: { owner?: string; name?: string };
        projectDir?: string;
        workspaceDir?: string;
      } | null;
      discovered.push({
        projectId,
        repo:
          config?.repository?.owner && config.repository.name
            ? `${config.repository.owner}/${config.repository.name}`
            : "unknown",
        repoPath: resolve(
          config?.projectDir ??
            (typeof lock.cwd === "string" ? lock.cwd : runtimeRoot)
        ),
        workspacePath: resolve(config?.workspaceDir ?? runtimeRoot),
        runtimeRoot: resolve(runtimeRoot),
        pid: lock.pid,
        startedAt: lock.startedAt,
        heartbeatAt:
          typeof lock.heartbeatAt === "string" ? lock.heartbeatAt : null,
        processIdentity:
          typeof lock.processIdentity === "string"
            ? lock.processIdentity
            : null,
        standalone: true,
        phase: await readCurrentPhase(runtimeRoot, projectId),
        status: "unregistered",
        uptimeMs: uptimeMs(lock.startedAt, now),
      });
    }
  }
  return discovered;
}

function uptimeMs(startedAt: string, now: number, stale = false): number {
  if (stale) return 0;
  const started = Date.parse(startedAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
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
