import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RepositoryRef } from "@gh-symphony/core";
import {
  acquireRepositoryLock,
  isRepositoryLockStale,
  releaseRepositoryLock,
  runGitCommand,
  runGitCommandCapture,
  startRepositoryLockHeartbeat,
  tryAcquireRepositoryLock,
} from "./git.js";
import { sanitizeRepositoryCloneUrl } from "./repository-url.js";

const DEFAULT_CONFIG_DIR = join(homedir(), ".gh-symphony");
const FETCH_TTL_MS = 60_000;
const LAST_FETCH_MARKER = ".gh-symphony-last-fetch";
const LAST_USED_MARKER = ".gh-symphony-last-used";
const CACHE_LOCK_HEARTBEAT_MS = 60_000;

export class RepositoryCacheUnavailableError extends Error {
  constructor(
    message: string,
    readonly cause: unknown
  ) {
    super(message);
    this.name = "RepositoryCacheUnavailableError";
  }
}

export type RepositoryCacheEntry = {
  repository: string;
  directory: string;
  bytes: number;
  updatedAt: string;
  locked: boolean;
  staleLock: boolean;
  worktrees: number | null;
};

export type RepositoryCachePruneResult = {
  removed: RepositoryCacheEntry[];
  skipped: Array<
    RepositoryCacheEntry & { reason: "locked" | "worktrees" | "recent" }
  >;
  reclaimedBytes: number;
  dryRun: boolean;
};

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

export async function inspectGlobalRepositoryCache(
  input: {
    configDir?: string;
  } = {}
): Promise<RepositoryCacheEntry[]> {
  const root = resolveGlobalRepositoryCacheRoot(input.configDir);
  const owners = await safeDirectories(root);
  const entries: RepositoryCacheEntry[] = [];
  for (const owner of owners) {
    for (const name of await safeDirectories(join(root, owner))) {
      if (!name.endsWith(".git")) continue;
      const directory = join(root, owner, name);
      const lockDirectory = join(root, owner, `${name.slice(0, -4)}.lock`);
      const locked = await pathExists(lockDirectory);
      const staleLock = locked
        ? await isRepositoryLockStale(lockDirectory)
        : false;
      const details = await safeStat(directory);
      if (!details) continue;
      entries.push({
        repository: `${owner}/${name.slice(0, -4)}`,
        directory,
        bytes: locked && !staleLock ? 0 : await directorySize(directory),
        updatedAt: await readLastUsedAt(directory, details.mtime),
        locked,
        staleLock,
        worktrees:
          locked && !staleLock ? null : await countLinkedWorktrees(directory),
      });
    }
  }
  return entries.sort((a, b) => a.repository.localeCompare(b.repository));
}

export async function pruneGlobalRepositoryCache(input: {
  configDir?: string;
  maxAgeMs: number;
  now?: Date;
  dryRun?: boolean;
}): Promise<RepositoryCachePruneResult> {
  const now = input.now ?? new Date();
  const result: RepositoryCachePruneResult = {
    removed: [],
    skipped: [],
    reclaimedBytes: 0,
    dryRun: Boolean(input.dryRun),
  };
  for (const entry of await inspectGlobalRepositoryCache(input)) {
    if (now.getTime() - Date.parse(entry.updatedAt) < input.maxAgeMs) {
      result.skipped.push({ ...entry, reason: "recent" });
      continue;
    }
    if (entry.locked && !entry.staleLock) {
      result.skipped.push({ ...entry, reason: "locked" });
      continue;
    }
    if (entry.worktrees !== 0) {
      result.skipped.push({ ...entry, reason: "worktrees" });
      continue;
    }
    if (!input.dryRun) {
      const lockDirectory = `${entry.directory.slice(0, -4)}.lock`;
      const ownerToken = await tryAcquireRepositoryLock(lockDirectory, {
        breakStale: true,
      });
      if (!ownerToken) {
        result.skipped.push({ ...entry, locked: true, reason: "locked" });
        continue;
      }
      try {
        const details = await safeStat(entry.directory);
        if (!details) continue;
        const updatedAt = await readLastUsedAt(entry.directory, details.mtime);
        if (now.getTime() - Date.parse(updatedAt) < input.maxAgeMs) {
          result.skipped.push({ ...entry, updatedAt, reason: "recent" });
          continue;
        }
        if ((await countLinkedWorktrees(entry.directory)) !== 0) {
          result.skipped.push({ ...entry, reason: "worktrees" });
          continue;
        }
        await rm(entry.directory, { recursive: true, force: true });
      } finally {
        await releaseRepositoryLock(lockDirectory, ownerToken);
      }
    }
    result.removed.push(entry);
    result.reclaimedBytes += entry.bytes;
  }
  return result;
}

