import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeFileAtomically } from "./durable-file.js";

describe("durable file writes", () => {
  it("atomically replaces a file and removes temporary artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-durable-"));
    const path = join(root, "nested", "state.json");

    await writeFileAtomically(path, '{"version":1}\n');
    await writeFileAtomically(path, '{"version":2}\n');

    await expect(readFile(path, "utf8")).resolves.toBe('{"version":2}\n');
    await expect(readdir(join(root, "nested"))).resolves.toEqual([
      "state.json",
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("does not collide when concurrent writers target the same path", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-durable-"));
    const path = join(root, "state.json");

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        writeFileAtomically(path, JSON.stringify({ index }) + "\n")
      )
    );

    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      index: number;
    };
    expect(parsed.index).toBeGreaterThanOrEqual(0);
    expect(parsed.index).toBeLessThan(20);
    await expect(readdir(root)).resolves.toEqual(["state.json"]);
  });
});
