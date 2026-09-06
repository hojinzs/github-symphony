import { access, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireProjectStartLocks,
  releaseProjectStartLocks,
  resolveProjectIdentityLock,
} from "./project-start-lock.js";

describe("project start locks", () => {
  it("prevents the same project folder from starting under two runtime roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-start-lock-"));
    const projectDir = await mkdtemp(join(root, "project-"));
    const first = await acquireProjectStartLocks({
      runtimeRoot: join(root, "runtime-a"),
      projectId: "project-a",
      projectDir,
    });

    try {
      await expect(
        acquireProjectStartLocks({
          runtimeRoot: join(root, "runtime-b"),
          projectId: "project-b",
          projectDir,
        })
      ).rejects.toThrow("is already running");
    } finally {
      await releaseProjectStartLocks(first);
    }

    const second = await acquireProjectStartLocks({
      runtimeRoot: join(root, "runtime-b"),
      projectId: "project-b",
      projectDir,
    });
    await releaseProjectStartLocks(second);
  });

  it("canonicalizes symlinked project paths to the same identity lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-start-lock-"));
    const projectDir = await mkdtemp(join(root, "project-"));
    const direct = await resolveProjectIdentityLock({
      projectDir,
      temporaryDirectory: root,
    });
    const projectLink = join(root, "project-link");
    await symlink(projectDir, projectLink);
    const viaSymlink = await resolveProjectIdentityLock({
      projectDir: projectLink,
      temporaryDirectory: root,
    });

    expect(viaSymlink).toEqual(direct);
  });

  it("reclaims a folder-identity lock whose owner is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-start-lock-"));
    const projectDir = await mkdtemp(join(root, "project-"));
    const identity = await resolveProjectIdentityLock({ projectDir });
    const identityLockPath = join(
      identity.runtimeRoot,
      "projects",
      identity.projectId,
      ".lock"
    );
    await mkdir(join(identity.runtimeRoot, "projects", identity.projectId), {
      recursive: true,
    });
    await writeFile(
      identityLockPath,
      JSON.stringify({
        ownerToken: "stale-owner",
        pid: 987654321,
        startedAt: "2026-09-01T00:00:00.000Z",
        heartbeatAt: "2026-09-01T00:00:00.000Z",
        processIdentity: "stale-process",
        cwd: projectDir,
      }) + "\n"
    );

    const locks = await acquireProjectStartLocks({
      runtimeRoot: join(root, "runtime"),
      projectId: "project-a",
      projectDir,
    });
    expect(locks.identityLock.ownerToken).not.toBe("stale-owner");
    await releaseProjectStartLocks(locks);
  });

  it("keeps and releases the existing per-runtime-root lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-start-lock-"));
    const projectDir = await mkdtemp(join(root, "project-"));
    const runtimeRoot = join(root, "runtime");
    const locks = await acquireProjectStartLocks({
      runtimeRoot,
      projectId: "project-a",
      projectDir,
    });
    const perRuntimeLock = join(runtimeRoot, "projects", "project-a", ".lock");

    await expect(access(perRuntimeLock)).resolves.toBeUndefined();
    await releaseProjectStartLocks(locks);
    await expect(access(perRuntimeLock)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves legacy runtime-only locking when no project folder is recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-start-lock-"));
    const locks = await acquireProjectStartLocks({
      runtimeRoot: root,
      projectId: "legacy-project",
    });

    expect(locks.identityLock).toBeUndefined();
    await expect(
      access(join(root, "projects", "legacy-project", ".lock"))
    ).resolves.toBeUndefined();
    await releaseProjectStartLocks(locks);
  });
});
