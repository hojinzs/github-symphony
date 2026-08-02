import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireProjectLock,
  getProcessCwd,
  getProcessStartIdentity,
  releaseProjectLock,
  renewProjectLock,
} from "./lock.js";

describe("project lock", () => {
  it("resolves the current process working directory", () => {
    expect(getProcessCwd(process.pid)).toBe(resolve(process.cwd()));
    expect(getProcessStartIdentity(process.pid)).not.toBeNull();
  });

  it("creates a project-scoped lock file with pid metadata", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-lock-"));

    const lock = await acquireProjectLock({
      runtimeRoot,
      projectId: "project-1",
      pid: 4321,
      now: new Date("2026-03-16T00:00:00.000Z"),
      isProcessRunning: () => false,
      getProcessIdentity: () => "test-process-4321",
    });

    const contents = JSON.parse(await readFile(lock.lockPath, "utf8")) as {
      pid: number;
      startedAt: string;
      ownerToken: string;
      heartbeatAt: string;
      processIdentity: string;
    };

    expect(contents.pid).toBe(4321);
    expect(contents.startedAt).toBe("2026-03-16T00:00:00.000Z");
    expect(contents.ownerToken).toBe(lock.ownerToken);
    expect(contents.heartbeatAt).toBe("2026-03-16T00:00:00.000Z");
    expect(contents.processIdentity).toBe("test-process-4321");
    const projectDirStats = await stat(
      join(runtimeRoot, "projects", "project-1")
    );
    expect(projectDirStats.mode & 0o777).toBe(0o700);

    await releaseProjectLock(lock);
  });

  it("rejects when the existing lock belongs to a live process", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-lock-"));
    const lock = await acquireProjectLock({
      runtimeRoot,
      projectId: "project-1",
      pid: 4321,
      isProcessRunning: () => false,
      getProcessIdentity: () => "same-process",
    });

    await expect(
      acquireProjectLock({
        runtimeRoot,
        projectId: "project-1",
        pid: 9999,
        isProcessRunning: (pid) => pid === 4321,
        getProcessIdentity: () => "same-process",
      })
    ).rejects.toThrow('Project "project-1" is already running (PID 4321).');

    await releaseProjectLock(lock);
  });

  it("takes over a live reused pid when process identity changed", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-lock-"));
    const first = await acquireProjectLock({
      runtimeRoot,
      projectId: "project-1",
      pid: 4321,
      isProcessRunning: () => false,
      getProcessIdentity: () => "original-process",
    });

    const second = await acquireProjectLock({
      runtimeRoot,
      projectId: "project-1",
      pid: 9999,
      isProcessRunning: () => true,
      getProcessIdentity: (pid) =>
        pid === 4321 ? "reused-process" : "new-owner",
    });

    expect(second.ownerToken).not.toBe(first.ownerToken);
    await releaseProjectLock(second);
  });

  it("takes over an expired lease even when the pid is live", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-lock-"));
    const first = await acquireProjectLock({
      runtimeRoot,
      projectId: "project-1",
      pid: 4321,
      now: new Date("2026-03-16T00:00:00.000Z"),
      isProcessRunning: () => false,
      getProcessIdentity: () => "same-process",
    });

    const second = await acquireProjectLock({
      runtimeRoot,
      projectId: "project-1",
      pid: 9999,
      now: new Date("2026-03-16T00:01:01.000Z"),
      isProcessRunning: () => true,
      getProcessIdentity: () => "same-process",
    });

    expect(second.ownerToken).not.toBe(first.ownerToken);
    await releaseProjectLock(second);
  });

  it("preserves a live legacy lock without a heartbeat past the lease TTL", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-lock-"));
    const lockPath = join(runtimeRoot, "projects", "project-1", ".lock");
    await mkdir(join(runtimeRoot, "projects", "project-1"), {
      recursive: true,
    });
    await writeFile(
      lockPath,
      JSON.stringify({
        ownerToken: "legacy-owner",
        pid: 4321,
        startedAt: "2026-03-16T00:00:00.000Z",
        processIdentity: "same-process",
      }) + "\n",
      "utf8"
    );

    await expect(
      acquireProjectLock({
        runtimeRoot,
        projectId: "project-1",
        pid: 9999,
        now: new Date("2026-03-16T01:00:00.000Z"),
        isProcessRunning: (pid) => pid === 4321,
        getProcessIdentity: () => "same-process",
      })
    ).rejects.toThrow('Project "project-1" is already running (PID 4321).');
  });

  it("renews a lease heartbeat only for its current owner", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-lock-"));
    const lock = await acquireProjectLock({
      runtimeRoot,
      projectId: "project-1",
      pid: 4321,
      now: new Date("2026-03-16T00:00:00.000Z"),
      isProcessRunning: () => false,
      getProcessIdentity: () => "same-process",
    });

    const inodeBeforeRenewal = await stat(lock.lockPath);
    await expect(
      renewProjectLock(lock, new Date("2026-03-16T00:00:30.000Z"))
    ).resolves.toBe(true);
    const inodeAfterRenewal = await stat(lock.lockPath);
    const renewed = JSON.parse(await readFile(lock.lockPath, "utf8")) as {
      heartbeatAt: string;
    };
    expect(renewed.heartbeatAt).toBe("2026-03-16T00:00:30.000Z");
    expect(inodeAfterRenewal.dev).toBe(inodeBeforeRenewal.dev);
    expect(inodeAfterRenewal.ino).toBe(inodeBeforeRenewal.ino);

    await rm(lock.lockPath, { force: true });
    await expect(renewProjectLock(lock)).resolves.toBe(false);
    await releaseProjectLock(lock);
  });

  it("fails closed when the heartbeat loses lease ownership", async () => {
    vi.useFakeTimers();
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-lock-"));
    let confirmLeaseLost: (() => void) | undefined;
    const leaseLost = new Promise<void>((resolve) => {
      confirmLeaseLost = resolve;
    });
    const onLeaseLost = vi.fn(() => confirmLeaseLost?.());
    try {
      const lock = await acquireProjectLock({
        runtimeRoot,
        projectId: "project-1",
        pid: 4321,
        isProcessRunning: () => false,
        getProcessIdentity: () => "same-process",
        leaseTtlMs: 3_000,
        onLeaseLost,
      });
      await writeFile(
        lock.lockPath,
        JSON.stringify({
          ownerToken: "new-owner",
          pid: 9999,
          startedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          processIdentity: "new-process",
        }) + "\n",
        "utf8"
      );

      await vi.advanceTimersByTimeAsync(1_000);
      await leaseLost;

      expect(onLeaseLost).toHaveBeenCalledOnce();
      expect(onLeaseLost).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Lost ownership"),
        })
      );
      await releaseProjectLock(lock);
      expect(JSON.parse(await readFile(lock.lockPath, "utf8")).ownerToken).toBe(
        "new-owner"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes over a stale lock when the recorded pid is no longer running", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-lock-"));
    const lockPath = join(runtimeRoot, "projects", "project-1", ".lock");
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
    const lockPath = join(runtimeRoot, "projects", "project-1", ".lock");
    await mkdir(join(runtimeRoot, "projects", "project-1"), {
      recursive: true,
    });
    await writeFile(lockPath, '{"ownerToken":"partial"', "utf8");

    await expect(
      acquireProjectLock({
        runtimeRoot,
        projectId: "project-1",
        pid: 4321,
        isProcessRunning: () => false,
      })
    ).rejects.toThrow('Project "project-1" lock file is unreadable');

    await expect(readFile(lockPath, "utf8")).resolves.toBe(
      '{"ownerToken":"partial"'
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
