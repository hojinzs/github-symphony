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

    expect(firstRequest.query).toContain(
      "project: { slugId: { eq: $projectSlug } }"
    );
    expect(firstRequest.query).toContain(
      "state: { name: { in: $stateNames } }"
    );
    expect(firstRequest.variables).toMatchObject({
      projectSlug: "symphony-0c79b11b75ea",
      stateNames: ["Todo", "In Progress"],
      first: 50,
      after: null,
    });
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
    expect(request.variables.stateNames).toEqual(["Rework"]);
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
    expect(request.variables.issueIds).toEqual(["issue-1", "issue-2"]);
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
      "identifier: { in: $issueIdentifiers }"
    );
    expect(request.variables.issueIdentifiers).toEqual(["ENG-123"]);
    expect(request.variables).not.toHaveProperty("issueIds");
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
