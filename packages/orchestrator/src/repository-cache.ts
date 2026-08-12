import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RepositoryRef } from "@gh-symphony/core";
import {
  acquireRepositoryLock,
  releaseRepositoryLock,
  runGitCommand,
  runGitCommandCapture,
} from "./git.js";

const DEFAULT_CONFIG_DIR = join(homedir(), ".gh-symphony");
const FETCH_TTL_MS = 60_000;
const LAST_FETCH_MARKER = ".gh-symphony-last-fetch";

export function resolveGlobalRepositoryCacheRoot(
  configDir = process.env.GH_SYMPHONY_CONFIG_DIR || DEFAULT_CONFIG_DIR
): string {
  return join(configDir, "repos");
}

export function globalBareRepositoryDirectory(input: {
  repository: Pick<RepositoryRef, "owner" | "name">;
  configDir?: string;
}): string {
  return join(
    resolveGlobalRepositoryCacheRoot(input.configDir),
    input.repository.owner,
    `${input.repository.name}.git`
  );
}

export function globalBareRepositoryLockDirectory(input: {
  repository: Pick<RepositoryRef, "owner" | "name">;
  configDir?: string;
}): string {
  return join(
    resolveGlobalRepositoryCacheRoot(input.configDir),
    input.repository.owner,
    `${input.repository.name}.lock`
  );
}

export async function ensureGlobalBareRepositoryCache(input: {
  repository: RepositoryRef;
  requiredRef?: string;
  configDir?: string;
  now?: Date;
}): Promise<string> {
  const bareDirectory = globalBareRepositoryDirectory(input);
  const lockDirectory = globalBareRepositoryLockDirectory(input);
  await mkdir(dirname(bareDirectory), { recursive: true });

  const ownerToken = await acquireRepositoryLock(lockDirectory);
  try {
    const now = input.now ?? new Date();
    if (!(await isBareRepository(bareDirectory))) {
      await rm(bareDirectory, { recursive: true, force: true });
      await runGitCommand([
        "clone",
        "--bare",
        input.repository.cloneUrl,
        bareDirectory,
      ]);
      await writeLastFetchMarker(bareDirectory, now);
      await runGitCommand(["-C", bareDirectory, "gc", "--auto"]);
      return bareDirectory;
    }

    const requiredRefExists = input.requiredRef
      ? await hasRef(bareDirectory, input.requiredRef)
      : true;
    if (!(await isFetchFresh(bareDirectory, now)) || !requiredRefExists) {
      await runGitCommand([
        "-C",
        bareDirectory,
        "fetch",
        "--prune",
        "origin",
        "+refs/heads/*:refs/heads/*",
      ]);
      await writeLastFetchMarker(bareDirectory, now);
      await runGitCommand(["-C", bareDirectory, "gc", "--auto"]);
    }

    return bareDirectory;
  } finally {
    await releaseRepositoryLock(lockDirectory, ownerToken);
  }
}

async function isBareRepository(directory: string): Promise<boolean> {
  try {
    return (
      (
        await runGitCommandCapture([
          "-C",
          directory,
          "rev-parse",
          "--is-bare-repository",
        ])
      ).trim() === "true"
    );
  } catch {
    return false;
  }
}

async function hasRef(directory: string, ref: string): Promise<boolean> {
  try {
    await runGitCommand([
      "-C",
      directory,
      "show-ref",
      "--verify",
      "--quiet",
      ref,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function isFetchFresh(directory: string, now: Date): Promise<boolean> {
  try {
    const marker = await readFile(join(directory, LAST_FETCH_MARKER), "utf8");
    const fetchedAt = Date.parse(marker.trim());
    return (
      Number.isFinite(fetchedAt) && now.getTime() - fetchedAt < FETCH_TTL_MS
    );
  } catch {
    return false;
  }
}

async function writeLastFetchMarker(
  directory: string,
  now: Date
): Promise<void> {
  await writeFile(
    join(directory, LAST_FETCH_MARKER),
    `${now.toISOString()}\n`,
    "utf8"
  );
}
