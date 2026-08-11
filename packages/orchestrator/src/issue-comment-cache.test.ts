import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PersistentIssueCommentCache } from "./issue-comment-cache.js";

describe("PersistentIssueCommentCache", () => {
  it("persists comment ids and nullable ETags in the project cache directory", async () => {
    const projectDirectory = await mkdtemp(
      join(tmpdir(), "orchestrator-comment-cache-")
    );
    const cacheKey = "github:acme:platform:issue-1:marker";
    const adjacentCacheKey = "github:acme:platform:issue-2:marker";
    const firstInstance = new PersistentIssueCommentCache(projectDirectory);

    await firstInstance.set(cacheKey, {
      commentId: 42,
      etag: null,
      body: "marker body",
    });
    await firstInstance.set(adjacentCacheKey, {
      commentId: 43,
      etag: 'W/"comment-v1"',
      body: "adjacent marker body",
    });

    const secondInstance = new PersistentIssueCommentCache(projectDirectory);
    expect(await secondInstance.get(cacheKey)).toEqual({
      commentId: 42,
      etag: null,
      body: "marker body",
    });
    expect(await secondInstance.get(adjacentCacheKey)).toEqual({
      commentId: 43,
      etag: 'W/"comment-v1"',
      body: "adjacent marker body",
    });

    const persisted = JSON.parse(
      await readFile(
        join(projectDirectory, "cache", "issue-comments.json"),
        "utf8"
      )
    ) as { version: number; entries: Record<string, unknown> };
    expect(persisted.version).toBe(1);
    expect(persisted.entries[cacheKey]).toBeDefined();
  });

  it.each([
    ["malformed JSON", "{ not valid json"],
    ["an invalid cache shape", JSON.stringify({ version: 1, entries: [] })],
    [
      "an invalid cache entry",
      JSON.stringify({ version: 1, entries: { broken: { commentId: "42" } } }),
    ],
  ])("recovers from %s as an empty cache", async (_description, contents) => {
    const projectDirectory = await mkdtemp(
      join(tmpdir(), "orchestrator-comment-cache-invalid-")
    );
    const cacheDirectory = join(projectDirectory, "cache");
    await mkdir(cacheDirectory);
    await writeFile(
      join(cacheDirectory, "issue-comments.json"),
      contents,
      "utf8"
    );

    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    try {
      const cache = new PersistentIssueCommentCache(projectDirectory);
      await expect(cache.get("missing")).resolves.toBeNull();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Discarding issue comment cache")
      );
    } finally {
      warning.mockRestore();
    }
  });
});
