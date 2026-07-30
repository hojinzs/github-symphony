import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PersistentIssueCommentCache } from "./issue-comment-cache.js";

describe("PersistentIssueCommentCache", () => {
  it("persists comment ids and ETags in the project cache directory", async () => {
    const projectDirectory = await mkdtemp(
      join(tmpdir(), "orchestrator-comment-cache-")
    );
    const cacheKey = "github:acme:platform:issue-1:marker";
    const firstInstance = new PersistentIssueCommentCache(projectDirectory);

    await firstInstance.set(cacheKey, {
      commentId: 42,
      etag: '"comment-v1"',
      body: "marker body",
    });

    const secondInstance = new PersistentIssueCommentCache(projectDirectory);
    expect(await secondInstance.get(cacheKey)).toEqual({
      commentId: 42,
      etag: '"comment-v1"',
      body: "marker body",
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
});