async function safeDirectories(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(path);
      continue;
    }
    const details = await safeStat(path);
    if (details) total += details.size;
  }
  return total;
}

async function safeStat(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readLastUsedAt(
  directory: string,
  fallback: Date
): Promise<string> {
  try {
    const marker = await readFile(join(directory, LAST_USED_MARKER), "utf8");
    const usedAt = Date.parse(marker.trim());
    return Number.isFinite(usedAt)
      ? new Date(usedAt).toISOString()
      : fallback.toISOString();
  } catch (error) {
    if (isMissing(error)) return fallback.toISOString();
    throw error;
  }
}

async function countLinkedWorktrees(directory: string): Promise<number | null> {
  try {
    const output = await runGitCommandCapture([
      "-C",
      directory,
      "worktree",
      "list",
      "--porcelain",
    ]);
    return Math.max(
      0,
      output.split("\n").filter((line) => line.startsWith("worktree ")).length -
        1
    );
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
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
  let ownerToken: string;
  try {
    await mkdir(dirname(bareDirectory), { recursive: true });
    ownerToken = await acquireRepositoryLock(lockDirectory);
  } catch (error) {
    throw cacheUnavailableError(bareDirectory, error);
  }
  try {
    const heartbeat = startRepositoryLockHeartbeat(
      lockDirectory,
      ownerToken,
      CACHE_LOCK_HEARTBEAT_MS
    );
    try {
      return await ensureBareRepositoryCacheUnderLock({
        ...input,
        bareDirectory,
        cloneUrl,
      });
    } catch (error) {
      throw cacheUnavailableError(bareDirectory, error);
    } finally {
      await heartbeat.stop();
    }
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
  let ownerToken: string;
  try {
    await mkdir(dirname(bareDirectory), { recursive: true });
    ownerToken = await acquireRepositoryLock(lockDirectory);
  } catch (error) {
    throw cacheUnavailableError(bareDirectory, error);
  }
  try {
    const heartbeat = startRepositoryLockHeartbeat(
      lockDirectory,
      ownerToken,
      CACHE_LOCK_HEARTBEAT_MS
    );
    try {
      try {
        await ensureBareRepositoryCacheUnderLock({
          ...input,
          bareDirectory,
          cloneUrl,
        });
      } catch (error) {
        throw cacheUnavailableError(bareDirectory, error);
      }
      return await operation(bareDirectory);
    } finally {
      await heartbeat.stop();
    }
  } finally {
    await releaseRepositoryLock(lockDirectory, ownerToken);
  }
}

function cacheUnavailableError(
  bareDirectory: string,
  cause: unknown
): RepositoryCacheUnavailableError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new RepositoryCacheUnavailableError(
    `Global repository cache unavailable at ${bareDirectory}: ${detail}`,
    cause
  );
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
    await writeLastUsedMarker(input.bareDirectory, now);
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
    await writeLastUsedMarker(input.bareDirectory, now);
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

  await writeLastUsedMarker(input.bareDirectory, now);

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

async function writeLastUsedMarker(
  directory: string,
  now: Date
): Promise<void> {
  await writeFile(
    join(directory, LAST_USED_MARKER),
    `${now.toISOString()}\n`,
    "utf8"
  );
}
