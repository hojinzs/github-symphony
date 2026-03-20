import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { isFileMissing, readJsonFile, safeReadDir } from "./fs-reader.js";

describe("fs-reader", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((path) =>
        rm(path, { recursive: true, force: true })
      )
    );
  });

  it("reads JSON files and returns null for missing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "core-fs-reader-"));
    tempDirs.push(root);
    const filePath = join(root, "record.json");
    await writeFile(filePath, JSON.stringify({ value: 42 }), "utf8");

    await expect(readJsonFile<{ value: number }>(filePath)).resolves.toEqual({
      value: 42,
    });
    await expect(readJsonFile(join(root, "missing.json"))).resolves.toBeNull();
  });

  it("returns empty arrays for missing directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "core-fs-reader-"));
    tempDirs.push(root);

    await expect(safeReadDir(join(root, "missing"))).resolves.toEqual([]);
  });

  it("preserves directory entries for existing directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "core-fs-reader-"));
    tempDirs.push(root);
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "file.txt"), "content", "utf8");

    const entries = await safeReadDir(root);
    expect(entries.sort()).toEqual(["file.txt", "nested"]);
  });

  it("treats ENOENT and ENOTDIR as missing filesystem paths", () => {
    expect(isFileMissing({ code: "ENOENT" })).toBe(true);
    expect(isFileMissing({ code: "ENOTDIR" })).toBe(true);
    expect(isFileMissing({ code: "EACCES" })).toBe(false);
    expect(isFileMissing(null)).toBe(false);
  });
});
