import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { executeWorkspaceHook } from "./hooks.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("executeWorkspaceHook", () => {
  it("executes inline hook bodies via bash -lc", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "hook-inline-"));
    tempDirs.push(repositoryPath);

    const result = await executeWorkspaceHook({
      kind: "after_create",
      hooks: {
        afterCreate: 'printf "ok" > "$SYMPHONY_REPOSITORY_PATH/.hook-result"',
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
      },
      repositoryPath,
      env: {
        SYMPHONY_REPOSITORY_PATH: repositoryPath,
      },
      timeoutMs: 5000,
    });

    expect(result.outcome).toBe("success");
    expect(await readFile(join(repositoryPath, ".hook-result"), "utf8")).toBe(
      "ok"
    );
  });

  it("times out long-running hook commands", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "hook-timeout-"));
    tempDirs.push(repositoryPath);

    const result = await executeWorkspaceHook({
      kind: "before_run",
      hooks: {
        afterCreate: null,
        beforeRun: "sleep 1",
        afterRun: null,
        beforeRemove: null,
      },
      repositoryPath,
      env: {},
      timeoutMs: 10,
    });

    expect(result.outcome).toBe("timeout");
  });

  it("supports repository-relative hook paths via bash execution", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "hook-path-"));
    tempDirs.push(repositoryPath);
    await mkdir(join(repositoryPath, "hooks"), { recursive: true });
    await writeFile(
      join(repositoryPath, "hooks", "after_run.sh"),
      '#!/usr/bin/env bash\nprintf "path-ok" > "$SYMPHONY_REPOSITORY_PATH/.path-hook"\n',
      "utf8"
    );

    const result = await executeWorkspaceHook({
      kind: "after_run",
      hooks: {
        afterCreate: null,
        beforeRun: null,
        afterRun: "hooks/after_run.sh",
        beforeRemove: null,
      },
      repositoryPath,
      env: {
        SYMPHONY_REPOSITORY_PATH: repositoryPath,
      },
      timeoutMs: 5000,
    });

    expect(result.outcome).toBe("success");
    expect(await readFile(join(repositoryPath, ".path-hook"), "utf8")).toBe(
      "path-ok"
    );
  });
});
