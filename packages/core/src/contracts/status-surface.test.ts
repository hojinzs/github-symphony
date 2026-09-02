import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertIssueWorkspaceRootOutsideRepository,
  normalizeOrchestratorProjectConfig,
} from "./status-surface.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("issue workspace containment", () => {
  it("rejects a workspace root symlink that contains the repository", () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-project-config-"));
    temporaryDirectories.push(root);
    const repositoryDir = join(root, "repository");
    const workspaceRootLink = join(root, "workspace-root-link");
    symlinkSync(root, workspaceRootLink);

    expect(() =>
      assertIssueWorkspaceRootOutsideRepository(
        "tenant-1",
        workspaceRootLink,
        repositoryDir
      )
    ).toThrow("workspace.root");
  });

  it("uses the shared containment check when normalizing repo projects", () => {
    const root = mkdtempSync(join(tmpdir(), "symphony-project-config-"));
    temporaryDirectories.push(root);
    const repositoryDir = join(root, "repository");
    const workspaceRootLink = join(root, "workspace-root-link");
    symlinkSync(root, workspaceRootLink);

    expect(() =>
      normalizeOrchestratorProjectConfig({
        projectId: "tenant-1",
        slug: "tenant-1",
        workspaceDir: workspaceRootLink,
        repositoryDir,
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        tracker: { adapter: "github-project", bindingId: "project-1" },
        workflowSource: { type: "repo" },
      })
    ).toThrow("workspace.root");
  });
});
