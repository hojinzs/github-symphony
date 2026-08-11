import { join } from "node:path";
import {
  readJsonFile,
  type IssueCommentCache,
  type IssueCommentCacheEntry,
} from "@gh-symphony/core";
import { writeFileAtomically } from "./durable-file.js";

type PersistedIssueCommentCache = {
  version: 1;
  entries: Record<string, IssueCommentCacheEntry>;
};

const EMPTY_CACHE: PersistedIssueCommentCache = {
  version: 1,
  entries: {},
};

export class PersistentIssueCommentCache implements IssueCommentCache {
  private statePromise: Promise<PersistedIssueCommentCache> | null = null;

  constructor(projectDirectory: string) {
    this.path = join(projectDirectory, "cache", "issue-comments.json");
  }

  private readonly path: string;

  async get(key: string): Promise<IssueCommentCacheEntry | null> {
    const state = await this.load();
    return state.entries[key] ?? null;
  }

  async set(key: string, entry: IssueCommentCacheEntry): Promise<void> {
    const state = await this.load();
    state.entries[key] = entry;
    await this.persist(state);
  }

  async delete(key: string): Promise<void> {
    const state = await this.load();
    if (!(key in state.entries)) {
      return;
    }

    delete state.entries[key];
    await this.persist(state);
  }

  private async load(): Promise<PersistedIssueCommentCache> {
    this.statePromise ??= this.loadFromDisk();
    return this.statePromise;
  }

  private async loadFromDisk(): Promise<PersistedIssueCommentCache> {
    let persisted: unknown;
    try {
      persisted = await readJsonFile<PersistedIssueCommentCache>(this.path);
    } catch (error) {
      if (error instanceof SyntaxError) {
        this.warnDiscardedCache("malformed JSON");
        return structuredClone(EMPTY_CACHE);
      }

      throw error;
    }

    if (persisted === null) {
      return structuredClone(EMPTY_CACHE);
    }

    if (!isPersistedIssueCommentCache(persisted)) {
      this.warnDiscardedCache("invalid shape");
      return structuredClone(EMPTY_CACHE);
    }

    return persisted;
  }

  private async persist(state: PersistedIssueCommentCache): Promise<void> {
    await writeFileAtomically(this.path, `${JSON.stringify(state, null, 2)}\n`);
  }

  private warnDiscardedCache(reason: string): void {
    console.warn(
      `[orchestrator] Discarding issue comment cache at ${this.path}: ${reason}`
    );
  }
}

function isPersistedIssueCommentCache(
  value: unknown
): value is PersistedIssueCommentCache {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.entries)) {
    return false;
  }

  return Object.values(value.entries).every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.commentId === "number" &&
      (typeof entry.etag === "string" || entry.etag === null) &&
      typeof entry.body === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
