import { describe, expect, it, vi } from "vitest";
import { createClient, discoverUserProjects } from "./client.js";

function graphqlResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("discoverUserProjects", () => {
  it("paginates viewer projects", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { cursor?: string | null };
      };

      if (body.query.includes("ViewerProjectsPage")) {
        if (!body.variables?.cursor) {
          return graphqlResponse({
            viewer: {
              login: "moncher-dev",
              projectsV2: {
                nodes: [
                  {
                    id: "PVT_user_1",
                    title: "Viewer One",
                    shortDescription: null,
                    url: "https://github.com/users/moncher-dev/projects/1",
                    items: { totalCount: 3 },
                  },
                ],
                pageInfo: { endCursor: "viewer-page-1", hasNextPage: true },
              },
            },
          });
        }

        return graphqlResponse({
          viewer: {
            login: "moncher-dev",
            projectsV2: {
              nodes: [
                {
                  id: "PVT_user_2",
                  title: "Viewer Two",
                  shortDescription: "second",
                  url: "https://github.com/users/moncher-dev/projects/2",
                  items: { totalCount: 5 },
                },
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        });
      }

      if (body.query.includes("ViewerOrganizationsPage")) {
        return graphqlResponse({
          viewer: {
            organizations: {
              nodes: [],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    });

    const result = await discoverUserProjects(
      createClient("token", { fetchImpl: fetchImpl as typeof fetch })
    );

    expect(result).toMatchObject({
      partial: false,
      reason: null,
      requests: 3,
    });
    expect(result.projects.map((project) => project.id)).toEqual([
      "PVT_user_1",
      "PVT_user_2",
    ]);
    expect(result.projects.map((project) => project.owner)).toEqual([
      { login: "moncher-dev", type: "User" },
      { login: "moncher-dev", type: "User" },
    ]);
  });

  it("paginates organization pages and organization projects", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { cursor?: string | null; login?: string };
      };

      if (body.query.includes("ViewerProjectsPage")) {
        return graphqlResponse({
          viewer: {
            login: "moncher-dev",
            projectsV2: {
              nodes: [],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        });
      }

      if (body.query.includes("ViewerOrganizationsPage")) {
        if (!body.variables?.cursor) {
          return graphqlResponse({
            viewer: {
              organizations: {
                nodes: [{ login: "acme" }],
                pageInfo: { endCursor: "org-page-1", hasNextPage: true },
              },
            },
          });
        }

        return graphqlResponse({
          viewer: {
            organizations: {
              nodes: [{ login: "beta" }],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        });
      }

      if (body.query.includes("OrganizationProjectsPage")) {
        if (body.variables?.login === "acme" && !body.variables?.cursor) {
          return graphqlResponse({
            organization: {
              projectsV2: {
                nodes: [
                  {
                    id: "PVT_acme_1",
                    title: "Acme One",
                    shortDescription: null,
                    url: "https://github.com/orgs/acme/projects/1",
                    items: { totalCount: 2 },
                  },
                ],
                pageInfo: { endCursor: "acme-page-1", hasNextPage: true },
              },
            },
          });
        }

        if (body.variables?.login === "acme") {
          return graphqlResponse({
            organization: {
              projectsV2: {
                nodes: [
                  {
                    id: "PVT_acme_2",
                    title: "Acme Two",
                    shortDescription: "extra",
                    url: "https://github.com/orgs/acme/projects/2",
                    items: { totalCount: 4 },
                  },
                ],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          });
        }

        return graphqlResponse({
          organization: {
            projectsV2: {
              nodes: [
                {
                  id: "PVT_beta_1",
                  title: "Beta One",
                  shortDescription: null,
                  url: "https://github.com/orgs/beta/projects/1",
                  items: { totalCount: 1 },
                },
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    });

    const result = await discoverUserProjects(
      createClient("token", { fetchImpl: fetchImpl as typeof fetch })
    );

    expect(result).toMatchObject({
      partial: false,
      reason: null,
      requests: 6,
    });
    expect(result.projects.map((project) => `${project.owner.login}:${project.title}`))
      .toEqual(["acme:Acme One", "acme:Acme Two", "beta:Beta One"]);
  });

  it("returns partial results when the request budget is exhausted", async () => {
    const orgLogins = Array.from({ length: 40 }, (_, index) => `org-${index + 1}`);
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { cursor?: string | null; login?: string };
      };

      if (body.query.includes("ViewerProjectsPage")) {
        return graphqlResponse({
          viewer: {
            login: "moncher-dev",
            projectsV2: {
              nodes: [],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        });
      }

      if (body.query.includes("ViewerOrganizationsPage")) {
        if (!body.variables?.cursor) {
          return graphqlResponse({
            viewer: {
              organizations: {
                nodes: orgLogins.slice(0, 20).map((login) => ({ login })),
                pageInfo: { endCursor: "org-page-1", hasNextPage: true },
              },
            },
          });
        }

        return graphqlResponse({
          viewer: {
            organizations: {
              nodes: orgLogins.slice(20).map((login) => ({ login })),
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        });
      }

      if (body.query.includes("OrganizationProjectsPage")) {
        return graphqlResponse({
          organization: {
            projectsV2: {
              nodes: [
                {
                  id: `PVT_${body.variables?.login}`,
                  title: `Project ${body.variables?.login}`,
                  shortDescription: null,
                  url: `https://github.com/orgs/${body.variables?.login}/projects/1`,
                  items: { totalCount: 1 },
                },
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        });
      }

      throw new Error(`Unexpected query: ${body.query}`);
    });

    const result = await discoverUserProjects(
      createClient("token", { fetchImpl: fetchImpl as typeof fetch })
    );

    expect(result).toMatchObject({
      partial: true,
      reason: "request_limit",
      requests: 40,
    });
    expect(result.projects).toHaveLength(37);
    expect(result.projects[0]?.owner).toEqual({
      login: "org-1",
      type: "Organization",
    });
  });
});
