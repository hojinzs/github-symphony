import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getProcessIdentity } from "@gh-symphony/orchestrator";
import { daemonPidPath, parseDaemonPidRecord } from "./config.js";

const TTL_MS = 60_000;

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
  standalone?: boolean;
};

export function instancesRoot(): string {
  return join(process.env.GH_SYMPHONY_CONFIG_DIR || join(homedir(), ".gh-symphony"), "instances");
}

function pathFor(entry: Pick<InstanceEntry, "runtimeRoot" | "projectId">): string {
  const key = Buffer.from(`${resolve(entry.runtimeRoot)}\0${entry.projectId}`).toString("base64url");
  return join(instancesRoot(), `${key}.json`);
}

export async function registerInstance(entry: InstanceEntry): Promise<void> {
  await mkdir(instancesRoot(), { recursive: true, mode: 0o700 });
  await writeFile(pathFor(entry), JSON.stringify(entry, null, 2) + "\n", { mode: 0o600 });
}
export async function unregisterInstance(entry: Pick<InstanceEntry, "runtimeRoot" | "projectId">): Promise<void> {
  await rm(pathFor(entry), { force: true });
}
export async function findLiveDuplicate(entry: Pick<InstanceEntry, "projectId" | "repoPath">): Promise<InstanceEntry | null> {
  for (const candidate of await listInstances()) {
    if (candidate.repoPath === resolve(entry.repoPath) && candidate.projectId === entry.projectId && candidate.status === "running") return candidate;
  }
  return null;
}
export type ListedInstance = InstanceEntry & {
  status: "running" | "stale-registry" | "unregistered" | "stale-pidfile";
  uptimeMs: number;
};
export async function listInstances(now = Date.now()): Promise<ListedInstance[]> {
  let names: string[]; try { names = await readdir(instancesRoot()); } catch { return []; }
  const output: ListedInstance[] = [];
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    try {
      const entry = JSON.parse(await readFile(join(instancesRoot(), name), "utf8")) as InstanceEntry;
      const lock = JSON.parse(await readFile(join(entry.runtimeRoot, "projects", entry.projectId, ".lock"), "utf8")) as Partial<InstanceEntry>;
      const identity = getProcessIdentity(entry.pid);
      const fresh = lock.heartbeatAt && Math.abs(now - Date.parse(lock.heartbeatAt)) <= TTL_MS;
      const identityMatches =
        entry.processIdentity === null ||
        identity === null ||
        entry.processIdentity === identity;
      const running = Boolean(identityMatches && fresh);
      const pidRecord = parseDaemonPidRecord(
        await readFile(daemonPidPath(entry.runtimeRoot, entry.projectId), "utf8").catch(() => "")
      );
      const stalePidfile = Boolean(pidRecord && getProcessIdentity(pidRecord.pid) !== pidRecord.processIdentity);
      output.push({ ...entry, status: !running ? "stale-registry" : stalePidfile ? "stale-pidfile" : "running", uptimeMs: Math.max(0, now - Date.parse(entry.startedAt)) });
      if (!running) await rm(join(instancesRoot(), name), { force: true });
    } catch { /* ignore malformed entries; they cannot be trusted */ }
  }
  return output;
}
