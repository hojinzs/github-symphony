import { describe, expect, it } from "vitest";
import {
  buildWorkspaceCreateData,
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
      githubOwnerLogin: undefined
    });
  });

  it("rejects empty repository selections", () => {
    expect(() =>
      parseCreateWorkspaceInput({
        name: "Platform",
        promptGuidelines: "Prefer small changes",
        repositories: []
      })
    ).toThrow("repositories must contain at least one repository.");
  });
});

describe("slugifyWorkspaceName", () => {
  it("normalizes workspace names into slugs", () => {
    expect(slugifyWorkspaceName("Platform Ops Workspace")).toBe(
      "platform-ops-workspace"
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
        ]
      },
      "acme-user"
    );

    expect(data.slug).toBe("platform");
    expect(data.githubOwnerLogin).toBe("acme-user");
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
});
