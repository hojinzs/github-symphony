import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireProjectLock, releaseProjectLock } from "./lock.js";

describe("project lock", () => {
  it("creates a project-scoped lock file with pid metadata", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-lock-"));

    const lock = await acquireProjectLock({
      runtimeRoot,
      projectId: "project-1",
      pid: 4321,
      now: new Date("2026-03-16T00:00:00.000Z"),
      isProcessRunning: () => false,
    });

    const contents = JSON.parse(await readFile(lock.lockPath, "utf8")) as {
      pid: number;
      startedAt: string;
      ownerToken: string;
    };

    expect(contents.pid).toBe(4321);
    expect(contents.startedAt).toBe("2026-03-16T00:00:00.000Z");
    expect(contents.ownerToken).toBe(lock.ownerToken);

    await releaseProjectLock(lock);
  });

  it("rejects when the existing lock belongs to a live process", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-lock-"));
    const lock = await acquireProjectLock({
      runtimeRoot,
      projectId: "project-1",
      pid: 4321,
      isProcessRunning: () => false,
    });

    await expect(
      acquireProjectLock({
        runtimeRoot,
        projectId: "project-1",
        pid: 9999,
        isProcessRunning: (pid) => pid === 4321,
      })
    ).rejects.toThrow('Project "project-1" is already running (PID 4321).');

    await releaseProjectLock(lock);
  });

  it("takes over a stale lock when the recorded pid is no longer running", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-lock-"));
    const lockPath = join(
      runtimeRoot,
      "projects",
      "project-1",
      ".lock"
    );
    await mkdir(join(runtimeRoot, "projects", "project-1"), {
      recursive: true,
    });
    await writeFile(
      lockPath,
      JSON.stringify({
        ownerToken: "stale-owner",
        pid: 987654,
        startedAt: "2026-03-15T00:00:00.000Z",
      }) + "\n",
      "utf8"
    );

    const lock = await acquireProjectLock({
      runtimeRoot,
      projectId: "project-1",
      pid: 4321,
      isProcessRunning: () => false,
    });

    const contents = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
      ownerToken: string;
    };
    expect(contents.pid).toBe(4321);
    expect(contents.ownerToken).toBe(lock.ownerToken);

    await releaseProjectLock(lock);
  });

  it("does not delete an unreadable lock file", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-lock-"));
    const lockPath = join(
      runtimeRoot,
      "projects",
      "project-1",
      ".lock"
    );
    await mkdir(join(runtimeRoot, "projects", "project-1"), {
      recursive: true,
    });
    await writeFile(lockPath, "{\"ownerToken\":\"partial\"", "utf8");

    await expect(
      acquireProjectLock({
        runtimeRoot,
        projectId: "project-1",
        pid: 4321,
        isProcessRunning: () => false,
      })
    ).rejects.toThrow('Project "project-1" lock file is unreadable');

    await expect(readFile(lockPath, "utf8")).resolves.toBe(
      "{\"ownerToken\":\"partial\""
    );
  });

  it("rejects project ids with path traversal characters", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-lock-"));

    await expect(
      acquireProjectLock({
        runtimeRoot,
        projectId: "../escape",
        pid: 4321,
        isProcessRunning: () => false,
      })
    ).rejects.toThrow('Invalid project ID "../escape"');
  });

  it("does not remove a lock owned by another acquisition", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-lock-"));
    const first = await acquireProjectLock({
      runtimeRoot,
      projectId: "project-1",
      pid: 1111,
      isProcessRunning: () => false,
    });
    await rm(first.lockPath, { force: true });

    const second = await acquireProjectLock({
      runtimeRoot,
      projectId: "project-1",
      pid: 2222,
      isProcessRunning: () => false,
    });

    await releaseProjectLock(first);
    await expect(access(second.lockPath)).resolves.toBeUndefined();

    await releaseProjectLock(second);
    await expect(access(second.lockPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
