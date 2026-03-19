import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readEnvFile } from "./env-file.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("readEnvFile", () => {
  it("parses key-value pairs and ignores comments and blank lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "env-file-"));
    tempDirs.push(dir);
    const envPath = join(dir, ".env");

    await writeFile(
      envPath,
      [
        "# comment",
        "",
        "FOO=bar",
        " SPACED_KEY = spaced value ",
        "URL=https://example.com?a=1&b=2",
        "INVALID_LINE",
      ].join("\n"),
      "utf8"
    );

    expect(readEnvFile(envPath)).toEqual({
      FOO: "bar",
      SPACED_KEY: "spaced value",
      URL: "https://example.com?a=1&b=2",
    });
  });

  it("returns an empty object when the file does not exist", () => {
    expect(readEnvFile(join(tmpdir(), "missing-env-file"))).toEqual({});
  });
});
