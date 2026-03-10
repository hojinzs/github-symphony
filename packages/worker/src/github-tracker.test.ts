import { describe, expect, it, vi } from "vitest";
import {
  fetchActionableIssues,
  GitHubTrackerHttpError,
  GitHubTrackerQueryError,
  isActionableState,
  isTrackedIssueActionable,
  normalizeProjectItem,
  normalizeStateName
} from "./github-tracker.js";
import { DEFAULT_WORKFLOW_LIFECYCLE } from "./workflow-lifecycle.js";

describe("normalizeStateName", () => {
  it("normalizes state values for comparisons", () => {
    expect(normalizeStateName(" In Progress ")).toBe("in progress");
  });
});

describe("isActionableState", () => {
  it("matches configured active states case-insensitively", () => {
    expect(isActionableState("Todo", ["todo", "in progress"])).toBe(true);
    expect(isActionableState("Done", ["todo", "in progress"])).toBe(false);
  });
});

describe("normalizeProjectItem", () => {
  it("maps a GitHub project issue into the worker issue model", () => {
    const issue = normalizeProjectItem("project-123", {
      id: "item-1",
      updatedAt: "2026-03-07T10:00:00.000Z",
      fieldValues: {
        nodes: [
          {
            __typename: "ProjectV2ItemFieldSingleSelectValue",
            name: "Todo",
            field: { name: "Status" }
          },
          {
            __typename: "ProjectV2ItemFieldTextValue",
            text: "repo context",
            field: { name: "Repository Context" }
          }
        ]
      },
      content: {
        __typename: "Issue",
        id: "issue-1",
        number: 42,
        title: "Implement tracker adapter",
        body: "Read GitHub project state",
        url: "https://github.com/acme/platform/issues/42",
        createdAt: "2026-03-07T09:00:00.000Z",
        updatedAt: "2026-03-07T10:00:00.000Z",
        labels: {
          nodes: [{ name: "Agent" }, { name: "Infra" }]
        },
        repository: {
          name: "platform",
          url: "https://github.com/acme/platform",
          owner: {
            login: "acme"
          }
        }
      }
    });

    expect(issue).toEqual({
      id: "issue-1",
      identifier: "acme/platform#42",
      number: 42,
      title: "Implement tracker adapter",
      description: "Read GitHub project state",
      priority: null,
      state: "Todo",
      branchName: null,
      url: "https://github.com/acme/platform/issues/42",
      labels: ["agent", "infra"],
      blockedBy: [],
      createdAt: "2026-03-07T09:00:00.000Z",
      updatedAt: "2026-03-07T10:00:00.000Z",
      repository: {
        owner: "acme",
        name: "platform",
        url: "https://github.com/acme/platform",
        cloneUrl: "https://github.com/acme/platform.git"
      },
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        itemId: "item-1"
      },
      metadata: {
        Status: "Todo",
        "Repository Context": "repo context"
      },
      phase: "planning"
    });
  });
});

describe("isTrackedIssueActionable", () => {
  it("treats workflow handoff states as non-actionable", () => {
    expect(
      isTrackedIssueActionable(
        {
          state: "Plan Review",
          phase: "human-review"
        } as never,
        {
          lifecycle: DEFAULT_WORKFLOW_LIFECYCLE
        }
      )
    ).toBe(false);

    expect(
      isTrackedIssueActionable(
        {
          state: "In Progress",
          phase: "implementation"
        } as never,
        {
          lifecycle: DEFAULT_WORKFLOW_LIFECYCLE
        }
      )
    ).toBe(true);
  });
});

describe("fetchActionableIssues", () => {
  it("loads and filters actionable issues across pages", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            node: {
              __typename: "ProjectV2",
              items: {
                nodes: [
                  {
                    id: "item-1",
                    updatedAt: "2026-03-07T10:00:00.000Z",
                    fieldValues: {
                      nodes: [
                        {
                          __typename: "ProjectV2ItemFieldSingleSelectValue",
                          name: "Todo",
                          field: { name: "Status" }
                        }
                      ]
                    },
                    content: {
                      __typename: "Issue",
                      id: "issue-1",
                      number: 1,
                      title: "Actionable",
                      body: null,
                      url: "https://github.com/acme/platform/issues/1",
                      createdAt: "2026-03-07T09:00:00.000Z",
                      updatedAt: "2026-03-07T10:00:00.000Z",
                      labels: { nodes: [] },
                      repository: {
                        name: "platform",
                        url: "https://github.com/acme/platform",
                        owner: { login: "acme" }
                      }
                    }
                  }
                ],
                pageInfo: {
                  endCursor: "cursor-1",
                  hasNextPage: true
                }
              }
            }
          }
        }),
        text: async () => ""
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            node: {
              __typename: "ProjectV2",
              items: {
                nodes: [
                  {
                    id: "item-2",
                    updatedAt: "2026-03-07T10:05:00.000Z",
                    fieldValues: {
                      nodes: [
                        {
                          __typename: "ProjectV2ItemFieldSingleSelectValue",
                          name: "Done",
                          field: { name: "Status" }
                        }
                      ]
                    },
                    content: {
                      __typename: "Issue",
                      id: "issue-2",
                      number: 2,
                      title: "Terminal",
                      body: null,
                      url: "https://github.com/acme/platform/issues/2",
                      createdAt: "2026-03-07T09:30:00.000Z",
                      updatedAt: "2026-03-07T10:05:00.000Z",
                      labels: { nodes: [] },
                      repository: {
                        name: "platform",
                        url: "https://github.com/acme/platform",
                        owner: { login: "acme" }
                      }
                    }
                  }
                ],
                pageInfo: {
                  endCursor: null,
                  hasNextPage: false
                }
              }
            }
          }
        }),
        text: async () => ""
      });

    const issues = await fetchActionableIssues(
      {
        projectId: "project-123",
        token: "secret",
        lifecycle: DEFAULT_WORKFLOW_LIFECYCLE
      },
      fetchImpl as typeof fetch
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.identifier).toBe("acme/platform#1");
  });

  it("surfaces HTTP failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "bad gateway"
    });

    await expect(
      fetchActionableIssues(
        {
          projectId: "project-123",
          token: "secret",
          activeStates: ["todo"]
        },
        fetchImpl as typeof fetch
      )
    ).rejects.toBeInstanceOf(GitHubTrackerHttpError);
  });

  it("surfaces GraphQL errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        errors: [{ message: "Something broke" }]
      }),
      text: async () => ""
    });

    await expect(
      fetchActionableIssues(
        {
          projectId: "project-123",
          token: "secret",
          activeStates: ["todo"]
        },
        fetchImpl as typeof fetch
      )
    ).rejects.toBeInstanceOf(GitHubTrackerQueryError);
  });
});
