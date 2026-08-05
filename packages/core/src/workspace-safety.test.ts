import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertRepositoryAllowed, resolveWorkspaceDirectory } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
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

  it("rejects a symlink that resolves outside the workspace root", () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-workspace-root-"));
    const outside = mkdtempSync(join(tmpdir(), "symphony-workspace-outside-"));
    temporaryDirectories.push(root, outside);
    symlinkSync(outside, join(root, "linked"));

    expect(() => resolveWorkspaceDirectory(root, "linked")).toThrow(
      "Workspace path escapes"
    );
    expect(() => resolveWorkspaceDirectory(root, "linked/new")).toThrow(
      "Workspace path escapes"
    );
  });

  it("rejects a dangling symlink that points outside the workspace root", () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-workspace-root-"));
    const outside = join(tmpdir(), "symphony-workspace-missing-target");
    temporaryDirectories.push(root);
    symlinkSync(outside, join(root, "linked"));

    expect(() => resolveWorkspaceDirectory(root, "linked")).toThrow(
      "Workspace path escapes"
    );
  });

  it("accepts paths containing Windows-style separators as workspace names", () => {
    expect(() =>
      resolveWorkspaceDirectory("/tmp/github-symphony", "workspace\\nested")
    ).not.toThrow();
  });
});

describe("assertRepositoryAllowed", () => {
  it("rejects repositories outside the workspace allowlist", () => {
    expect(() =>
      assertRepositoryAllowed("https://github.com/acme/other.git", [
        "https://github.com/acme/platform.git",
      ])
    ).toThrow("Repository is not in the workspace allowlist");
  });
});
