import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKFLOW_LIFECYCLE } from "@gh-symphony/core";
import { normalizeGithubProjectItem } from "./adapter.js";
import { resolveTrackerAdapter } from "./orchestrator-adapter.js";
import {
  validateWorkflowFieldMapping,
  detectDuplicatePlacements,
  detectTransferRebindRequired,
} from "./validation.js";

describe("resolveTrackerAdapter", () => {
  it("normalizes blocker refs into the workflow lifecycle state domain", () => {
    const issue = normalizeGithubProjectItem(
      "project-123",
      {
        id: "item-1",
        updatedAt: "2026-03-14T00:00:00.000Z",
        fieldValues: {
          nodes: [
            {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              name: "Todo",
              field: { name: "Status" },
            },
          ],
        },
        content: {
          __typename: "Issue",
          id: "issue-1",
          number: 1,
          title: "Blocked issue",
          body: null,
          url: "https://github.com/acme/platform/issues/1",
          createdAt: "2026-03-14T00:00:00.000Z",
          updatedAt: "2026-03-14T00:00:00.000Z",
          labels: { nodes: [] },
          assignees: { nodes: [] },
          repository: {
            name: "platform",
            url: "https://github.com/acme/platform",
            owner: { login: "acme" },
          },
          blockedBy: {
            nodes: [
              {
                id: "issue-9",
                number: 9,
                state: "CLOSED",
                repository: {
                  name: "shared",
                  owner: { login: "other" },
                },
              },
              {
                id: "issue-10",
                number: 10,
                state: "OPEN",
                repository: {
                  name: "shared",
                  owner: { login: "other" },
                },
              },
            ],
          },
        },
      },
      DEFAULT_WORKFLOW_LIFECYCLE
    );

    expect(issue?.blockedBy).toEqual([
      {
        id: "issue-9",
        identifier: "other/shared#9",
        state: "Done",
      },
      {
        id: "issue-10",
        identifier: "other/shared#10",
        state: null,
      },
    ]);
  });

  it("maps a configured project priority field by single-select option order", () => {
    const issue = normalizeGithubProjectItem(
      "project-123",
      {
        id: "item-1",
        updatedAt: "2026-03-14T00:00:00.000Z",
        fieldValues: {
          nodes: [
            {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              name: "Todo",
              optionId: "status-todo",
              field: { name: "Status" },
            },
            {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              name: "P1",
              optionId: "priority-p1",
              field: { name: "Priority" },
            },
          ],
        },
        content: {
          __typename: "Issue",
          id: "issue-1",
          number: 1,
          title: "Prioritized issue",
          body: null,
          url: "https://github.com/acme/platform/issues/1",
          createdAt: "2026-03-14T00:00:00.000Z",
          updatedAt: "2026-03-14T00:00:00.000Z",
          labels: { nodes: [] },
          assignees: { nodes: [] },
          repository: {
            name: "platform",
            url: "https://github.com/acme/platform",
            owner: { login: "acme" },
          },
          blockedBy: {
            nodes: [],
          },
        },
      },
      DEFAULT_WORKFLOW_LIFECYCLE,
      {
        fieldName: "Priority",
        optionIds: {
          "priority-p0": 0,
          "priority-p1": 1,
          "priority-p2": 2,
        },
      }
    );

    expect(issue?.priority).toBe(1);
  });

  it("keeps priority null when the configured project field cannot be mapped", () => {
    const issue = normalizeGithubProjectItem(
      "project-123",
      {
        id: "item-1",
        updatedAt: "2026-03-14T00:00:00.000Z",
        fieldValues: {
          nodes: [
            {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              name: "Todo",
              optionId: "status-todo",
              field: { name: "Status" },
            },
            {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              name: "P1",
              optionId: "priority-p1",
              field: { name: "Priority" },
            },
          ],
        },
        content: {
          __typename: "Issue",
          id: "issue-1",
          number: 1,
          title: "Prioritized issue",
          body: null,
          url: "https://github.com/acme/platform/issues/1",
          createdAt: "2026-03-14T00:00:00.000Z",
          updatedAt: "2026-03-14T00:00:00.000Z",
          labels: { nodes: [] },
          assignees: { nodes: [] },
          repository: {
            name: "platform",
            url: "https://github.com/acme/platform",
            owner: { login: "acme" },
          },
          blockedBy: {
            nodes: [],
          },
        },
      },
      DEFAULT_WORKFLOW_LIFECYCLE,
      {
        fieldName: "Priority",
        optionIds: {
          "priority-p0": 0,
        },
      }
    );

    expect(issue?.priority).toBeNull();
  });

  it("returns an adapter for github-project", () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
    });

    expect(adapter).toBeDefined();
    expect(adapter.listIssues).toBeTypeOf("function");
    expect(adapter.listIssuesByStates).toBeTypeOf("function");
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
          projectId: "workspace-1",
          slug: "workspace-1",
          workspaceDir: "/tmp/workspace-1",
          repositories: [],
          tracker: {
            adapter: "github-project",
            bindingId: "project-123",
            settings: {
              projectId: "project-123",
            },
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
          assignedOnly: true,
        },
      });

      const issues = await adapter.listIssues(
        {
          projectId: "workspace-1",
          slug: "workspace-1",
          workspaceDir: "/tmp/workspace-1",
          repositories: [],
          tracker: {
            adapter: "github-project",
            bindingId: "project-123",
            settings: {
              projectId: "project-123",
              assignedOnly: true,
            },
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
                    fields: {
                      nodes: [],
                    },
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

  it("applies the default network timeout to GitHub API requests", async () => {
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeoutSignal);

    try {
      const adapter = resolveTrackerAdapter({
        adapter: "github-project",
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
        },
      });

      await adapter.listIssues(
        {
          projectId: "workspace-1",
          slug: "workspace-1",
          workspaceDir: "/tmp/workspace-1",
          repositories: [],
          tracker: {
            adapter: "github-project",
            bindingId: "project-123",
            settings: {
              projectId: "project-123",
            },
          },
        },
        {
          token: "dependencies-token",
          fetchImpl: async (_url, init) => {
            expect(timeoutSignal.aborted).toBe(false);
            expect(init?.signal).toBe(timeoutSignal);

            return new Response(
              JSON.stringify({
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
              {
                status: 200,
                headers: { "content-type": "application/json" },
              }
            );
          },
        }
      );

      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("uses the configured timeout for both REST and GraphQL tracker requests", async () => {
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeoutSignal);

    try {
      const adapter = resolveTrackerAdapter({
        adapter: "github-project",
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
          assignedOnly: true,
          timeoutMs: 1_500,
        },
      });

      await adapter.listIssues(
        {
          projectId: "workspace-1",
          slug: "workspace-1",
          workspaceDir: "/tmp/workspace-1",
          repositories: [],
          tracker: {
            adapter: "github-project",
            bindingId: "project-123",
            settings: {
              projectId: "project-123",
              assignedOnly: true,
              timeoutMs: 1_500,
            },
          },
        },
        {
          token: "dependencies-token",
          fetchImpl: async (url, init) => {
            expect(timeoutSignal.aborted).toBe(false);
            expect(init?.signal).toBe(timeoutSignal);

            if (String(url).endsWith("/user")) {
              return new Response(JSON.stringify({ login: "machine-user" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }

            return new Response(
              JSON.stringify({
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
              {
                status: 200,
                headers: { "content-type": "application/json" },
              }
            );
          },
        }
      );

      expect(timeoutSpy).toHaveBeenCalledWith(1_500);
      expect(timeoutSpy).toHaveBeenCalledTimes(2);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("accepts a positive integer timeout from string-based tracker settings", async () => {
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeoutSignal);

    try {
      const adapter = resolveTrackerAdapter({
        adapter: "github-project",
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
          timeoutMs: "2500",
        },
      });

      await adapter.listIssues(
        {
          projectId: "workspace-1",
          slug: "workspace-1",
          workspaceDir: "/tmp/workspace-1",
          repositories: [],
          tracker: {
            adapter: "github-project",
            bindingId: "project-123",
            settings: {
              projectId: "project-123",
              timeoutMs: "2500",
            },
          },
        },
        {
          token: "dependencies-token",
          fetchImpl: async (_url, init) => {
            expect(timeoutSignal.aborted).toBe(false);
            expect(init?.signal).toBe(timeoutSignal);

            return new Response(
              JSON.stringify({
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
              {
                status: 200,
                headers: { "content-type": "application/json" },
              }
            );
          },
        }
      );

      expect(timeoutSpy).toHaveBeenCalledWith(2500);
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("rejects non-positive timeout settings", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
        timeoutMs: 0,
      },
    });

    await expect(
      adapter.listIssues(
        {
          projectId: "workspace-1",
          slug: "workspace-1",
          workspaceDir: "/tmp/workspace-1",
          repositories: [],
          tracker: {
            adapter: "github-project",
            bindingId: "project-123",
            settings: {
              projectId: "project-123",
              timeoutMs: 0,
            },
          },
        },
        {
          token: "dependencies-token",
        }
      )
    ).rejects.toThrow(
      'Tracker adapter "github-project" requires the "timeoutMs" setting to be a positive integer when provided.'
    );
  });

  it("maps priority from the configured project field during issue listing", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
        priorityFieldName: "Priority",
      },
    });

    const issues = await adapter.listIssues(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repositories: [],
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          settings: {
            projectId: "project-123",
            priorityFieldName: "Priority",
          },
        },
      },
      {
        token: "dependencies-token",
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { query: string };

          if (body.query.includes("query ProjectFields")) {
            expect(body.query).toContain("fields(first: 100)");
            return new Response(
              JSON.stringify({
                data: {
                  node: {
                    __typename: "ProjectV2",
                    fields: {
                      nodes: [
                        {
                          __typename: "ProjectV2SingleSelectField",
                          name: "Priority",
                          options: [
                            { id: "priority-p0", name: "P0" },
                            { id: "priority-p1", name: "P1" },
                            { id: "priority-p2", name: "P2" },
                          ],
                        },
                      ],
                    },
                  },
                },
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              }
            );
          }

          expect(body.query).not.toContain("fields(");

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
                        title: "Prioritized issue",
                        assignees: [],
                        priorityOptionId: "priority-p1",
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
    expect(issues[0]?.priority).toBe(1);
  });

  it("maps priority using only non-null option entries and fetches field metadata once", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
        priorityFieldName: "Priority",
      },
    });

    let fieldQueryCount = 0;
    let itemsQueryCount = 0;

    const issues = await adapter.listIssues(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repositories: [],
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          settings: {
            projectId: "project-123",
            priorityFieldName: "Priority",
          },
        },
      },
      {
        token: "dependencies-token",
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { query: string };

          if (body.query.includes("query ProjectFields")) {
            fieldQueryCount += 1;
            return new Response(
              JSON.stringify({
                data: {
                  node: {
                    __typename: "ProjectV2",
                    fields: {
                      nodes: [
                        {
                          __typename: "ProjectV2SingleSelectField",
                          name: "Priority",
                          options: [
                            null,
                            { id: "priority-p0", name: "P0" },
                            { id: "priority-p1", name: "P1" },
                          ],
                        },
                      ],
                    },
                  },
                },
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              }
            );
          }

          itemsQueryCount += 1;
          expect(body.query).not.toContain("fields(");

          if (itemsQueryCount === 1) {
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
                          title: "First prioritized issue",
                          assignees: [],
                          priorityOptionId: "priority-p0",
                        }),
                      ],
                      pageInfo: { endCursor: "cursor-2", hasNextPage: true },
                    },
                  },
                },
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              }
            );
          }

          return new Response(
            JSON.stringify({
              data: {
                node: {
                  __typename: "ProjectV2",
                  items: {
                    nodes: [
                      makeProjectItem({
                        itemId: "item-2",
                        issueId: "issue-2",
                        number: 2,
                        title: "Second prioritized issue",
                        assignees: [],
                        priorityOptionId: "priority-p1",
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

    expect(fieldQueryCount).toBe(1);
    expect(itemsQueryCount).toBe(2);
    expect(issues.map((issue) => issue.priority)).toEqual([0, 1]);
  });

  it("resolves the REST user endpoint from a graphql URL with a trailing slash", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      apiUrl: "https://api.github.com/graphql/",
      settings: {
        projectId: "project-123",
        assignedOnly: true,
      },
    });

    await adapter.listIssues(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repositories: [],
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          apiUrl: "https://api.github.com/graphql/",
          settings: {
            projectId: "project-123",
            assignedOnly: true,
          },
        },
      },
      {
        token: "dependencies-token",
        fetchImpl: async (url, init) => {
          if (init?.method === "GET") {
            expect(String(url)).toBe("https://api.github.com/user");
            return new Response(JSON.stringify({ login: "machine-user" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }

          return new Response(
            JSON.stringify({
              data: {
                node: {
                  __typename: "ProjectV2",
                  fields: {
                    nodes: [],
                  },
                  items: {
                    nodes: [],
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
  });

  it("filters issues to the requested workflow states", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const issues = await adapter.listIssuesByStates(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repositories: [],
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          settings: {
            projectId: "project-123",
          },
        },
      },
      ["Done"],
      {
        token: "dependencies-token",
        fetchImpl: async (_url, _init) =>
          new Response(
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
                        title: "Done issue",
                        assignees: [],
                        state: "Done",
                      }),
                      makeProjectItem({
                        itemId: "item-2",
                        issueId: "issue-2",
                        number: 2,
                        title: "Todo issue",
                        assignees: [],
                        state: "Todo",
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
          ),
      }
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.identifier).toBe("acme/platform#1");
    expect(issues[0]?.state).toBe("Done");
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
  state?: string;
  priorityOptionId?: string;
}) {
  return {
    id: input.itemId,
    updatedAt: "2026-03-14T00:00:00.000Z",
    fieldValues: {
      nodes: [
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue" as const,
          name: input.state ?? "Todo",
          field: { name: "Status" },
        },
        ...(input.priorityOptionId
          ? [
              {
                __typename: "ProjectV2ItemFieldSingleSelectValue" as const,
                name: "P1",
                optionId: input.priorityOptionId,
                field: { name: "Priority" },
              },
            ]
          : []),
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
