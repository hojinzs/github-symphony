import { describe, expect, it, vi } from "vitest";
import {
  GitHubPatValidationError,
  listGitHubPatRepositories,
  validateGitHubPat
} from "./github-pat-api";

describe("validateGitHubPat", () => {
  it("validates actor, organization access, repository inventory, and GraphQL project access", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 100,
            login: "machine-user"
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 200,
            login: "acme",
            html_url: "https://github.com/acme",
            type: "Organization"
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              viewer: {
                login: "machine-user"
              },
              organization: {
                id: "200",
                login: "acme",
                projectsV2: {
                  totalCount: 3
                }
              }
            }
          }),
          { status: 200 }
        )
      );

    const validated = await validateGitHubPat(
      {
        token: "ghp_machine_user",
        ownerLogin: "acme"
      },
      fetchImpl as typeof fetch
    );

    expect(validated.actorLogin).toBe("machine-user");
    expect(validated.validatedOwnerLogin).toBe("acme");
    expect(validated.validatedOwnerType).toBe("Organization");
  });

  it("surfaces missing GraphQL project access as a validation error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 100,
            login: "machine-user"
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 200,
            login: "acme",
            html_url: "https://github.com/acme",
            type: "Organization"
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [{ message: "Resource not accessible by personal access token" }]
          }),
          { status: 200 }
        )
      );

    await expect(
      validateGitHubPat(
        {
          token: "ghp_machine_user",
          ownerLogin: "acme"
        },
        fetchImpl as typeof fetch
      )
    ).rejects.toMatchObject({
      capability: "project_access"
    } satisfies Partial<GitHubPatValidationError>);
  });
});

describe("listGitHubPatRepositories", () => {
  it("lists organization repositories across pages", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: 22,
              name: "platform",
              full_name: "acme/platform",
              clone_url: "https://github.com/acme/platform.git",
              owner: {
                login: "acme"
              }
            }
          ]),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const repositories = await listGitHubPatRepositories(
      "ghp_machine_user",
      "acme",
      fetchImpl as typeof fetch
    );

    expect(repositories).toEqual([
      {
        id: "22",
        owner: "acme",
        name: "platform",
        fullName: "acme/platform",
        cloneUrl: "https://github.com/acme/platform.git"
      }
    ]);
  });
});
