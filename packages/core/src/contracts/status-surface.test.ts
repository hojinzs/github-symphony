import { describe, expect, it } from "vitest";
import {
  assertIssueWorkspaceRootOutsideRepository,
  normalizeOrchestratorProjectConfig,
} from "./status-surface.js";

const baseConfig = {
  projectId: "tenant-1",
  slug: "tenant-1",
  workspaceDir: "/tmp/workspaces/tenant-1",
  repository: {
    owner: "acme",
    name: "platform",
    cloneUrl: "https://github.com/acme/platform.git",
  },
  tracker: { adapter: "github-project" as const, bindingId: "project-1" },
};

describe("normalizeOrchestratorProjectConfig", () => {
  it("ignores fields removed from persisted project configs", () => {
    const normalized = normalizeOrchestratorProjectConfig({
      ...baseConfig,
      repositoryDir: "/repos/platform",
      populateStrategy: "clone",
      workflowSource: { type: "repo" },
    } as never);

    expect(normalized).toEqual(baseConfig);
    expect(normalized).not.toHaveProperty("repositoryDir");
    expect(normalized).not.toHaveProperty("populateStrategy");
    expect(normalized).not.toHaveProperty("workflowSource");
  });

  it("retains a valid external workflow source", () => {
    expect(
      normalizeOrchestratorProjectConfig({
        ...baseConfig,
        workflowSource: {
          type: "external",
          path: "/projects/tenant-1/WORKFLOW.md",
        },
      })
    ).toEqual({
      ...baseConfig,
      workflowSource: {
        type: "external",
        path: "/projects/tenant-1/WORKFLOW.md",
      },
    });
  });
});

describe("assertIssueWorkspaceRootOutsideRepository", () => {
  it("reports resolved paths when the workspace root contains the checkout", () => {
    expect(() =>
      assertIssueWorkspaceRootOutsideRepository(
        "tenant-1",
        "/tmp/workspaces/../workspaces",
        "/tmp/workspaces/repository/.."
      )
    ).toThrow(
      'Project "tenant-1" workspace.root "/tmp/workspaces" must not equal or contain the repository checkout "/tmp/workspaces".'
    );
  });
});
