import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getProcessIdentity } from "@gh-symphony/orchestrator";
import {
  findLiveDuplicate,
  instancesRoot,
  instancesRootMode,
  listInstances,
  registerInstance,
  unregisterInstance,
} from "./instances.js";

const originalConfigDir = process.env.GH_SYMPHONY_CONFIG_DIR;
const originalInstancesDir = process.env.GH_SYMPHONY_INSTANCES_DIR;
afterEach(() => {
  process.env.GH_SYMPHONY_CONFIG_DIR = originalConfigDir;
  process.env.GH_SYMPHONY_INSTANCES_DIR = originalInstancesDir;
});

describe("global instance registry", () => {
  it("uses the global config namespace, reports stale entries without deleting them, and secures the directory", async () => {
    const root = await mkdirTemp();
    process.env.GH_SYMPHONY_CONFIG_DIR = root;
    process.env.GH_SYMPHONY_INSTANCES_DIR = join(root, "instances");
    const runtimeRoot = join(root, "runtime-a");
    const entry = entryFor(runtimeRoot);
    await mkdir(join(runtimeRoot, "projects", entry.projectId), {
      recursive: true,
    });
    await writeFile(
      join(runtimeRoot, "projects", entry.projectId, ".lock"),
      JSON.stringify({
        pid: entry.pid,
        startedAt: entry.startedAt,
        heartbeatAt: new Date().toISOString(),
        processIdentity: entry.processIdentity,
      })
    );
    await writeFile(
      join(runtimeRoot, "projects", entry.projectId, "status.json"),
      JSON.stringify({ activeRuns: [{ executionPhase: "implementation" }] })
    );
    await registerInstance(entry);
    await expect(listInstances()).resolves.toEqual([
      expect.objectContaining({
        status: "running",
        projectId: entry.projectId,
        phase: "implementation",
      }),
    ]);
    await expect(
      findLiveDuplicate({
        projectId: entry.projectId,
        repoPath: entry.repoPath,
      })
    ).resolves.toEqual(expect.objectContaining({ runtimeRoot }));
    await writeFile(
      join(runtimeRoot, "projects", entry.projectId, ".lock"),
      JSON.stringify({ heartbeatAt: "2000-01-01T00:00:00.000Z" })
    );
    await expect(listInstances()).resolves.toEqual([
      expect.objectContaining({
        status: "stale-registry",
        endpoint: null,
        phase: null,
        uptimeMs: 0,
      }),
    ]);
    await expect(
      findLiveDuplicate({
        projectId: entry.projectId,
        repoPath: entry.repoPath,
      })
    ).resolves.toBeNull();
    await expect(listInstances()).resolves.toEqual([
      expect.objectContaining({ status: "stale-registry" }),
    ]);
    await expect(instancesRootMode()).resolves.toBe(0o700);
    await chmod(instancesRoot(), 0o755);
    await registerInstance(entry);
    await expect(instancesRootMode()).resolves.toBe(0o700);
    await writeFile(
      join(runtimeRoot, "projects", entry.projectId, ".lock"),
      JSON.stringify({
        pid: entry.pid,
        startedAt: entry.startedAt,
        heartbeatAt: new Date().toISOString(),
        processIdentity: entry.processIdentity,
      })
    );
    await unregisterInstance(entry);
    await expect(listInstances()).resolves.toEqual([
      expect.objectContaining({
        status: "unregistered",
        projectId: entry.projectId,
      }),
    ]);
  });

  it("prunes stale records on registration without deleting a successor", async () => {
    const root = await mkdirTemp();
    process.env.GH_SYMPHONY_INSTANCES_DIR = join(root, "instances");
    const runtimeRoot = join(root, "runtime-a");
    const entry = entryFor(runtimeRoot);
    await mkdir(join(runtimeRoot, "projects", entry.projectId), {
      recursive: true,
    });
    await writeFile(
      join(runtimeRoot, "projects", entry.projectId, ".lock"),
      JSON.stringify({
        pid: entry.pid,
        heartbeatAt: new Date().toISOString(),
        processIdentity: entry.processIdentity,
      })
    );
    await registerInstance(entry);
    const successor = {
      ...entry,
      pid: entry.pid + 1,
      startedAt: "2099-01-01T00:00:00.000Z",
    };
    await registerInstance(successor);
    await unregisterInstance(entry);
    await expect(listInstances()).resolves.toEqual([
      expect.objectContaining({
        pid: successor.pid,
        startedAt: successor.startedAt,
      }),
    ]);

    await writeFile(
      join(runtimeRoot, "projects", entry.projectId, ".lock"),
      JSON.stringify({ heartbeatAt: "2000-01-01T00:00:00.000Z" })
    );
    await registerInstance({ ...entry, projectId: "project-b" });
    await expect(listInstances()).resolves.toEqual([
      expect.objectContaining({
        projectId: "project-b",
        status: "stale-registry",
      }),
    ]);
  });
});

async function mkdirTemp(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "cli-instances-"));
}
function entryFor(runtimeRoot: string) {
  return {
    projectId: "project-a",
    repo: "acme/repo",
    repoPath: "/repo",
    workspacePath: "/repo/.runtime/workspaces",
    runtimeRoot,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    processIdentity: getProcessIdentity(process.pid)!,
  };
}
