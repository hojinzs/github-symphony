import { Prisma, WorkspaceAgentCredentialSource } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  buildWorkspaceCreateData,
  buildWorkspaceSlugCandidate,
  createWorkspaceInputFromSubmission,
  createWorkspace,
  parseCreateWorkspaceSubmission,
  parseCreateWorkspaceInput,
  slugifyWorkspaceName
} from "./workspace-service";

describe("parseCreateWorkspaceInput", () => {
  it("parses a valid workspace request", () => {
    expect(
      parseCreateWorkspaceInput({
        name: "Platform",
        promptGuidelines: "Prefer small changes",
        repositories: [
          {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git"
          }
        ]
      })
    ).toEqual({
      name: "Platform",
      promptGuidelines: "Prefer small changes",
      repositories: [
        {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git"
        }
      ],
      githubOwnerLogin: undefined,
      agentCredentialSource: WorkspaceAgentCredentialSource.platform_default,
      agentCredentialId: undefined
    });
  });

  it("rejects empty repository selections", () => {
    expect(() =>
      parseCreateWorkspaceInput({
        name: "Platform",
        promptGuidelines: "Prefer small changes",
        repositories: [],
        agentCredentialSource: WorkspaceAgentCredentialSource.platform_default
      })
    ).toThrow("repositories must contain at least one repository.");
  });
});

describe("parseCreateWorkspaceSubmission", () => {
  it("parses repository selections submitted from the workspace form", () => {
    expect(
      parseCreateWorkspaceSubmission({
        name: "Platform",
        promptGuidelines: "Prefer small changes",
        repositoryIds: ["repo-2", "repo-2", "repo-1"]
      })
    ).toEqual({
      name: "Platform",
      promptGuidelines: "Prefer small changes",
      repositoryIds: ["repo-2", "repo-1"],
      githubOwnerLogin: undefined,
      agentCredentialSource: WorkspaceAgentCredentialSource.platform_default,
      agentCredentialId: undefined
    });
  });

  it("rejects empty repository ID selections", () => {
    expect(() =>
      parseCreateWorkspaceSubmission({
        name: "Platform",
        promptGuidelines: "Prefer small changes",
        repositoryIds: []
      })
    ).toThrow("repositoryIds must contain at least one repository.");
  });
});

describe("slugifyWorkspaceName", () => {
  it("normalizes workspace names into slugs", () => {
    expect(slugifyWorkspaceName("Platform Ops Workspace")).toBe(
      "platform-ops-workspace"
    );
  });
});

describe("buildWorkspaceSlugCandidate", () => {
  it("adds a numeric suffix when the base slug collides", () => {
    expect(buildWorkspaceSlugCandidate("Platform Ops Workspace")).toBe(
      "platform-ops-workspace"
    );
    expect(buildWorkspaceSlugCandidate("Platform Ops Workspace", 1)).toBe(
      "platform-ops-workspace-2"
    );
  });
});

describe("buildWorkspaceCreateData", () => {
  it("builds Prisma create data with repositories and trusted-operator owner linkage", () => {
    const data = buildWorkspaceCreateData(
      {
        name: "Platform",
        promptGuidelines: "Prefer small changes",
        repositories: [
          {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git"
          }
        ],
        agentCredentialSource: WorkspaceAgentCredentialSource.platform_default
      },
      "acme-user"
    );

    expect(data.slug).toBe("platform");
    expect(data.githubOwnerLogin).toBe("acme-user");
    expect(data.agentCredentialSource).toBe(
      WorkspaceAgentCredentialSource.platform_default
    );
    expect(data.repositories).toEqual({
      create: [
        {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git"
        }
      ]
    });
  });

  it("builds a canonical workspace input from validated repository selections", () => {
    expect(
      createWorkspaceInputFromSubmission(
        {
          name: "Platform",
          promptGuidelines: "Prefer small changes",
          repositoryIds: ["repo-1"],
          agentCredentialSource: WorkspaceAgentCredentialSource.platform_default
        },
        [
          {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git"
          }
        ]
      )
    ).toEqual({
      name: "Platform",
      promptGuidelines: "Prefer small changes",
      repositories: [
        {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git"
        }
      ],
      githubOwnerLogin: undefined,
      agentCredentialSource: WorkspaceAgentCredentialSource.platform_default,
      agentCredentialId: undefined
    });
  });
});

describe("createWorkspace", () => {
  it("retries with a suffixed slug after a slug collision", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed on slug", {
          code: "P2002",
          clientVersion: "6.19.2",
          meta: {
            target: ["slug"]
          }
        })
      )
      .mockResolvedValueOnce({
        id: "workspace-2",
        slug: "platform-2",
        name: "Platform",
        promptGuidelines: "Prefer small changes",
        repositories: [
          {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git"
          }
        ]
      });

    const workspace = await createWorkspace(
      {
        name: "Platform",
        promptGuidelines: "Prefer small changes",
        repositories: [
          {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git"
          }
        ],
        agentCredentialSource: WorkspaceAgentCredentialSource.platform_default
      },
      "acme",
      {
        workspace: {
          create
        }
      } as never
    );

    expect(create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          slug: "platform"
        })
      })
    );
    expect(create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          slug: "platform-2"
        })
      })
    );
    expect(workspace.slug).toBe("platform-2");
  });
});
