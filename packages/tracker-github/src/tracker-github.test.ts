import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW_LIFECYCLE } from "@gh-symphony/core";
import { resolveTrackerAdapter } from "./orchestrator-adapter.js";
import {
  validateWorkflowFieldMapping,
  detectDuplicatePlacements,
  detectTransferRebindRequired,
} from "./validation.js";

describe("resolveTrackerAdapter", () => {
  it("returns an adapter for github-project", () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
    });

    expect(adapter).toBeDefined();
    expect(adapter.listIssues).toBeTypeOf("function");
    expect(adapter.buildWorkerEnvironment).toBeTypeOf("function");
    expect(adapter.reviveIssue).toBeTypeOf("function");
  });

  it("throws for unsupported tracker adapters", () => {
    expect(() =>
      resolveTrackerAdapter({
        adapter: "jira",
        bindingId: "board-1",
      })
    ).toThrow("Unsupported tracker adapter: jira");
  });

  it("uses dependencies.token when no env token is set", async () => {
    const originalToken = process.env.GITHUB_GRAPHQL_TOKEN;
    delete process.env.GITHUB_GRAPHQL_TOKEN;

    try {
      const adapter = resolveTrackerAdapter({
        adapter: "github-project",
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
        },
      });

      const fetchImpl = async (
        _url: string | URL | Request,
        _init?: RequestInit
      ) =>
        ({
          ok: true,
          json: async () => ({
            data: {
              node: {
                __typename: "ProjectV2",
                items: {
                  nodes: [],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          }),
          status: 200,
          headers: new Headers(),
        }) as Response;

      await adapter.listIssues(
        {
          tenantId: "workspace-1",
          slug: "workspace-1",

          repositories: [],
          tracker: {
            adapter: "github-project",
            bindingId: "project-123",
            settings: {
              projectId: "project-123",
            },
          },
          runtime: {
            driver: "local",
            workspaceRuntimeDir: "/tmp/workspace-1",
            projectRoot: "/tmp/workspace-1",
          },
        },
        {
          token: "dependencies-token",
          fetchImpl: async (url, init) => {
            const headers = new Headers(init?.headers);
            expect(headers.get("authorization")).toBe(
              "Bearer dependencies-token"
            );
            return fetchImpl(url, init);
          },
        }
      );
    } finally {
      if (originalToken === undefined) {
        delete process.env.GITHUB_GRAPHQL_TOKEN;
      } else {
        process.env.GITHUB_GRAPHQL_TOKEN = originalToken;
      }
    }
  });

  it("filters to issues assigned to the authenticated user when enabled", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      const adapter = resolveTrackerAdapter({
        adapter: "github-project",
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
          assignedOnly: true as unknown as string,
        },
      });

      const issues = await adapter.listIssues(
        {
          tenantId: "workspace-1",
          slug: "workspace-1",
          repositories: [],
          tracker: {
            adapter: "github-project",
            bindingId: "project-123",
            settings: {
              projectId: "project-123",
              assignedOnly: true as unknown as string,
            },
          },
          runtime: {
            driver: "local",
            workspaceRuntimeDir: "/tmp/workspace-1",
            projectRoot: "/tmp/workspace-1",
          },
        },
        {
          token: "dependencies-token",
          fetchImpl: async (url, init) => {
            if (String(url).endsWith("/user")) {
              expect(init?.method).toBe("GET");
              return new Response(JSON.stringify({ login: "machine-user" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }

            const body = JSON.parse(String(init?.body)) as { query: string };
            expect(body.query).toContain("assignees(first: 20)");

            return new Response(
              JSON.stringify({
                data: {
                  node: {
                    __typename: "ProjectV2",
                    items: {
                      nodes: [
                        makeProjectItem({
                          itemId: "item-1",
                          issueId: "issue-1",
                          number: 1,
                          title: "Assigned issue",
                          assignees: ["machine-user"],
                        }),
                        makeProjectItem({
                          itemId: "item-2",
                          issueId: "issue-2",
                          number: 2,
                          title: "Other issue",
                          assignees: ["someone-else"],
                        }),
                      ],
                      pageInfo: { endCursor: null, hasNextPage: false },
                    },
                  },
                },
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              }
            );
          },
        }
      );

      expect(issues).toHaveLength(1);
      expect(issues[0]?.identifier).toBe("acme/platform#1");
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"tracker-assigned-only-filtered"')
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"excludedCount":1')
      );
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe("validateWorkflowFieldMapping", () => {
  it("returns valid when all lifecycle states are present", () => {
    const result = validateWorkflowFieldMapping({
      lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
      availableOptions: ["Todo", "In Progress", "Done"],
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("reports missing options", () => {
    const result = validateWorkflowFieldMapping({
      lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
      availableOptions: ["Done"],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.state === "Todo")).toBe(true);
  });

  it("matches case-insensitively", () => {
    const result = validateWorkflowFieldMapping({
      lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
      availableOptions: ["todo", "in progress", "done"],
    });

    expect(result.valid).toBe(true);
  });
});

describe("detectDuplicatePlacements", () => {
  const makeIssue = (id: string, identifier: string, itemId: string) => ({
    id,
    identifier,
    number: 1,
    title: "Test",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    repository: {
      owner: "acme",
      name: "platform",
      url: "https://github.com/acme/platform",
      cloneUrl: "https://github.com/acme/platform.git",
    },
    tracker: {
      adapter: "github-project" as const,
      bindingId: "project-123",
      itemId,
    },
    metadata: {},
  });

  it("returns empty when no duplicates exist", () => {
    const result = detectDuplicatePlacements([
      makeIssue("issue-1", "acme/platform#1", "item-1"),
      makeIssue("issue-2", "acme/platform#2", "item-2"),
    ]);

    expect(result).toHaveLength(0);
  });

  it("detects duplicate placements for the same issue", () => {
    const result = detectDuplicatePlacements([
      makeIssue("issue-1", "acme/platform#1", "item-1"),
      makeIssue("issue-1", "acme/platform#1", "item-2"),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.issueId).toBe("issue-1");
    expect(result[0]?.duplicateItemIds).toEqual(["item-1", "item-2"]);
  });
});

describe("detectTransferRebindRequired", () => {
  const makeIssue = (owner: string, name: string) => ({
    id: "issue-1",
    identifier: `${owner}/${name}#1`,
    number: 1,
    title: "Test",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    repository: {
      owner,
      name,
      url: `https://github.com/${owner}/${name}`,
      cloneUrl: `https://github.com/${owner}/${name}.git`,
    },
    tracker: {
      adapter: "github-project" as const,
      bindingId: "project-123",
      itemId: "item-1",
    },
    metadata: {},
  });

  it("returns null when issue matches the known alias", () => {
    const result = detectTransferRebindRequired(makeIssue("acme", "platform"), {
      owner: "acme",
      name: "platform",
    });

    expect(result).toBeNull();
  });

  it("detects a transfer when repository changed", () => {
    const result = detectTransferRebindRequired(makeIssue("acme", "new-repo"), {
      owner: "acme",
      name: "old-repo",
    });

    expect(result).not.toBeNull();
    expect(result?.previousRepository).toEqual({
      owner: "acme",
      name: "old-repo",
    });
    expect(result?.currentRepository).toEqual({
      owner: "acme",
      name: "new-repo",
    });
  });
});

function makeProjectItem(input: {
  itemId: string;
  issueId: string;
  number: number;
  title: string;
  assignees: string[];
}) {
  return {
    id: input.itemId,
    updatedAt: "2026-03-14T00:00:00.000Z",
    fieldValues: {
      nodes: [
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue" as const,
          name: "Todo",
          field: { name: "Status" },
        },
      ],
    },
    content: {
      __typename: "Issue" as const,
      id: input.issueId,
      number: input.number,
      title: input.title,
      body: null,
      url: `https://github.com/acme/platform/issues/${input.number}`,
      createdAt: "2026-03-14T00:00:00.000Z",
      updatedAt: "2026-03-14T00:00:00.000Z",
      labels: { nodes: [] },
      assignees: {
        nodes: input.assignees.map((login) => ({ login })),
      },
      repository: {
        name: "platform",
        url: "https://github.com/acme/platform",
        owner: { login: "acme" },
      },
      blockedBy: { nodes: [] },
    },
  };
}
