import { describe, expect, it, vi } from "vitest";
import type { OrchestratorProjectConfig } from "@gh-symphony/core";
import { linearTrackerAdapter, normalizeLinearIssue } from "./index.js";

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

describe("linearTrackerAdapter", () => {
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
                  relations: {
                    nodes: [
                      {
                        type: "blocks",
                        relatedIssue: {
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
                  relations: { nodes: [] },
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

  it("adds an assignee isMe filter when runtime assignedOnly is enabled", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
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
        assignee: { isMe: { eq: true } },
      });
    } finally {
      infoSpy.mockRestore();
    }
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

  it('falls back to legacy string assignedOnly tracker setting with a deprecation warning', async () => {
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
        assignee: { isMe: { eq: true } },
      });
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"tracker-assigned-only-filtered"')
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Deprecated tracker.settings.assignedOnly")
      );
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("emits assignedOnly observability when the Linear filter is active", async () => {
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
                  relations: { nodes: [] },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
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
        expect.stringContaining('"event":"tracker-assigned-only-filtered"')
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"tracker":"linear"')
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"includedCount":1')
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
                  relations: { nodes: [] },
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

    await linearTrackerAdapter.fetchIssueStatesByIds(makeProject(), ["ENG-123"], {
      fetchImpl,
      token: "linear-token",
    });

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
});
