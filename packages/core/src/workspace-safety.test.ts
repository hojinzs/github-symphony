import { describe, expect, it } from "vitest";
import { assertRepositoryAllowed, resolveWorkspaceDirectory } from "./index.js";

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
