import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureGlobalBareRepositoryCache,
  globalBareRepositoryLockDirectory,
  inspectGlobalRepositoryCache,
  pruneGlobalRepositoryCache,
  withGlobalBareRepositoryCache,
} from "./repository-cache.js";

async function createRemote(root: string, marker: string): Promise<string> {
  const directory = join(root, "acme-platform");
  await mkdir(directory, { recursive: true });
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: directory, stdio: "ignore" });
  git(["init", "-b", "main"]);
  git(["config", "user.email", "cache@example.test"]);
  git(["config", "user.name", "cache"]);
  await writeFile(join(directory, "marker.txt"), marker, "utf8");
  git(["add", "-A"]);
  git(["commit", "-m", "seed"]);
  return directory;
}

function bareContent(bareDirectory: string): string {
  return execFileSync("git", [
    "-C",
    bareDirectory,
    "show",
    "origin/main:marker.txt",
  ])
    .toString()
    .trim();
}

function bareOrigin(bareDirectory: string): string {
  return execFileSync("git", [
    "-C",
    bareDirectory,
    "remote",
    "get-url",
    "origin",
  ])
    .toString()
    .trim();
}

describe("global bare repository cache", () => {
  it("re-points and refetches when the project clone URL changes", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repository-cache-config-"));
    const firstRoot = await mkdtemp(join(tmpdir(), "repository-cache-first-"));
    const secondRoot = await mkdtemp(
      join(tmpdir(), "repository-cache-second-")
    );
    const firstRemote = await createRemote(firstRoot, "first-remote");
    const secondRemote = await createRemote(secondRoot, "second-remote");

    const bareDirectory = await ensureGlobalBareRepositoryCache({
      repository: { owner: "acme", name: "platform", cloneUrl: firstRemote },
      configDir,
    });
    expect(bareContent(bareDirectory)).toBe("first-remote");

    await ensureGlobalBareRepositoryCache({
      repository: { owner: "acme", name: "platform", cloneUrl: secondRemote },
      configDir,
    });

    expect(bareOrigin(bareDirectory)).toBe(secondRemote);
    expect(bareContent(bareDirectory)).toBe("second-remote");
  });

  it("keeps serving the cached remote while the clone URL is unchanged", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repository-cache-config-"));
    const root = await mkdtemp(join(tmpdir(), "repository-cache-stable-"));
    const remote = await createRemote(root, "stable-remote");

    const bareDirectory = await ensureGlobalBareRepositoryCache({
      repository: { owner: "acme", name: "platform", cloneUrl: remote },
      configDir,
    });
    await ensureGlobalBareRepositoryCache({
      repository: { owner: "acme", name: "platform", cloneUrl: remote },
      configDir,
    });

    expect(bareOrigin(bareDirectory)).toBe(remote);
    expect(bareContent(bareDirectory)).toBe("stable-remote");
  });

  it("inspects and prunes only old unlocked caches without worktrees", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repository-cache-config-"));
    const root = await mkdtemp(join(tmpdir(), "repository-cache-prune-"));
    const remote = await createRemote(root, "prune-remote");
    const repository = { owner: "acme", name: "platform", cloneUrl: remote };
    const bareDirectory = await ensureGlobalBareRepositoryCache({
      repository,
      configDir,
    });
    const old = new Date("2025-01-01T00:00:00.000Z");
    await utimes(bareDirectory, old, old);
    await writeFile(
      join(bareDirectory, ".gh-symphony-last-used"),
      `${old.toISOString()}\n`,
      "utf8"
    );

    const entries = await inspectGlobalRepositoryCache({ configDir });
    expect(entries).toMatchObject([
      { repository: "acme/platform", locked: false, worktrees: 0 },
    ]);
    expect(entries[0]?.bytes).toBeGreaterThan(0);

    const preview = await pruneGlobalRepositoryCache({
      configDir,
      maxAgeMs: 1,
      now: new Date("2026-01-01T00:00:00.000Z"),
      dryRun: true,
    });
    expect(preview.removed).toHaveLength(1);
    await expect(access(bareDirectory)).resolves.toBeUndefined();

    const lockDirectory = globalBareRepositoryLockDirectory({
      repository,
      configDir,
    });
    await mkdir(lockDirectory);
    const locked = await pruneGlobalRepositoryCache({
      configDir,
      maxAgeMs: 1,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(locked.skipped[0]?.reason).toBe("locked");
    await access(bareDirectory);
  });

  it("tracks cache reuse independently from the bare directory mtime", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repository-cache-config-"));
    const root = await mkdtemp(join(tmpdir(), "repository-cache-used-"));
    const remote = await createRemote(root, "used-remote");
    const repository = { owner: "acme", name: "platform", cloneUrl: remote };
    const firstUse = new Date("2026-01-01T00:00:00.000Z");
    const lastUse = new Date("2026-01-02T00:00:00.000Z");
    const bareDirectory = await ensureGlobalBareRepositoryCache({
      repository,
      configDir,
      now: firstUse,
    });
    await utimes(bareDirectory, firstUse, firstUse);

    await ensureGlobalBareRepositoryCache({
      repository,
      configDir,
      now: lastUse,
    });

    const entries = await inspectGlobalRepositoryCache({ configDir });
    expect(entries[0]?.updatedAt).toBe(lastUse.toISOString());
    const result = await pruneGlobalRepositoryCache({
      configDir,
      maxAgeMs: 12 * 60 * 60 * 1000,
      now: new Date("2026-01-02T06:00:00.000Z"),
      dryRun: true,
    });
    expect(result.removed).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe("recent");
  });

  it("removes an old idle cache in non-dry-run mode", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repository-cache-config-"));
    const root = await mkdtemp(join(tmpdir(), "repository-cache-remove-"));
    const remote = await createRemote(root, "remove-remote");
    const bareDirectory = await ensureGlobalBareRepositoryCache({
      repository: { owner: "acme", name: "platform", cloneUrl: remote },
      configDir,
      now: new Date("2025-01-01T00:00:00.000Z"),
    });

    const result = await pruneGlobalRepositoryCache({
      configDir,
      maxAgeMs: 1,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(result.removed).toMatchObject([
      { repository: "acme/platform", worktrees: 0 },
    ]);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    await expect(access(bareDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves an old cache with a linked worktree", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repository-cache-config-"));
    const root = await mkdtemp(join(tmpdir(), "repository-cache-worktree-"));
    const remote = await createRemote(root, "worktree-remote");
    const bareDirectory = await ensureGlobalBareRepositoryCache({
      repository: { owner: "acme", name: "platform", cloneUrl: remote },
      configDir,
      now: new Date("2025-01-01T00:00:00.000Z"),
    });
    const linkedDirectory = join(root, "linked-worktree");
    execFileSync(
      "git",
      [
        "-C",
        bareDirectory,
        "worktree",
        "add",
        "--detach",
        linkedDirectory,
        "origin/main",
      ],
      { stdio: "ignore" }
    );

    const result = await pruneGlobalRepositoryCache({
      configDir,
      maxAgeMs: 1,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toMatchObject([
      { repository: "acme/platform", worktrees: 1, reason: "worktrees" },
    ]);
    await expect(access(bareDirectory)).resolves.toBeUndefined();
  });

  it("preserves an old cache when linked worktrees cannot be verified", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repository-cache-config-"));
    const bareDirectory = join(configDir, "repos", "acme", "platform.git");
    await mkdir(bareDirectory, { recursive: true });
    await writeFile(join(bareDirectory, "not-a-bare-repository"), "broken");
    await writeFile(
      join(bareDirectory, ".gh-symphony-last-used"),
      "2025-01-01T00:00:00.000Z\n"
    );

    const result = await pruneGlobalRepositoryCache({
      configDir,
      maxAgeMs: 1,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(result.removed).toHaveLength(0);
    expect(result.skipped).toMatchObject([
      { repository: "acme/platform", worktrees: null, reason: "worktrees" },
    ]);
    await expect(access(bareDirectory)).resolves.toBeUndefined();
  });

  it("prevents pruning while a cache reader operation is active", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repository-cache-config-"));
    const root = await mkdtemp(join(tmpdir(), "repository-cache-reader-"));
    const remote = await createRemote(root, "reader-remote");
    const repository = { owner: "acme", name: "platform", cloneUrl: remote };
    let releaseReader: (() => void) | undefined;
    const readerStarted = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    let notifyReaderStarted: (() => void) | undefined;
    const readerIsActive = new Promise<void>((resolve) => {
      notifyReaderStarted = resolve;
    });

    const reader = withGlobalBareRepositoryCache(
      { repository, configDir },
      async (bareDirectory) => {
        notifyReaderStarted?.();
        await readerStarted;
        return bareDirectory;
      }
    );
    await readerIsActive;

    const prune = await pruneGlobalRepositoryCache({
      configDir,
      maxAgeMs: 0,
      now: new Date("2027-01-01T00:00:00.000Z"),
    });

    expect(prune.removed).toHaveLength(0);
    expect(prune.skipped).toMatchObject([
      { bytes: 0, worktrees: null, reason: "locked" },
    ]);
    releaseReader?.();
    await expect(reader).resolves.toContain("platform.git");
  });

  it("reclaims an old cache after breaking an abandoned stale lock", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repository-cache-config-"));
    const root = await mkdtemp(join(tmpdir(), "repository-cache-stale-lock-"));
    const remote = await createRemote(root, "stale-lock-remote");
    const repository = { owner: "acme", name: "platform", cloneUrl: remote };
    const bareDirectory = await ensureGlobalBareRepositoryCache({
      repository,
      configDir,
      now: new Date("2025-01-01T00:00:00.000Z"),
    });
    const lockDirectory = globalBareRepositoryLockDirectory({
      repository,
      configDir,
    });
    await mkdir(lockDirectory);
    await writeFile(join(lockDirectory, "owner"), "abandoned\n", "utf8");
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(lockDirectory, stale, stale);

    const entries = await inspectGlobalRepositoryCache({ configDir });
    expect(entries).toMatchObject([
      {
        repository: "acme/platform",
        locked: true,
        staleLock: true,
        worktrees: 0,
      },
    ]);
    expect(entries[0]?.bytes).toBeGreaterThan(0);

    const result = await pruneGlobalRepositoryCache({
      configDir,
      maxAgeMs: 1,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(result.removed).toMatchObject([
      { repository: "acme/platform", staleLock: true },
    ]);
    await expect(access(bareDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
