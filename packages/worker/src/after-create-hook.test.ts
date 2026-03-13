import { execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceDirectory } from "@gh-symphony/core";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAfterCreateHookScript,
  prepareAfterCreateHook,
} from "./after-create-hook.js";

const execFileAsync = promisify(execFile);
const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0, tempPaths.length).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
      })
    )
  );
});

describe("resolveWorkspaceDirectory", () => {
  it("keeps workspaces inside the configured root", () => {
    expect(
      resolveWorkspaceDirectory("/tmp/github-symphony", "workspace-1")
    ).toBe("/tmp/github-symphony/workspace-1");
  });

  it("rejects path traversal", () => {
    expect(() =>
      resolveWorkspaceDirectory("/tmp/github-symphony", "../outside")
    ).toThrow("Workspace path escapes");
  });
});

describe("buildAfterCreateHookScript", () => {
  it("contains clone command", () => {
    const script = buildAfterCreateHookScript();

    expect(script).toContain("git clone");
  });
});

describe("prepareAfterCreateHook", () => {
  it("creates a hook script that clones an allowed repository", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-symphony-hook-"));
    const bareRepository = join(root, "platform.git");
    const hooksRoot = join(root, "hooks");
    const workspaceRoot = join(root, "workspaces");
    tempPaths.push(root);

    await mkdir(workspaceRoot, {
      recursive: true,
    });

    await execFileAsync("git", ["init", "--bare", bareRepository]);

    const hook = await prepareAfterCreateHook(hooksRoot, {
      workspaceId: "workspace-1",
      workspaceRoot,
      targetRepositoryCloneUrl: bareRepository,
    });

    await execFileAsync("bash", [hook.scriptPath], {
      env: {
        ...process.env,
        ...hook.env,
      },
    });

    expect(
      existsSync(join(hook.workspaceDirectory, "repository", ".git"))
    ).toBe(true);
  });
});
