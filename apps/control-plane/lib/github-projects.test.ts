import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceIssue,
  createWorkspaceProject,
  GitHubGraphQLError
} from "./github-projects";

describe("createWorkspaceProject", () => {
  it("resolves the owner and creates a GitHub project", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              user: {
                id: "owner-1"
              },
              organization: null
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              createProjectV2: {
                projectV2: {
                  id: "project-1",
                  number: 7,
                  title: "Platform Workspace",
                  url: "https://github.com/orgs/acme/projects/7"
                }
              }
            }
          }),
          { status: 200 }
        )
      );

    const project = await createWorkspaceProject(
      "ghp_secret",
      {
        ownerLogin: "acme",
        title: "Platform Workspace"
      },
      fetchImpl as typeof fetch
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(project).toEqual({
      id: "project-1",
      number: 7,
      title: "Platform Workspace",
      url: "https://github.com/orgs/acme/projects/7"
    });
  });
});

describe("createWorkspaceIssue", () => {
  it("creates an issue and attaches it to the GitHub project", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              repository: {
                id: "repo-1"
              }
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              createIssue: {
                issue: {
                  id: "issue-1",
                  number: 21,
                  url: "https://github.com/acme/platform/issues/21"
                }
              }
            }
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              addProjectV2ItemById: {
                item: {
                  id: "project-item-1"
                }
              }
            }
          }),
          { status: 200 }
        )
      );

    const issue = await createWorkspaceIssue(
      "ghp_secret",
      {
        repositoryOwner: "acme",
        repositoryName: "platform",
        projectId: "project-1",
        title: "Ship the dashboard",
        body: "Implement workspace observability."
      },
      fetchImpl as typeof fetch
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(issue).toEqual({
      id: "issue-1",
      number: 21,
      url: "https://github.com/acme/platform/issues/21",
      projectItemId: "project-item-1"
    });
  });

  it("surfaces GitHub GraphQL failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          errors: [{ message: "boom" }]
        }),
        { status: 200 }
      )
    );

    await expect(
      createWorkspaceIssue(
        "ghp_secret",
        {
          repositoryOwner: "acme",
          repositoryName: "platform",
          projectId: "project-1",
          title: "Ship the dashboard",
          body: "Implement workspace observability."
        },
        fetchImpl as typeof fetch
      )
    ).rejects.toBeInstanceOf(GitHubGraphQLError);
  });
});
