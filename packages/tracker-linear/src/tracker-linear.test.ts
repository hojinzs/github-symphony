import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseWorkflowMarkdown,
  type OrchestratorProjectConfig,
} from "@gh-symphony/core";
import { linearTrackerAdapter, normalizeLinearIssue } from "./index.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const repository = {
  owner: "acme",
  name: "platform",
  cloneUrl: "https://github.com/acme/platform.git",
  path: "/workspace/platform",
};

function makeProject(
  overrides: Partial<OrchestratorProjectConfig["tracker"]> = {}
): OrchestratorProjectConfig {
  return {
    projectId: "repository",
    slug: "platform",
    workspaceDir: "/workspace/platform",
    repository,
    tracker: {
      adapter: "linear",
      bindingId: "symphony-0c79b11b75ea",
      apiUrl: "https://linear.test/graphql",
      settings: {
        projectSlug: "symphony-0c79b11b75ea",
        activeStates: "Todo\nIn Progress",
        ...overrides.settings,
      },
      ...overrides,
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonResponseWithHeaders(
  body: unknown,
  headers: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function linearIssueNode(
  identifier: string,
  labels: string[],
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const number = Number.parseInt(identifier.split("-").at(-1) ?? "0", 10);
  return {
    id: `issue-${identifier.toLowerCase()}`,
    identifier,
    number,
    title: `${identifier} title`,
    priority: null,
    state: { name: "Todo" },
    labels: { nodes: labels.map((name) => ({ name })) },
    inverseRelations: { nodes: [] },
    ...overrides,
  };
}

describe("linearTrackerAdapter", () => {
  it("advertises and executes its host-side tool with normalized issue context", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { issueUpdate: { success: true } } })
      );
    vi.stubGlobal("fetch", fetchImpl);
    const context = {
      issue: {
        id: "issue-1",
        identifier: "ENG-123",
        nativeRef: { itemId: "issue-1" },
      },
      environment: { LINEAR_API_KEY: "linear-token" },
    };

    expect(linearTrackerAdapter.agentToolSpecs?.()).toEqual([
      expect.objectContaining({ name: "linear_graphql" }),
    ]);
    await expect(
      linearTrackerAdapter.executeAgentTool?.(
        "linear_graphql",
        {
          query:
            "mutation UpdateIssue($id: String!) { issueUpdate(id: $id) { success } }",
          variables: { id: "issue-1" },
        },
        context
      )
    ).resolves.toEqual({ data: { issueUpdate: { success: true } } });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "linear-token" }),
      })
    );
  });

  it("rejects a tool not owned by the Linear adapter", async () => {
    await expect(
      linearTrackerAdapter.executeAgentTool?.(
        "github_graphql",
        {},
        { issue: { id: "issue-1", identifier: "ENG-123", nativeRef: null } }
      )
    ).rejects.toThrow("Unknown Linear agent tool");
  });

  it("normalizes labels and timestamps and maps priority zero to null", () => {
    const issue = normalizeLinearIssue(
      makeProject(),
      "project-slug",
      linearIssueNode("ENG-1", [" Ready ", "READY", "", "Bug"], {
        priority: 0,
        createdAt: "not-a-timestamp",
        updatedAt: "2026-05-01t01:02:03+09:00",
      })
    );

    expect(issue).toMatchObject({
      priority: null,
      labels: ["ready", "bug"],
      createdAt: null,
      updatedAt: "2026-04-30T16:02:03.000Z",
    });
  });

  it("accepts valid provider-owned Linear keys", () => {
    expect(
      linearTrackerAdapter.validateProviderConfig?.({
        endpoint: "https://linear.test/graphql",
        api_key: "$LINEAR_API_KEY",
        project_slug: "platform",
        pickup_labels: { include: ["agent"] },
      })
    ).toEqual([]);
  });

  it("documents Linear lifecycle defaults", () => {
    expect(linearTrackerAdapter.defaultLifecycle?.()).toEqual({
      stateFieldName: "Status",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done"],
      blockerCheckStates: ["Todo"],
      planningStates: [],
    });
  });

  it("validates malformed provider keys without coupling to error order", () => {
    const paths = new Set(
      linearTrackerAdapter
        .validateProviderConfig?.({
          api_key: "lin_secret",
          project_id: "legacy-project",
          teamId: "legacy-team",
          team_id: "legacy-team",
          pickup_labels: { include: "agent", exclude: [1] },
        })
        .map((error) => error.path)
    );
    expect(paths).toEqual(
      new Set([
        "tracker.provider.project_slug",
        "tracker.provider.api_key",
        "tracker.provider.project_id",
        "tracker.provider.teamId",
        "tracker.provider.team_id",
        "tracker.provider.pickup_labels.include",
        "tracker.provider.pickup_labels.exclude",
      ])
    );
  });

  it("permits ambient LINEAR_API_KEY authentication", () => {
    expect(
      linearTrackerAdapter.validateProviderConfig?.({
        project_slug: "platform",
      })
    ).toEqual([]);
  });

  it("validates the raw API-key reference after provider resolution", () => {
    expect(() =>
      parseWorkflowMarkdown(
        `---
tracker:
  kind: linear
  provider:
    project_slug: platform
    endpoint: $LINEAR_ENDPOINT
    api_key: $LINEAR_API_KEY
codex:
  command: codex
---
Prompt`,
        {
          LINEAR_ENDPOINT: "https://linear.test/graphql",
          LINEAR_API_KEY: "lin_secret",
        },
        { trackerAdapter: linearTrackerAdapter }
      )
    ).not.toThrow();
  });

  it("queries Linear by project slug and state names with cursor pagination", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: "issue-1",
                  identifier: "ENG-1",
                  number: 1,
                  title: "First issue",
                  description: "Description",
                  priority: 2,
                  url: "https://linear.app/acme/issue/ENG-1",
                  createdAt: "2026-05-01T00:00:00.000Z",
                  updatedAt: "2026-05-02T00:00:00.000Z",
                  state: { name: "Todo" },
                  labels: { nodes: [{ name: "tracker" }] },
                  inverseRelations: {
                    nodes: [
                      {
                        type: "blocks",
                        issue: {
                          id: "issue-0",
                          identifier: "ENG-0",
                          state: { name: "Done" },
                        },
                      },
                    ],
                  },
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            },
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: "issue-2",
                  identifier: "OPS-20",
                  number: 20,
                  title: "Second issue",
                  priority: 4,
                  state: { name: "In Progress" },
                  labels: { nodes: [] },
                  inverseRelations: { nodes: [] },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        })
      );

    const issues = await linearTrackerAdapter.listIssues(makeProject(), {
      fetchImpl,
      token: "linear-token",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstRequest = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body)
    ) as { query: string; variables: Record<string, unknown> };
    const secondRequest = JSON.parse(
      String(fetchImpl.mock.calls[1]?.[1]?.body)
    ) as { variables: Record<string, unknown> };

    expect(firstRequest.query).toContain("$filter: IssueFilter!");
    expect(firstRequest.query).toContain("filter: $filter");
    expect(firstRequest.query).toContain("inverseRelations {");
    expect(firstRequest.query).toContain("issue {");
    expect(firstRequest.query).not.toMatch(/\n\s+relations \{/);
    expect(firstRequest.variables).toMatchObject({
      filter: {
        project: { slugId: { eq: "symphony-0c79b11b75ea" } },
        state: { name: { in: ["Todo", "In Progress"] } },
      },
      first: 50,
      after: null,
    });
    expect(firstRequest.variables.filter).not.toHaveProperty("assignee");
    expect(secondRequest.variables.after).toBe("cursor-1");
    expect(issues).toMatchObject([
      {
        id: "issue-1",
        identifier: "ENG-1",
        number: 1,
        title: "First issue",
        priority: 2,
        state: "Todo",
        url: "https://linear.app/acme/issue/ENG-1",
        labels: ["tracker"],
        blockedBy: [{ id: "issue-0", identifier: "ENG-0", state: "Done" }],
        repository,
        tracker: {
          adapter: "linear",
          bindingId: "symphony-0c79b11b75ea",
          itemId: "issue-1",
        },
      },
      {
        id: "issue-2",
        identifier: "OPS-20",
        number: 20,
        state: "In Progress",
        repository,
      },
    ]);
  });

  it("fails rather than truncating when pagination reaches maxPages", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          issues: {
            nodes: [linearIssueNode("ENG-1", [])],
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          },
        },
      })
    );

    await expect(
      linearTrackerAdapter.listIssues(
        makeProject({
          settings: {
            projectSlug: "symphony-0c79b11b75ea",
            activeStates: "Todo",
            maxPages: 1,
            pageTimeoutMs: 1_000,
          },
        }),
        { fetchImpl, token: "linear-token" }
      )
    ).rejects.toMatchObject({
      message:
        "tracker_pagination: maximum page limit (1) reached before pagination completed",
      category: "tracker_pagination",
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails and emits a structured event when Linear pagination loses its cursor", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: null },
          },
        },
      })
    );

    await expect(
      linearTrackerAdapter.listIssues(makeProject(), {
        fetchImpl,
        token: "linear-token",
      })
    ).rejects.toMatchObject({ category: "tracker_pagination" });
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      event: "tracker-pagination-integrity-failure",
      adapter: "linear",
    });
  });

  it("keeps the per-page timeout active while reading the response body", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("Expected an abort signal");
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () =>
            new Promise<never>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            }),
        } as unknown as Response;
      }
    );

    await expect(
      linearTrackerAdapter.listIssues(
        makeProject({
          settings: {
            projectSlug: "symphony-0c79b11b75ea",
            activeStates: "Todo",
            pageTimeoutMs: 1,
          },
        }),
        { fetchImpl, token: "linear-token" }
      )
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("listIssuesByStates queries Linear directly without using projectItemsCache", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
    );
    const projectItemsCache = {
      getOrLoad: vi.fn(),
    };

    await linearTrackerAdapter.listIssuesByStates(makeProject(), ["Rework"], {
      fetchImpl,
      token: "linear-token",
      projectItemsCache,
    });

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      variables: Record<string, unknown>;
    };
    expect(projectItemsCache.getOrLoad).not.toHaveBeenCalled();
    expect(request.variables.filter).toMatchObject({
      project: { slugId: { eq: "symphony-0c79b11b75ea" } },
      state: { name: { in: ["Rework"] } },
    });
  });

  it("returns only viewer-assigned issues as dispatchable when runtime assignedOnly is enabled", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                linearIssueNode("ENG-1", [], { assignee: { id: "user-1" } }),
                linearIssueNode("ENG-2", []),
                linearIssueNode("ENG-3", [], { assignee: { id: "user-2" } }),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            viewer: { id: "user-1" },
          },
        })
      );

      await linearTrackerAdapter.listIssues(makeProject(), {
        assignedOnly: true,
        fetchImpl,
        token: "linear-token",
      });

      const request = JSON.parse(
        String(fetchImpl.mock.calls[0]?.[1]?.body)
      ) as {
        variables: Record<string, unknown>;
      };
      expect(request.variables.filter).toMatchObject({
        project: { slugId: { eq: "symphony-0c79b11b75ea" } },
        state: { name: { in: ["Todo", "In Progress"] } },
      });
      expect(request.variables.filter).not.toHaveProperty("assignee");
      expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).toContain("viewer");
      const issues = await linearTrackerAdapter.listIssues(makeProject(), {
        assignedOnly: true,
        fetchImpl: vi.fn().mockResolvedValue(
          jsonResponse({
            data: {
              issues: {
                nodes: [
                  linearIssueNode("ENG-1", [], { assignee: { id: "user-1" } }),
                  linearIssueNode("ENG-2", []),
                  linearIssueNode("ENG-3", [], { assignee: { id: "user-2" } }),
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
              viewer: { id: "user-1" },
            },
          })
        ),
        token: "linear-token",
      });
      expect(issues).toMatchObject([
        { identifier: "ENG-1", assigneeId: "user-1", dispatchable: true },
        { identifier: "ENG-2", assigneeId: null, dispatchable: false },
        { identifier: "ENG-3", assigneeId: "user-2", dispatchable: false },
      ]);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("derives blocker dispatchability from Linear relations", async () => {
    const issues = await linearTrackerAdapter.listIssues(
      makeProject({
        settings: {
          projectSlug: "symphony-0c79b11b75ea",
          activeStates: "Todo",
          terminalStates: "Done",
          blockerCheckStates: "Todo",
        },
      }),
      {
        token: "linear-token",
        fetchImpl: vi.fn().mockResolvedValue(
          jsonResponse({
            data: {
              issues: {
                nodes: [
                  linearIssueNode("ENG-1", [], {
                    inverseRelations: {
                      nodes: [
                        {
                          type: "blocks",
                          issue: {
                            id: "issue-2",
                            identifier: "ENG-2",
                            state: { name: "In Progress" },
                          },
                        },
                      ],
                    },
                  }),
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          })
        ),
      }
    );

    expect(issues[0]).toMatchObject({
      dispatchable: false,
      dispatchReason: "Blocked by unresolved Linear issue: ENG-2.",
      blockedBy: [{ state: "In Progress" }],
    });
  });

  it("uses runtime assignedOnly before legacy tracker settings", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
    );

    await linearTrackerAdapter.listIssues(
      makeProject({
        settings: {
          projectSlug: "symphony-0c79b11b75ea",
          activeStates: "Todo",
          assignedOnly: true,
        },
      }),
      {
        assignedOnly: false,
        fetchImpl,
        token: "linear-token",
      }
    );

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      variables: Record<string, unknown>;
    };
    expect(request.variables.filter).not.toHaveProperty("assignee");
  });

  it("falls back to legacy string assignedOnly tracker setting with a deprecation warning", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issues: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            viewer: { id: "user-1" },
          },
        })
      );

      await linearTrackerAdapter.listIssues(
        makeProject({
          bindingId: "symphony-legacy-string",
          settings: {
            projectSlug: "symphony-0c79b11b75ea",
            activeStates: "Todo",
            assignedOnly: "true",
          },
        }),
        {
          fetchImpl,
          token: "linear-token",
        }
      );

      const request = JSON.parse(
        String(fetchImpl.mock.calls[0]?.[1]?.body)
      ) as {
        variables: Record<string, unknown>;
      };
      expect(request.variables.filter).toMatchObject({
        project: { slugId: { eq: "symphony-0c79b11b75ea" } },
        state: { name: { in: ["Todo"] } },
      });
      expect(request.variables.filter).not.toHaveProperty("assignee");
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"tracker-dispatchable-derived"')
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Deprecated tracker.settings.assignedOnly")
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("gh-symphony project start --assigned-only")
      );
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("fails closed when assignedOnly cannot resolve the Linear viewer", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          issues: {
            nodes: [
              linearIssueNode("ENG-1", [], { assignee: { id: null } }),
              linearIssueNode("ENG-2", [], { assignee: { id: "user-1" } }),
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
    );

    await expect(
      linearTrackerAdapter.listIssues(makeProject(), {
        assignedOnly: true,
        fetchImpl,
        token: "linear-token",
      })
    ).rejects.toThrow(
      "Linear assignedOnly is enabled but the authenticated viewer id could not be resolved"
    );
  });

  it("emits dispatchability derivation observability", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: "issue-1",
                  identifier: "ENG-1",
                  number: 1,
                  title: "Assigned issue",
                  state: { name: "Todo" },
                  labels: { nodes: [] },
                  inverseRelations: { nodes: [] },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            viewer: { id: "user-1" },
          },
        })
      );

      const issues = await linearTrackerAdapter.listIssues(makeProject(), {
        assignedOnly: true,
        fetchImpl,
        token: "linear-token",
      });

      expect(issues).toHaveLength(1);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"tracker-dispatchable-derived"')
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"tracker":"linear"')
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"assignmentScope":"viewer"')
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"dispatchableCount":0')
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"nonDispatchableCount":1')
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("requires one configured include pickup label when include labels are set", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                linearIssueNode("ENG-1", ["agent"]),
                linearIssueNode("ENG-2", ["dev-ready"]),
                linearIssueNode("ENG-3", ["frontend"]),
                linearIssueNode("ENG-4", []),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        })
      );

      const issues = await linearTrackerAdapter.listIssues(
        makeProject({
          settings: {
            projectSlug: "symphony-0c79b11b75ea",
            activeStates: "Todo",
            pickupLabels: {
              include: ["agent", "dev-ready"],
            },
          },
        }),
        {
          fetchImpl,
          token: "linear-token",
        }
      );

      expect(issues.map((issue) => issue.identifier)).toEqual([
        "ENG-1",
        "ENG-2",
      ]);
      expect(infoSpy).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("applies pickup labels when refreshing issues by canonical ID", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          issues: {
            nodes: [linearIssueNode("ENG-1", ["agent"])],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
    );

    const issues = await linearTrackerAdapter.fetchIssueStatesByIds(
      makeProject({
        settings: {
          projectSlug: "symphony-0c79b11b75ea",
          activeStates: "Todo",
          pickupLabels: { include: ["dev-ready"] },
        },
      }),
      ["ENG-1"],
      { fetchImpl, token: "linear-token" }
    );

    expect(issues).toEqual([]);
  });

  it("skips issues with any configured exclude pickup label", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                linearIssueNode("ENG-1", ["frontend"]),
                linearIssueNode("ENG-2", ["no-agent"]),
                linearIssueNode("ENG-3", ["needs-spec"]),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        })
      );

      const issues = await linearTrackerAdapter.listIssues(
        makeProject({
          settings: {
            projectSlug: "symphony-0c79b11b75ea",
            activeStates: "Todo",
            pickupLabels: {
              exclude: ["no-agent", "needs-spec"],
            },
          },
        }),
        {
          fetchImpl,
          token: "linear-token",
        }
      );

      expect(issues.map((issue) => issue.identifier)).toEqual(["ENG-1"]);
      expect(infoSpy).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("lets exclude pickup labels win over include pickup labels", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                linearIssueNode("ENG-1", ["agent"]),
                linearIssueNode("ENG-2", ["dev-ready"]),
                linearIssueNode("ENG-3", ["agent", "no-agent"]),
                linearIssueNode("ENG-4", ["needs-spec"]),
                linearIssueNode("ENG-5", []),
                linearIssueNode("ENG-6", ["frontend"]),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        })
      );

      const issues = await linearTrackerAdapter.listIssues(
        makeProject({
          settings: {
            projectSlug: "symphony-0c79b11b75ea",
            activeStates: "Todo",
            pickupLabels: {
              include: ["agent", "dev-ready"],
              exclude: ["no-agent", "needs-spec"],
            },
          },
        }),
        {
          fetchImpl,
          token: "linear-token",
        }
      );

      expect(issues.map((issue) => issue.identifier)).toEqual([
        "ENG-1",
        "ENG-2",
      ]);
      expect(infoSpy).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("treats an empty include pickup label list as no include requirement", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                linearIssueNode("ENG-1", []),
                linearIssueNode("ENG-2", ["frontend"]),
                linearIssueNode("ENG-3", ["no-agent"]),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        })
      );

      const issues = await linearTrackerAdapter.listIssues(
        makeProject({
          settings: {
            projectSlug: "symphony-0c79b11b75ea",
            activeStates: "Todo",
            pickupLabels: {
              include: [],
              exclude: ["no-agent"],
            },
          },
        }),
        {
          fetchImpl,
          token: "linear-token",
        }
      );

      expect(issues.map((issue) => issue.identifier)).toEqual([
        "ENG-1",
        "ENG-2",
      ]);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("composes locally derived assignedOnly eligibility with pickup label filtering", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                linearIssueNode("ENG-1", ["agent"], {
                  assignee: { id: "user-1" },
                }),
                linearIssueNode("ENG-2", ["no-agent"], {
                  assignee: { id: "user-2" },
                }),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            viewer: { id: "user-1" },
          },
        })
      );

      const issues = await linearTrackerAdapter.listIssues(
        makeProject({
          settings: {
            projectSlug: "symphony-0c79b11b75ea",
            activeStates: "Todo",
            pickupLabels: {
              include: ["agent"],
              exclude: ["no-agent"],
            },
          },
        }),
        {
          assignedOnly: true,
          fetchImpl,
          token: "linear-token",
        }
      );

      const request = JSON.parse(
        String(fetchImpl.mock.calls[0]?.[1]?.body)
      ) as {
        variables: Record<string, unknown>;
      };
      expect(request.variables.filter).toMatchObject({
        project: { slugId: { eq: "symphony-0c79b11b75ea" } },
        state: { name: { in: ["Todo"] } },
      });
      expect(request.variables.filter).not.toHaveProperty("assignee");
      expect(issues.map((issue) => issue.identifier)).toEqual(["ENG-1"]);
      expect(issues[0]).toMatchObject({
        dispatchable: true,
        assigneeId: "user-1",
      });
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"tracker-dispatchable-derived"')
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("does not apply pickup label filtering to listIssuesByStates lifecycle lookups", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            issues: {
              nodes: [
                linearIssueNode("ENG-1", ["no-agent"], {
                  state: { name: "Done" },
                }),
                linearIssueNode("ENG-2", ["frontend"], {
                  state: { name: "Done" },
                }),
                linearIssueNode("ENG-3", ["agent"], {
                  state: { name: "Done" },
                }),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        })
      );

      const issues = await linearTrackerAdapter.listIssuesByStates(
        makeProject({
          settings: {
            projectSlug: "symphony-0c79b11b75ea",
            activeStates: "Todo",
            pickupLabels: {
              include: ["agent", "dev-ready"],
              exclude: ["no-agent", "needs-spec"],
            },
          },
        }),
        ["Done", "Canceled"],
        {
          fetchImpl,
          token: "linear-token",
        }
      );

      const request = JSON.parse(
        String(fetchImpl.mock.calls[0]?.[1]?.body)
      ) as {
        variables: Record<string, unknown>;
      };
      expect(request.variables.filter).toMatchObject({
        project: { slugId: { eq: "symphony-0c79b11b75ea" } },
        state: { name: { in: ["Done", "Canceled"] } },
      });
      expect(issues.map((issue) => issue.identifier)).toEqual([
        "ENG-1",
        "ENG-2",
        "ENG-3",
      ]);
      expect(infoSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('"event":"tracker-pickup-label-filtered"')
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("normalizes Linear rate-limit headers onto listed issues", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponseWithHeaders(
        {
          data: {
            issues: {
              nodes: [
                {
                  id: "issue-1",
                  identifier: "ENG-1",
                  number: 1,
                  title: "First issue",
                  state: { name: "Todo" },
                  labels: { nodes: [] },
                  inverseRelations: { nodes: [] },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
        {
          "x-ratelimit-requests-limit": "1500",
          "x-ratelimit-requests-remaining": "1498",
          "x-ratelimit-requests-reset": "1773892800",
        }
      )
    );

    const issues = await linearTrackerAdapter.listIssues(makeProject(), {
      fetchImpl,
      token: "linear-token",
    });

    expect(issues[0]?.rateLimits).toEqual({
      source: "linear",
      limit: 1500,
      remaining: 1498,
      used: 2,
      reset: 1773892800,
      resetAt: "2026-03-19T04:00:00.000Z",
      retryAfter: null,
      resource: "graphql",
    });
  });

  it("preserves Linear rate-limit headers when no issues are returned", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponseWithHeaders(
        {
          data: {
            issues: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
        {
          "x-ratelimit-requests-limit": "1500",
          "x-ratelimit-requests-remaining": "1497",
          "x-ratelimit-requests-reset": "1773892800",
        }
      )
    );

    const issues = await linearTrackerAdapter.listIssues(makeProject(), {
      fetchImpl,
      token: "linear-token",
    });

    expect(issues).toHaveLength(0);
    expect(issues.rateLimits).toEqual({
      source: "linear",
      limit: 1500,
      remaining: 1497,
      used: 3,
      reset: 1773892800,
      resetAt: "2026-03-19T04:00:00.000Z",
      retryAfter: null,
      resource: "graphql",
    });
  });

  it("surfaces Linear 429 retry metadata without leaking auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: "rate limited" }] }), {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "30",
          "x-ratelimit-requests-limit": "1500",
          "x-ratelimit-requests-remaining": "0",
        },
      })
    );

    await expect(
      linearTrackerAdapter.listIssues(makeProject(), {
        fetchImpl,
        token: "linear-token",
      })
    ).rejects.toThrow(
      "Linear GraphQL request failed with HTTP 429. Retry after 30 seconds."
    );
    await expect(
      linearTrackerAdapter.listIssues(makeProject(), {
        fetchImpl,
        token: "linear-token",
      })
    ).rejects.not.toThrow("linear-token");
  });

  it("requires active state names when polling Linear candidates", async () => {
    await expect(
      linearTrackerAdapter.listIssues(
        makeProject({
          settings: { projectSlug: "symphony-0c79b11b75ea", activeStates: "" },
        }),
        {
          fetchImpl: vi.fn(),
          token: "linear-token",
        }
      )
    ).rejects.toThrow(
      'Tracker adapter "linear" requires at least one active state name in the "activeStates" setting.'
    );
  });

  it("does not call Linear for empty state or ID lookups", async () => {
    const fetchImpl = vi.fn();

    await expect(
      linearTrackerAdapter.listIssuesByStates(makeProject(), [], {
        fetchImpl,
        token: "linear-token",
      })
    ).resolves.toEqual([]);
    await expect(
      linearTrackerAdapter.fetchIssueStatesByIds(makeProject(), [], {
        fetchImpl,
        token: "linear-token",
      })
    ).resolves.toEqual([]);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetchIssueStatesByIds filters by Linear ids", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
    );

    await linearTrackerAdapter.fetchIssueStatesByIds(
      makeProject(),
      ["issue-1", "issue-2"],
      { fetchImpl, token: "linear-token" }
    );

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      variables: Record<string, unknown>;
    };
    expect(request.variables.filter).toMatchObject({
      project: { slugId: { eq: "symphony-0c79b11b75ea" } },
      id: { in: ["issue-1", "issue-2"] },
    });
  });

  it("fetchIssueStatesByIds routes Linear identifiers through an identifier filter", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
    );

    await linearTrackerAdapter.fetchIssueStatesByIds(
      makeProject(),
      ["ENG-123"],
      {
        fetchImpl,
        token: "linear-token",
      }
    );

    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(request.query).toContain(
      "query SymphonyLinearIssueStatesByIdentifier"
    );
    expect(request.variables.filter).toMatchObject({
      project: { slugId: { eq: "symphony-0c79b11b75ea" } },
      identifier: { in: ["ENG-123"] },
    });
  });

  it("fails when a requested Linear issue has malformed required state data", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          issues: {
            nodes: [linearIssueNode("ENG-123", [], { state: null })],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      })
    );

    await expect(
      linearTrackerAdapter.fetchIssueStatesByIds(makeProject(), ["ENG-123"], {
        fetchImpl,
        token: "linear-token",
      })
    ).rejects.toThrow("Linear issue state name is required.");
  });

  it("injects worker environment without requiring team id", () => {
    const env = linearTrackerAdapter.buildWorkerEnvironment(
      makeProject({ apiUrl: undefined }),
      normalizeLinearIssue(makeProject(), "project-slug", {
        id: "issue-1",
        identifier: "eng-123",
        state: { name: "Todo" },
      })
    );

    expect(env).toEqual({
      LINEAR_GRAPHQL_URL: "https://api.linear.app/graphql",
      LINEAR_ISSUE_ID: "issue-1",
      LINEAR_ISSUE_IDENTIFIER: "ENG-123",
      SYMPHONY_TRACKER_KIND: "linear",
    });
    expect(env).not.toHaveProperty("LINEAR_TEAM_ID");
  });

  it("declares Linear credential environment names", () => {
    expect(linearTrackerAdapter.secretEnvironmentNames()).toEqual([
      "LINEAR_API_KEY",
      "LINEAR_AUTHORIZATION",
    ]);
  });

  it("derives assignedOnly eligibility through the normalizer options object", () => {
    const issue = normalizeLinearIssue(
      makeProject(),
      "project-slug",
      {
        id: "issue-1",
        identifier: "eng-123",
        state: { name: "Todo" },
        assignee: { id: "user-1" },
      },
      { assignedOnly: true, viewerId: "user-1" }
    );

    expect(issue).toMatchObject({ assigneeId: "user-1", dispatchable: true });
  });

  it("forwards normalized Linear credentials to the worker", () => {
    vi.stubEnv("LINEAR_AUTHORIZATION", " Bearer runtime-token ");
    vi.stubEnv("LINEAR_API_KEY", " lin_api_key ");

    const env = linearTrackerAdapter.buildWorkerEnvironment(
      makeProject(),
      normalizeLinearIssue(makeProject(), "project-slug", {
        id: "issue-1",
        identifier: "eng-123",
        state: { name: "Todo" },
      })
    );

    expect(env).toMatchObject({
      LINEAR_AUTHORIZATION: "Bearer runtime-token",
      LINEAR_API_KEY: "lin_api_key",
    });
  });

  it("defaults blank tracker apiUrl to the Linear GraphQL endpoint", () => {
    const env = linearTrackerAdapter.buildWorkerEnvironment(
      makeProject({ apiUrl: "   " }),
      normalizeLinearIssue(makeProject(), "project-slug", {
        id: "issue-1",
        identifier: "eng-123",
        state: { name: "Todo" },
      })
    );

    expect(env.LINEAR_GRAPHQL_URL).toBe("https://api.linear.app/graphql");
  });

  it("revives issues with repository routing from the orchestrator project", () => {
    const revived = linearTrackerAdapter.reviveIssue(makeProject(), {
      runId: "run-1",
      projectId: "repository",
      projectSlug: "platform",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "eng-123",
      issueState: "Todo",
      repository: {
        owner: "ignored",
        name: "ignored",
        cloneUrl: "https://example.test/ignored.git",
      },
      status: "running",
      attempt: 1,
      processId: null,
      port: null,
      workingDirectory: "/workspace",
      issueWorkspaceKey: "ENG-123",
      workspaceRuntimeDir: "/runtime",
      workflowPath: null,
      retryKind: null,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
    });

    expect(revived.identifier).toBe("ENG-123");
    expect(revived.number).toBe(123);
    expect(revived.repository).toBe(repository);
  });

  it("revives legacy issue identifiers without blocking recovery", () => {
    const revived = linearTrackerAdapter.reviveIssue(makeProject(), {
      runId: "run-1",
      projectId: "repository",
      projectSlug: "platform",
      issueId: "issue-1",
      issueSubjectId: "issue-1",
      issueIdentifier: "legacy identifier",
      issueState: "Todo",
      repository: {
        owner: "ignored",
        name: "ignored",
        cloneUrl: "https://example.test/ignored.git",
      },
      status: "running",
      attempt: 1,
      processId: null,
      port: null,
      workingDirectory: "/workspace",
      issueWorkspaceKey: "legacy identifier",
      workspaceRuntimeDir: "/runtime",
      workflowPath: null,
      retryKind: null,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-05-01T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      lastError: null,
      nextRetryAt: null,
    });

    expect(revived.identifier).toBe("legacy identifier");
    expect(revived.number).toBe(0);
    expect(revived.repository).toBe(repository);
  });

  it("rejects Linear identifiers that cannot be used as workspace keys", () => {
    expect(() =>
      normalizeLinearIssue(makeProject(), "project-slug", {
        id: "issue-1",
        identifier: "eng 123",
        state: { name: "Todo" },
      })
    ).toThrow(/must match \^\[A-Z\]\[A-Z0-9\]\*-/);
  });

  it("normalizes blockers from inverse blocks relations only", () => {
    const issue = normalizeLinearIssue(makeProject(), "project-slug", {
      id: "issue-2",
      identifier: "ENG-2",
      state: { name: "Todo" },
      relations: {
        nodes: [
          {
            type: "blocks",
            relatedIssue: {
              id: "issue-3",
              identifier: "ENG-3",
              state: { name: "In Progress" },
            },
          },
        ],
      },
      inverseRelations: {
        nodes: [
          {
            type: "blocks",
            issue: {
              id: "issue-1",
              identifier: "ENG-1",
              state: { name: "Todo" },
            },
          },
          {
            type: "related",
            issue: {
              id: "issue-4",
              identifier: "ENG-4",
              state: { name: "Todo" },
            },
          },
        ],
      },
    });

    expect(issue.blockedBy).toEqual([
      { id: "issue-1", identifier: "ENG-1", state: "Todo" },
    ]);
  });
});
