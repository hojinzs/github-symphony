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
import { sanitizeRepositoryCloneUrl } from "./repository-url.js";

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
  validateRepositoryPathSegments(input.repository);
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
  validateRepositoryPathSegments(input.repository);
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
  const cloneUrl = sanitizeRepositoryCloneUrl(input.repository.cloneUrl);
  await mkdir(dirname(bareDirectory), { recursive: true });

  const ownerToken = await acquireRepositoryLock(lockDirectory);
  try {
    return ensureBareRepositoryCacheUnderLock({
      ...input,
      bareDirectory,
      cloneUrl,
    });
  } finally {
    await releaseRepositoryLock(lockDirectory, ownerToken);
  }
}

/** Runs a cache operation while holding the repository-wide bare-cache lock. */
export async function withGlobalBareRepositoryCache<T>(
  input: {
    repository: RepositoryRef;
    requiredRef?: string;
    configDir?: string;
    now?: Date;
  },
  operation: (bareDirectory: string) => Promise<T>
): Promise<T> {
  const bareDirectory = globalBareRepositoryDirectory(input);
  const lockDirectory = globalBareRepositoryLockDirectory(input);
  const cloneUrl = sanitizeRepositoryCloneUrl(input.repository.cloneUrl);
  await mkdir(dirname(bareDirectory), { recursive: true });
  const ownerToken = await acquireRepositoryLock(lockDirectory);
  try {
    await ensureBareRepositoryCacheUnderLock({
      ...input,
      bareDirectory,
      cloneUrl,
    });
    return await operation(bareDirectory);
  } finally {
    await releaseRepositoryLock(lockDirectory, ownerToken);
  }
}

async function ensureBareRepositoryCacheUnderLock(input: {
  repository: RepositoryRef;
  requiredRef?: string;
  now?: Date;
  bareDirectory: string;
  cloneUrl: string;
}): Promise<string> {
  const now = input.now ?? new Date();
  if (!(await isBareRepository(input.bareDirectory))) {
    await recreateBareRepository(input.bareDirectory, input.cloneUrl, now);
    return input.bareDirectory;
  }

  const requiredRef = input.requiredRef
    ? normalizeRequiredRef(input.requiredRef)
    : undefined;
  const requiredRefExists = requiredRef
    ? await hasRef(input.bareDirectory, requiredRef)
    : true;
  const originUrl = await readOriginRemoteUrl(input.bareDirectory);
  if (originUrl === null) {
    await recreateBareRepository(input.bareDirectory, input.cloneUrl, now);
    return input.bareDirectory;
  }
  // The cache is keyed by owner/name, so a repository that moved hosts,
  // switched protocols, or was re-pointed at a fork would otherwise keep
  // serving the previous remote forever. Re-point it and refetch immediately
  // instead of trusting the fetch TTL.
  const originChanged = originUrl !== input.cloneUrl;
  if (originChanged) {
    await runGitCommand([
      "-C",
      input.bareDirectory,
      "remote",
      "set-url",
      "origin",
      input.cloneUrl,
    ]);
  }
  if (
    originChanged ||
    !(await isFetchFresh(input.bareDirectory, now)) ||
    !requiredRefExists
  ) {
    await fetchOriginBranches(input.bareDirectory);
    await writeLastFetchMarker(input.bareDirectory, now);
    await runGitCommand(["-C", input.bareDirectory, "gc", "--auto"]);
  }

  return input.bareDirectory;
}

async function recreateBareRepository(
  bareDirectory: string,
  cloneUrl: string,
  now: Date
): Promise<void> {
  // A concurrent Git process can leave transient entries while a corrupt cache
  // is being replaced. Retry the recursive removal under the cache lock so a
  // fresh cache initialization does not fail with ENOTEMPTY.
  await rm(bareDirectory, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
  // The parent is normally created before taking the lock, but another
  // lifecycle cleanup can remove an empty cache hierarchy while a caller is
  // waiting. Recreate it after acquiring the lock so `git init` never races a
  // missing parent directory.
  await mkdir(dirname(bareDirectory), { recursive: true });
  await runGitCommand(["init", "--bare", bareDirectory]);
  await runGitCommand([
    "-C",
    bareDirectory,
    "remote",
    "add",
    "origin",
    cloneUrl,
  ]);
  await fetchOriginBranches(bareDirectory);
  await writeLastFetchMarker(bareDirectory, now);
  await runGitCommand(["-C", bareDirectory, "gc", "--auto"]);
}

async function fetchOriginBranches(bareDirectory: string): Promise<void> {
  await runGitCommand([
    "-C",
    bareDirectory,
    "fetch",
    "--prune",
    "--tags",
    "origin",
    "+refs/heads/*:refs/remotes/origin/*",
  ]);
  await runGitCommand([
    "-C",
    bareDirectory,
    "remote",
    "set-head",
    "origin",
    "--auto",
  ]);
}

/**
 * The clone path historically requests local `refs/heads/*` names. The shared
 * bare cache intentionally keeps fetched branches under `origin/*` so active
 * worktree branches cannot be pruned; accept the former contract at this
 * boundary rather than making callers aware of the cache layout.
 */
function normalizeRequiredRef(ref: string): string {
  return ref.startsWith("refs/heads/")
    ? `refs/remotes/origin/${ref.slice("refs/heads/".length)}`
    : ref;
}

async function readOriginRemoteUrl(directory: string): Promise<string | null> {
  try {
    return (
      await runGitCommandCapture([
        "-C",
        directory,
        "remote",
        "get-url",
        "origin",
      ])
    ).trim();
  } catch {
    return null;
  }
}

function validateRepositoryPathSegments(
  repository: Pick<RepositoryRef, "owner" | "name">
): void {
  for (const [field, value] of [
    ["owner", repository.owner],
    ["name", repository.name],
  ]) {
    if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) {
      throw new Error(`Invalid repository ${field} for global cache path.`);
    }
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
