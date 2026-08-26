import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getProcessIdentity } from "@gh-symphony/orchestrator";
import { instancesRoot, listInstances, registerInstance, unregisterInstance } from "./instances.js";

const originalConfigDir = process.env.GH_SYMPHONY_CONFIG_DIR;
afterEach(() => { process.env.GH_SYMPHONY_CONFIG_DIR = originalConfigDir; });

describe("global instance registry", () => {
  it("uses the global config namespace, reports running entries, and removes stale entries", async () => {
    const root = await mkdirTemp();
    process.env.GH_SYMPHONY_CONFIG_DIR = root;
    const runtimeRoot = join(root, "runtime-a");
    const entry = entryFor(runtimeRoot);
    await mkdir(join(runtimeRoot, "projects", entry.projectId), { recursive: true });
    await writeFile(join(runtimeRoot, "projects", entry.projectId, ".lock"), JSON.stringify({ heartbeatAt: new Date().toISOString() }));
    await registerInstance(entry);
    await expect(listInstances()).resolves.toEqual([expect.objectContaining({ status: "running", projectId: entry.projectId })]);
    await writeFile(join(runtimeRoot, "projects", entry.projectId, ".lock"), JSON.stringify({ heartbeatAt: "2000-01-01T00:00:00.000Z" }));
    await expect(listInstances()).resolves.toEqual([expect.objectContaining({ status: "stale-registry" })]);
    await expect(readFile(instancesRoot(), "utf8")).rejects.toBeDefined();
    await unregisterInstance(entry);
  });
});

async function mkdirTemp(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "cli-instances-"));
}
function entryFor(runtimeRoot: string) {
  return { projectId: "project-a", repo: "acme/repo", repoPath: "/repo", workspacePath: "/repo/.runtime/workspaces", runtimeRoot, pid: process.pid, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), processIdentity: getProcessIdentity(process.pid)! };
}
