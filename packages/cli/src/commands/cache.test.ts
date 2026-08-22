import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import handler from "./cache.js";

describe("cache command", () => {
  it("reports an empty cache as JSON", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-cache-"));
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await handler(["status"], {
        configDir,
        verbose: false,
        json: true,
        noColor: true,
      });
      expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
        entries: [],
        totalBytes: 0,
      });
    } finally {
      write.mockRestore();
    }
  });

  it("rejects invalid prune ages", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-cache-"));
    await expect(
      handler(["prune", "--max-age-days", "nope"], {
        configDir,
        verbose: false,
        json: false,
        noColor: true,
      })
    ).rejects.toThrow(/non-negative number/);
  });

  it("distinguishes unverifiable cache entries from idle entries", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-cache-"));
    const bareDirectory = join(configDir, "repos", "acme", "broken.git");
    await mkdir(bareDirectory, { recursive: true });
    await writeFile(join(bareDirectory, "not-a-repository"), "broken");
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await handler(["status"], {
        configDir,
        verbose: false,
        json: false,
        noColor: true,
      });
      expect(String(write.mock.calls[0]?.[0])).toContain("unverifiable");
    } finally {
      write.mockRestore();
    }
  });
});
