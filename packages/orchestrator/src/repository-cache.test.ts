import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureGlobalBareRepositoryCache,
  globalBareRepositoryLockDirectory,
  inspectGlobalRepositoryCache,
  pruneGlobalRepositoryCache,
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
});
