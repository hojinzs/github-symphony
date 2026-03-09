import { execFile } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertRepositoryAllowed,
  resolveWorkspaceDirectory
} from "@github-symphony/core";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAfterCreateHookScript,
  prepareAfterCreateHook
} from "./after-create-hook.js";

const execFileAsync = promisify(execFile);
const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0, tempPaths.length).map((path) =>
      rm(path, {
        recursive: true,
        force: true
      })
    )
  );
});

describe("resolveWorkspaceDirectory", () => {
  it("keeps workspaces inside the configured root", () => {
    expect(resolveWorkspaceDirectory("/tmp/github-symphony", "workspace-1")).toBe(
      "/tmp/github-symphony/workspace-1"
    );
  });

  it("rejects path traversal", () => {
    expect(() =>
      resolveWorkspaceDirectory("/tmp/github-symphony", "../outside")
    ).toThrow("Workspace path escapes");
  });
});

describe("assertRepositoryAllowed", () => {
  it("rejects repositories outside the workspace allowlist", () => {
    expect(() =>
      assertRepositoryAllowed("https://github.com/acme/other.git", [
        "https://github.com/acme/platform.git"
      ])
    ).toThrow("Repository is not in the workspace allowlist");
  });
});

describe("buildAfterCreateHookScript", () => {
  it("contains clone and allowlist guards", () => {
    const script = buildAfterCreateHookScript();

    expect(script).toContain("git clone");
    expect(script).toContain("Repository is not allowed");
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
      recursive: true
    });

    await execFileAsync("git", ["init", "--bare", bareRepository]);

    const hook = await prepareAfterCreateHook(hooksRoot, {
      workspaceId: "workspace-1",
      workspaceRoot,
      targetRepositoryCloneUrl: bareRepository,
      allowedRepositoryCloneUrls: [bareRepository]
    });

    await execFileAsync("bash", [hook.scriptPath], {
      env: {
        ...process.env,
        ...hook.env
      }
    });

    expect(existsSync(join(hook.workspaceDirectory, "repository", ".git"))).toBe(true);
  });
});
