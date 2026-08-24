import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKFLOW_LIFECYCLE,
  type IssueCommentCache,
  type IssueCommentCacheEntry,
  type ProjectItemsCache,
  type TrackedIssue,
} from "@gh-symphony/core";
import {
  normalizeGithubProjectItem,
  resetGitHubRateLimitCacheForTests,
  resetPriorityOptionOrderCacheForTests,
} from "./adapter.js";
import {
  findGithubProjectIssue,
  resolveTrackerAdapter,
} from "./orchestrator-adapter.js";
import {
  validateWorkflowFieldMapping,
  detectDuplicatePlacements,
  detectTransferRebindRequired,
} from "./validation.js";
import { GitHubGraphQLRateLimitError } from "./github-rate-limit.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetGitHubRateLimitCacheForTests();
  resetPriorityOptionOrderCacheForTests();
});

describe("resolveTrackerAdapter", () => {
  it("normalizes archived project items to an explicit non-terminal state", () => {
    const projectItem = makeProjectItem({
      itemId: "item-archived",
      issueId: "issue-1",
      number: 1,
      title: "Archived issue",
      assignees: [],
      isArchived: true,
    });
    projectItem.fieldValues.nodes = [];

    const issue = normalizeGithubProjectItem(
      "project-123",
      projectItem,
      DEFAULT_WORKFLOW_LIFECYCLE
    );

    expect(issue?.state).toBe("Archived");
    expect(issue?.metadata).toMatchObject({
      isArchived: true,
    });
  });

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

  it("maps explicit project-field priority by field display value instead of option order", () => {
    const issue = normalizeGithubProjectItem(
      "project-123",
      makeProjectItem({
        itemId: "item-1",
        issueId: "issue-1",
        number: 1,
        title: "Explicit field priority",
        assignees: [],
        priorityName: "High",
        priorityOptionId: "priority-p2",
      }),
      DEFAULT_WORKFLOW_LIFECYCLE,
      {
        explicit: {
          source: "project-field",
          field: "Priority",
          values: {
            Low: 3,
            High: 1,
            Urgent: 0,
          },
        },
        legacy: {
          fieldName: "Priority",
          optionIds: {
            "priority-p2": 2,
          },
        },
      }
    );

    expect(issue?.priority).toBe(1);
  });

  it("maps explicit labels priority using exact configured label names", () => {
    const issue = normalizeGithubProjectItem(
      "project-123",
      makeProjectItem({
        itemId: "item-1",
        issueId: "issue-1",
        number: 1,
        title: "Label priority",
        assignees: [],
        labels: ["P1", "enhancement"],
      }),
      DEFAULT_WORKFLOW_LIFECYCLE,
      {
        explicit: {
          source: "labels",
          labels: {
            P0: 0,
            P1: 1,
          },
        },
      }
    );

    expect(issue?.priority).toBe(1);
  });

  it("chooses the lowest numeric priority when multiple configured labels match", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      const issue = normalizeGithubProjectItem(
        "project-123",
        makeProjectItem({
          itemId: "item-1",
          issueId: "issue-1",
          number: 1,
          title: "Conflicting labels",
          assignees: [],
          labels: ["P2", "P0"],
        }),
        DEFAULT_WORKFLOW_LIFECYCLE,
        {
          explicit: {
            source: "labels",
            labels: {
              P0: 0,
              P2: 2,
            },
          },
        }
      );

      expect(issue?.priority).toBe(0);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"priority.label_conflict_resolved"')
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"chosenValue":0')
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("keeps explicit priority null for unmapped project field values and emits an event", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      const issue = normalizeGithubProjectItem(
        "project-123",
        makeProjectItem({
          itemId: "item-1",
          issueId: "issue-1",
          number: 1,
          title: "Unmapped field priority",
          assignees: [],
          priorityName: "Medium",
          priorityOptionId: "priority-medium",
        }),
        DEFAULT_WORKFLOW_LIFECYCLE,
        {
          explicit: {
            source: "project-field",
            field: "Priority",
            values: {
              Urgent: 0,
              High: 1,
            },
          },
        }
      );

      expect(issue?.priority).toBeNull();
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"priority.unmapped"')
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"rawValues":["Medium"]')
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("keeps explicit priority null when disabled even if legacy priority_field is present", () => {
    const issue = normalizeGithubProjectItem(
      "project-123",
      makeProjectItem({
        itemId: "item-1",
        issueId: "issue-1",
        number: 1,
        title: "Disabled priority",
        assignees: [],
        priorityOptionId: "priority-p0",
      }),
      DEFAULT_WORKFLOW_LIFECYCLE,
      {
        explicit: { source: "disabled" },
        legacy: {
          fieldName: "Priority",
          optionIds: {
            "priority-p0": 0,
          },
        },
      }
    );

    expect(issue?.priority).toBeNull();
  });

  it("keeps existing Issue content normalization unchanged", () => {
    const issue = normalizeGithubProjectItem(
      "project-123",
      makeProjectItem({
        itemId: "item-1",
        issueId: "issue-1",
        number: 1,
        title: "Regression issue",
        assignees: [],
        state: "Ready",
      }),
      DEFAULT_WORKFLOW_LIFECYCLE
    );

    expect(issue).toMatchObject({
      id: "issue-1",
      identifier: "acme/platform#1",
      number: 1,
      title: "Regression issue",
      description: null,
      priority: null,
      state: "Ready",
      branchName: null,
      url: "https://github.com/acme/platform/issues/1",
      labels: [],
      blockedBy: [],
      createdAt: "2026-03-14T00:00:00.000Z",
      updatedAt: "2026-03-14T00:00:00.000Z",
      repository: {
        owner: "acme",
        name: "platform",
        url: "https://github.com/acme/platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        itemId: "item-1",
      },
    });
    expect(issue?.metadata).toEqual({ Status: "Ready" });
  });

  it("skips and emits an event when a Project item omits the configured state field", () => {
    const item = makeProjectItem({
      itemId: "item-missing-state",
      issueId: "issue-1",
      number: 1,
      title: "Missing state metadata",
      assignees: [],
    });
    item.fieldValues = { nodes: [] };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(
        normalizeGithubProjectItem(
          "project-123",
          item,
          DEFAULT_WORKFLOW_LIFECYCLE
        )
      ).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({
          event: "tracker-project-item-status-missing",
          projectId: "project-123",
          itemId: "item-missing-state",
          issueIdentifier: "acme/platform#1",
        })
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("continues listing other items when one Project item omits Status", async () => {
    const missing = makeProjectItem({
      itemId: "item-missing-state",
      issueId: "issue-missing-state",
      number: 1,
      title: "Missing state metadata",
      assignees: [],
    });
    missing.fieldValues = { nodes: [] };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const adapter = resolveTrackerAdapter({
        adapter: "github-project",
        bindingId: "project-123",
        settings: { projectId: "project-123" },
      });
      const issues = await adapter.listIssues(makeProjectConfig(), {
        token: "dependencies-token",
        fetchImpl: async () =>
          makeJsonResponse(
            makeProjectItemsPayload([
              missing,
              makeProjectItem({
                itemId: "item-ready",
                issueId: "issue-ready",
                number: 2,
                title: "Ready issue",
                assignees: [],
                state: "Ready",
              }),
            ])
          ),
      });

      expect(issues.map((issue) => issue.identifier)).toEqual([
        "acme/platform#2",
      ]);
      expect(issues.skippedItems).toEqual([
        {
          id: "item-missing-state",
          identifier: "acme/platform#1",
          reason: "missing Status",
        },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("fails loudly when lifecycle.stateFieldName is empty", () => {
    expect(() =>
      normalizeGithubProjectItem(
        "project-123",
        makeProjectItem({
          itemId: "item-unconfigured-state",
          issueId: "issue-1",
          number: 1,
          title: "Unconfigured state metadata",
          assignees: [],
        }),
        { ...DEFAULT_WORKFLOW_LIFECYCLE, stateFieldName: "" }
      )
    ).toThrow(
      "github_project_state_field_unconfigured: Project item item-unconfigured-state cannot be normalized without lifecycle.stateFieldName."
    );
  });

  it("normalizes archived items when lifecycle.stateFieldName is empty", () => {
    const issue = normalizeGithubProjectItem(
      "project-123",
      makeProjectItem({
        itemId: "item-archived-unconfigured-state",
        issueId: "issue-1",
        number: 1,
        title: "Archived unconfigured state metadata",
        assignees: [],
        isArchived: true,
      }),
      { ...DEFAULT_WORKFLOW_LIFECYCLE, stateFieldName: "" }
    );

    expect(issue?.state).toBe("Archived");
  });

  it("normalizes PullRequest Project item content instead of dropping it", () => {
    const issue = normalizeGithubProjectItem(
      "project-123",
      makePullRequestProjectItem({
        itemId: "item-pr-7",
        pullRequestId: "pr-7",
        number: 7,
        title: "Ship tracker PR metadata",
        state: "Ready",
      }),
      DEFAULT_WORKFLOW_LIFECYCLE
    );

    expect(issue).toMatchObject({
      id: "pr-7",
      identifier: "acme/platform#7",
      number: 7,
      title: "Ship tracker PR metadata",
      description: "PR body",
      state: "Ready",
      branchName: "feature/pr-metadata",
      url: "https://github.com/acme/platform/pull/7",
      labels: [],
      blockedBy: [],
      repository: {
        owner: "acme",
        name: "platform",
        url: "https://github.com/acme/platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
    });
    expect(issue?.metadata).toMatchObject({
      Status: "Ready",
      contentType: "PullRequest",
      linkedPullRequests: [],
      pullRequest: {
        id: "pr-7",
        number: 7,
        identifier: "acme/platform#7",
        title: "Ship tracker PR metadata",
        body: "PR body",
        url: "https://github.com/acme/platform/pull/7",
        state: "OPEN",
        isDraft: false,
        merged: false,
        headRefName: "feature/pr-metadata",
        baseRefName: "main",
        headRepository: {
          owner: "acme",
          name: "platform",
          url: "https://github.com/acme/platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        repository: {
          owner: "acme",
          name: "platform",
          url: "https://github.com/acme/platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        createdAt: "2026-03-13T00:00:00.000Z",
        updatedAt: "2026-03-14T00:00:00.000Z",
      },
    });
    expect(issue?.metadata.pullRequest).not.toHaveProperty("labels");
    expect(issue?.metadata.pullRequest).not.toHaveProperty("assignees");
  });

  it("preserves fork head repository metadata when normalizing PullRequest Project items", () => {
    // Checkout safety for fork PR subjects is enforced at the orchestrator layer.
    const issue = normalizeGithubProjectItem(
      "project-123",
      makePullRequestProjectItem({
        itemId: "item-pr-8",
        pullRequestId: "pr-8",
        number: 8,
        title: "Validate fork PR metadata",
        state: "Ready",
        headRepository: {
          name: "platform-fork",
          url: "https://github.com/contributor/platform-fork",
          owner: { login: "contributor" },
        },
      }),
      DEFAULT_WORKFLOW_LIFECYCLE
    );

    expect(issue?.metadata.pullRequest).toMatchObject({
      id: "pr-8",
      identifier: "acme/platform#8",
      headRefName: "feature/pr-metadata",
      headRepository: {
        owner: "contributor",
        name: "platform-fork",
        url: "https://github.com/contributor/platform-fork",
        cloneUrl: "https://github.com/contributor/platform-fork.git",
      },
      repository: {
        owner: "acme",
        name: "platform",
      },
    });
  });

  it("attaches Issue linked pull request metadata from closedByPullRequestsReferences", () => {
    const issue = normalizeGithubProjectItem(
      "project-123",
      {
        ...makeProjectItem({
          itemId: "item-1",
          issueId: "issue-1",
          number: 1,
          title: "Issue with linked PR",
          assignees: [],
        }),
        content: {
          ...makeProjectItem({
            itemId: "item-1",
            issueId: "issue-1",
            number: 1,
            title: "Issue with linked PR",
            assignees: [],
          }).content,
          closedByPullRequestsReferences: {
            nodes: [
              makePullRequestProjectItem({
                itemId: "item-pr-7",
                pullRequestId: "pr-7",
                number: 7,
                title: "Fix linked issue",
              }).content,
            ],
          },
        },
      },
      DEFAULT_WORKFLOW_LIFECYCLE
    );

    const metadata = issue?.metadata as Record<string, unknown> | undefined;

    const linkedPullRequests = metadata?.linkedPullRequests as unknown[];

    expect(linkedPullRequests).toEqual([
      expect.objectContaining({
        id: "pr-7",
        number: 7,
        identifier: "acme/platform#7",
        url: "https://github.com/acme/platform/pull/7",
        headRefName: "feature/pr-metadata",
        baseRefName: "main",
        repository: {
          owner: "acme",
          name: "platform",
          url: "https://github.com/acme/platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
      }),
    ]);
    expect(linkedPullRequests[0]).not.toHaveProperty("labels");
    expect(linkedPullRequests[0]).not.toHaveProperty("assignees");
    expect(metadata?.linkedPullRequestsTruncated).toBe(false);
  });

  it("keeps the source issue state distinct from the Project status", () => {
    const projectItem = makeProjectItem({
      itemId: "item-1",
      issueId: "issue-1",
      number: 1,
      title: "Closed issue with active Project status",
      assignees: [],
    });
    const issue = normalizeGithubProjectItem(
      "project-123",
      {
        ...projectItem,
        content: { ...projectItem.content, state: "CLOSED" },
      },
      DEFAULT_WORKFLOW_LIFECYCLE
    );

    expect(issue?.state).toBe("Todo");
    expect(issue?.metadata.sourceState).toBe("CLOSED");
  });

  it("marks Issue linked pull request metadata as truncated when GitHub has another page", () => {
    const linkedPullRequests = Array.from({ length: 20 }, (_, index) => {
      const number = index + 1;
      return makePullRequestProjectItem({
        itemId: `item-pr-${number}`,
        pullRequestId: `pr-${number}`,
        number,
        title: `Linked PR ${number}`,
      }).content;
    });
    const issue = normalizeGithubProjectItem(
      "project-123",
      {
        ...makeProjectItem({
          itemId: "item-1",
          issueId: "issue-1",
          number: 1,
          title: "Issue with many linked PRs",
          assignees: [],
        }),
        content: {
          ...makeProjectItem({
            itemId: "item-1",
            issueId: "issue-1",
            number: 1,
            title: "Issue with many linked PRs",
            assignees: [],
          }).content,
          closedByPullRequestsReferences: {
            nodes: linkedPullRequests,
            pageInfo: {
              hasNextPage: true,
            },
          },
        },
      },
      DEFAULT_WORKFLOW_LIFECYCLE
    );

    const metadata = issue?.metadata as Record<string, unknown> | undefined;

    expect(metadata?.linkedPullRequests).toHaveLength(20);
    expect(metadata?.linkedPullRequestsTruncated).toBe(true);
    expect(metadata?.linkedPullRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "pr-20",
          number: 20,
          identifier: "acme/platform#20",
        }),
      ])
    );
  });

  it("continues to ignore unsupported Project item content types", () => {
    const issue = normalizeGithubProjectItem(
      "project-123",
      {
        id: "item-1",
        updatedAt: "2026-03-14T00:00:00.000Z",
        fieldValues: { nodes: [] },
        content: {
          __typename: "DraftIssue",
          id: "draft-1",
          title: "Unsupported draft",
        },
      } as unknown as Parameters<typeof normalizeGithubProjectItem>[1],
      DEFAULT_WORKFLOW_LIFECYCLE
    );

    expect(issue).toBeNull();
  });

  it("uses the newer project item timestamp when it is later than the issue timestamp", () => {
    const issue = normalizeGithubProjectItem(
      "project-123",
      {
        id: "item-1",
        updatedAt: "2026-03-14T00:05:00.000Z",
        fieldValues: {
          nodes: [
            {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              name: "Ready",
              field: { name: "Status" },
            },
          ],
        },
        content: {
          __typename: "Issue",
          id: "issue-1",
          number: 1,
          title: "Timestamp test",
          body: null,
          url: "https://github.com/acme/platform/issues/1",
          createdAt: "2026-03-14T00:00:00.000Z",
          updatedAt: "2026-03-14T00:04:00.000Z",
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
      DEFAULT_WORKFLOW_LIFECYCLE
    );

    expect(issue?.updatedAt).toBe("2026-03-14T00:05:00.000Z");
  });

  it("keeps the issue timestamp when it is later than the project item timestamp", () => {
    const issue = normalizeGithubProjectItem(
      "project-123",
      {
        id: "item-1",
        updatedAt: "2026-03-14T00:04:00.000Z",
        fieldValues: {
          nodes: [
            {
              __typename: "ProjectV2ItemFieldSingleSelectValue",
              name: "Ready",
              field: { name: "Status" },
            },
          ],
        },
        content: {
          __typename: "Issue",
          id: "issue-1",
          number: 1,
          title: "Timestamp test",
          body: null,
          url: "https://github.com/acme/platform/issues/1",
          createdAt: "2026-03-14T00:00:00.000Z",
          updatedAt: "2026-03-14T00:05:00.000Z",
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
      DEFAULT_WORKFLOW_LIFECYCLE
    );

    expect(issue?.updatedAt).toBe("2026-03-14T00:05:00.000Z");
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
    expect(adapter.fetchIssueStatesByIds).toBeTypeOf("function");
    expect(adapter.buildWorkerEnvironment).toBeTypeOf("function");
    expect(adapter.reviveIssue).toBeTypeOf("function");
  });

  it("propagates the configured GitHub GraphQL endpoint into worker env", () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
    });

    expect(
      adapter.buildWorkerEnvironment(
        {
          projectId: "project-a",
          slug: "project-a",
          workspaceDir: "/tmp/project-a",
          repository: {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.example/acme/platform.git",
          },
          tracker: {
            adapter: "github-project",
            bindingId: "binding-123",
            apiUrl: " https://github.example/api/graphql ",
            settings: {
              projectId: "project-123",
            },
          },
        },
        makeTrackedIssue()
      )
    ).toEqual({
      GITHUB_PROJECT_ID: "project-123",
      GITHUB_GRAPHQL_API_URL: "https://github.example/api/graphql",
    });
  });

  it("finds one GitHub Project issue through the targeted issue lookup", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as { query?: string })
          : {};
      expect(body.query).toContain("RepositoryIssue");
      expect(body.query).toMatch(
        /rateLimit\s*\{\s*cost\s+remaining\s+resetAt\s*\}/s
      );
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              issue: {
                __typename: "Issue",
                id: "issue-42",
                number: 42,
                title: "Target issue",
                body: null,
                url: "https://github.com/acme/platform/issues/42",
                createdAt: "2026-05-01T00:00:00.000Z",
                updatedAt: "2026-05-02T00:00:00.000Z",
                labels: { nodes: [] },
                assignees: { nodes: [] },
                repository: {
                  name: "platform",
                  url: "https://github.com/acme/platform",
                  owner: { login: "acme" },
                },
                blockedBy: { nodes: [] },
                projectItems: {
                  nodes: [
                    {
                      id: "item-42",
                      updatedAt: "2026-05-02T00:00:00.000Z",
                      project: { id: "project-123" },
                      fieldValues: {
                        nodes: [
                          {
                            __typename: "ProjectV2ItemFieldSingleSelectValue",
                            name: "Todo",
                            field: { name: "Status" },
                          },
                        ],
                      },
                    },
                  ],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    });

    const issue = await findGithubProjectIssue(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          settings: {
            projectId: "project-123",
          },
        },
      },
      "acme/platform#42",
      {
        token: "dependencies-token",
        fetchImpl,
      }
    );

    expect(issue?.identifier).toBe("acme/platform#42");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("revives issue title from run records when available", () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const issue = adapter.reviveIssue(
      {
        projectId: "tenant-1",
        slug: "tenant-1",
        workspaceDir: "/tmp/workspaces/tenant-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          settings: {
            projectId: "project-123",
          },
        },
      },
      {
        runId: "run-1",
        projectId: "tenant-1",
        projectSlug: "tenant-1",
        issueId: "issue-1",
        issueSubjectId: "issue-1",
        issueIdentifier: "acme/platform#1",
        issueTitle: "Preserved title",
        issueState: "Ready",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        status: "retrying",
        attempt: 2,
        processId: null,
        port: null,
        workingDirectory: "/tmp/workspaces/tenant-1/acme-platform-1/repository",
        issueWorkspaceKey: "acme-platform-1",
        workspaceRuntimeDir: "/tmp/runtime",
        workflowPath: null,
        retryKind: "recovery",
        createdAt: "2026-03-17T00:00:00Z",
        updatedAt: "2026-03-17T00:00:00Z",
        startedAt: "2026-03-17T00:00:00Z",
        completedAt: null,
        lastError: null,
        nextRetryAt: null,
      }
    );

    expect(issue.title).toBe("Preserved title");
    expect(issue.state).toBe("Ready");
    expect(issue.tracker.itemId).toBe("");
  });

  it("writes transition comments idempotently without changing the agent body", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: { projectId: "project-123" },
    });
    const body = [
      "🔁 Status: `In progress` → `In review`",
      "",
      "Reason: handoff",
    ].join("\n");
    const comments: Array<{ id: string; body: string }> = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        query: string;
        variables: Record<string, string | null>;
      };
      if (request.query.includes("query IssueCommentsById")) {
        return new Response(
          JSON.stringify({
            data: {
              rateLimit: {
                cost: 2,
                remaining: 4998,
                resetAt: "2026-03-19T04:02:00.000Z",
              },
              node: {
                __typename: "Issue",
                comments: {
                  nodes: comments,
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          })
        );
      }
      expect(request.query).toContain("mutation AddIssueComment");
      expect(request.variables).toMatchObject({
        subjectId: "issue-1",
        body,
      });
      comments.push({ id: "comment-1", body });
      return new Response(
        JSON.stringify({
          data: {
            addComment: { commentEdge: { node: { id: "comment-1", body } } },
          },
        })
      );
    });

    await expect(
      adapter.upsertTransitionComment?.(
        makeProjectConfig(),
        { issueSubjectId: "issue-1", body },
        { token: "test-token", fetchImpl }
      )
    ).resolves.toMatchObject({
      outcome: "created",
      rateLimits: expect.objectContaining({
        cycleCost: 2,
        queryCosts: {
          IssueCommentsById: { requestCount: 1, cost: 2 },
        },
      }),
    });
    await expect(
      adapter.upsertTransitionComment?.(
        makeProjectConfig(),
        { issueSubjectId: "issue-1", body },
        { token: "test-token", fetchImpl }
      )
    ).resolves.toMatchObject({
      outcome: "unchanged",
      rateLimits: expect.objectContaining({ cycleCost: 2 }),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("creates advisory comments when the marker is absent", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              rateLimit: {
                cost: 2,
                remaining: 4998,
                resetAt: "2026-03-19T04:02:00.000Z",
              },
              node: {
                __typename: "Issue",
                comments: {
                  nodes: [],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          }),
          {
            headers: {
              "x-ratelimit-used": "2",
              "x-ratelimit-resource": "graphql",
            },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              rateLimit: {
                cost: 3,
                remaining: 4995,
                resetAt: "2026-03-19T04:02:00.000Z",
              },
              addComment: {
                commentEdge: {
                  node: {
                    id: "comment-1",
                    body: "marker body",
                  },
                },
              },
            },
          }),
          {
            headers: {
              "x-ratelimit-used": "5",
              "x-ratelimit-resource": "graphql",
            },
          }
        )
      );

    const result = await adapter.upsertIssueComment?.(
      makeProjectConfig(),
      makeTrackedIssue(),
      {
        marker:
          "<!-- gh-symphony:linked-pr-active-while-issue-inactive issue=issue-1 pr=pr-2 -->",
        body: "marker body",
      },
      { token: "test-token", fetchImpl }
    );

    expect(result).toMatchObject({
      outcome: "created",
      rateLimits: {
        cycleCost: 5,
        queryCosts: {
          IssueCommentsById: { requestCount: 1, cost: 2 },
          AddIssueComment: { requestCount: 1, cost: 3 },
        },
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const queryBody = JSON.parse(
      String(fetchImpl.mock.calls[0]?.[1]?.body)
    ) as { query: string };
    expect(queryBody.query).toContain("query IssueCommentsById");
    expect(queryBody.query).toMatch(
      /rateLimit\s*\{\s*cost\s+remaining\s+resetAt\s*\}/s
    );
    const mutationBody = JSON.parse(
      String(fetchImpl.mock.calls[1]?.[1]?.body)
    ) as { query: string; variables: Record<string, string> };
    expect(mutationBody.query).toContain("mutation AddIssueComment");
    // GitHub exposes rateLimit on Query only; mutation cost is inferred from
    // successive x-ratelimit-used response headers.
    expect(mutationBody.query).not.toContain("rateLimit");
    expect(mutationBody.variables.subjectId).toBe("issue-1");
  });

  it.each([
    ["https://api.github.com/graphql", "https://api.github.com"],
    ["https://github.example/api/graphql", "https://github.example/api/v3"],
    ["https://github.example/api/v3/graphql", "https://github.example/api/v3"],
  ])(
    "creates an advisory comment through REST from %s and persists its ETag",
    async (apiUrl, restApiUrl) => {
      const adapter = resolveTrackerAdapter({
        adapter: "github-project",
        bindingId: "project-123",
        settings: { projectId: "project-123" },
      });
      const marker = "<!-- gh-symphony:advisory -->";
      const body = `${marker}\ncreated body`;
      const cache: IssueCommentCache = {
        get: vi.fn(async () => null),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      };
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              data: {
                node: {
                  __typename: "Issue",
                  comments: {
                    nodes: [],
                    pageInfo: { endCursor: null, hasNextPage: false },
                  },
                },
              },
            })
          )
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 42, body }), {
            status: 201,
            headers: { etag: '"comment-v1"' },
          })
        );

      await expect(
        adapter.upsertIssueComment?.(
          makeProjectConfig({ apiUrl }),
          makeTrackedIssue(),
          { marker, body },
          { token: "test-token", fetchImpl, issueCommentCache: cache }
        )
      ).resolves.toMatchObject({ outcome: "created", rateLimits: null });

      expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(apiUrl);
      expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(
        `${restApiUrl}/repos/acme/platform/issues/1/comments`
      );
      expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
        method: "POST",
        body: JSON.stringify({ body }),
      });
      expect(cache.set).toHaveBeenCalledTimes(1);
      expect(cache.set).toHaveBeenCalledWith(expect.any(String), {
        commentId: 42,
        etag: '"comment-v1"',
        body,
      });
    }
  );

  it.each([
    ["https://api.github.com/graphql", "https://api.github.com"],
    ["https://github.example/api/graphql", "https://github.example/api/v3"],
    ["https://github.example/api/v3/graphql", "https://github.example/api/v3"],
  ])(
    "updates a cached advisory comment through REST from %s with one cache write",
    async (apiUrl, restApiUrl) => {
      const adapter = resolveTrackerAdapter({
        adapter: "github-project",
        bindingId: "project-123",
        settings: { projectId: "project-123" },
      });
      const marker = "<!-- gh-symphony:advisory -->";
      const body = `${marker}\nupdated body`;
      const cache: IssueCommentCache = {
        get: vi.fn(async () => ({
          commentId: 42,
          etag: '"comment-v1"',
          body: `${marker}\nold body`,
        })),
        set: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      };
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ id: 42, body: `${marker}\nold body` }),
            {
              headers: { etag: '"comment-v1"' },
            }
          )
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 42, body }), {
            headers: { etag: '"comment-v2"' },
          })
        );

      await expect(
        adapter.upsertIssueComment?.(
          makeProjectConfig({ apiUrl }),
          makeTrackedIssue(),
          { marker, body },
          { token: "test-token", fetchImpl, issueCommentCache: cache }
        )
      ).resolves.toMatchObject({ outcome: "updated", rateLimits: null });

      expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
        `${restApiUrl}/repos/acme/platform/issues/comments/42`
      );
      expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(
        `${restApiUrl}/repos/acme/platform/issues/comments/42`
      );
      expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
        method: "PATCH",
        body: JSON.stringify({ body }),
      });
      expect(cache.set).toHaveBeenCalledTimes(1);
      expect(cache.set).toHaveBeenCalledWith(expect.any(String), {
        commentId: 42,
        etag: '"comment-v2"',
        body,
      });
    }
  );

  it("does not update advisory comments when the existing body is unchanged", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });
    const marker =
      "<!-- gh-symphony:linked-pr-active-while-issue-inactive issue=issue-1 pr=pr-2 -->";
    const body = `${marker}\n\nLinked PR card status alone does not trigger dispatch.`;
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            rateLimit: {
              cost: 2,
              remaining: 4998,
              resetAt: "2026-03-19T04:02:00.000Z",
            },
            node: {
              __typename: "Issue",
              comments: {
                nodes: [{ id: "comment-1", body }],
                pageInfo: { endCursor: null, hasNextPage: false },
              },
            },
          },
        })
      )
    );

    const result = await adapter.upsertIssueComment?.(
      makeProjectConfig(),
      makeTrackedIssue(),
      { marker, body },
      { token: "test-token", fetchImpl }
    );

    expect(result).toMatchObject({
      outcome: "unchanged",
      rateLimits: {
        cycleCost: 2,
        queryCosts: {
          IssueCommentsById: { requestCount: 1, cost: 2 },
        },
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("updates advisory comments when the marker exists with a different body", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });
    const marker =
      "<!-- gh-symphony:linked-pr-active-while-issue-inactive issue=issue-1 pr=pr-2 -->";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              rateLimit: {
                cost: 2,
                remaining: 4998,
                resetAt: "2026-03-19T04:02:00.000Z",
              },
              node: {
                __typename: "Issue",
                comments: {
                  nodes: [{ id: "comment-1", body: `${marker}\nold body` }],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          }),
          {
            headers: {
              "x-ratelimit-used": "2",
              "x-ratelimit-resource": "graphql",
            },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              rateLimit: {
                cost: 4,
                remaining: 4994,
                resetAt: "2026-03-19T04:02:00.000Z",
              },
              updateIssueComment: {
                issueComment: {
                  id: "comment-1",
                  body: `${marker}\nnew body`,
                },
              },
            },
          }),
          {
            headers: {
              "x-ratelimit-used": "6",
              "x-ratelimit-resource": "graphql",
            },
          }
        )
      );

    const result = await adapter.upsertIssueComment?.(
      makeProjectConfig(),
      makeTrackedIssue(),
      { marker, body: `${marker}\nnew body` },
      { token: "test-token", fetchImpl }
    );

    expect(result).toMatchObject({
      outcome: "updated",
      rateLimits: {
        cycleCost: 6,
        queryCosts: {
          IssueCommentsById: { requestCount: 1, cost: 2 },
          UpdateIssueComment: { requestCount: 1, cost: 4 },
        },
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const mutationBody = JSON.parse(
      String(fetchImpl.mock.calls[1]?.[1]?.body)
    ) as { query: string; variables: Record<string, string> };
    expect(mutationBody.query).toContain("mutation UpdateIssueComment");
    // GitHub exposes rateLimit on Query only; mutation cost is inferred from
    // successive x-ratelimit-used response headers.
    expect(mutationBody.query).not.toContain("rateLimit");
    expect(mutationBody.variables.commentId).toBe("comment-1");
  });

  it("discovers an advisory comment once and reuses its persisted ETag", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });
    const marker =
      "<!-- gh-symphony:linked-pr-active-while-issue-inactive issue=issue-1 pr=pr-2 -->";
    const body = `${marker}\n\nLinked PR card status alone does not trigger dispatch.`;
    const entries = new Map<string, IssueCommentCacheEntry>();
    const cache: IssueCommentCache = {
      get: vi.fn(async (key) => entries.get(key) ?? null),
      set: vi.fn(async (key, entry) => {
        entries.set(key, entry);
      }),
      delete: vi.fn(async (key) => {
        entries.delete(key);
      }),
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              node: {
                __typename: "Issue",
                comments: {
                  nodes: [
                    {
                      id: "comment-node-1",
                      databaseId: 42,
                      body,
                    },
                  ],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 42, body }), {
          headers: { etag: '"comment-v1"' },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 304 }));

    const dependencies = {
      token: "test-token",
      fetchImpl,
      issueCommentCache: cache,
    };
    const first = await adapter.upsertIssueComment?.(
      makeProjectConfig(),
      makeTrackedIssue(),
      { marker, body },
      dependencies
    );
    const second = await adapter.upsertIssueComment?.(
      makeProjectConfig(),
      makeTrackedIssue(),
      { marker, body },
      dependencies
    );

    expect(first).toMatchObject({ outcome: "unchanged", rateLimits: null });
    expect(second).toMatchObject({ outcome: "unchanged", rateLimits: null });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/graphql"
    );
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(
      "https://api.github.com/repos/acme/platform/issues/comments/42"
    );
    expect(String(fetchImpl.mock.calls[2]?.[0])).toBe(
      "https://api.github.com/repos/acme/platform/issues/comments/42"
    );
    expect(fetchImpl.mock.calls[2]?.[1]?.headers).toMatchObject({
      "if-none-match": '"comment-v1"',
    });
    expect(cache.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        commentId: 42,
        etag: '"comment-v1"',
        body,
      })
    );
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  it("re-discovers an advisory comment when the cached REST id is stale", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });
    const marker =
      "<!-- gh-symphony:linked-pr-active-while-issue-inactive issue=issue-1 pr=pr-2 -->";
    const body = `${marker}\nnew body`;
    const staleEntry: IssueCommentCacheEntry = {
      commentId: 41,
      etag: '"stale"',
      body,
    };
    let entry: IssueCommentCacheEntry | null = staleEntry;
    const cache: IssueCommentCache = {
      get: vi.fn(async () => entry),
      set: vi.fn(async (_key, value) => {
        entry = value;
      }),
      delete: vi.fn(async () => {
        entry = null;
      }),
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              node: {
                __typename: "Issue",
                comments: {
                  nodes: [
                    {
                      id: "comment-node-2",
                      databaseId: 42,
                      body,
                    },
                  ],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 42, body }), {
          headers: { etag: '"comment-v2"' },
        })
      );

    const result = await adapter.upsertIssueComment?.(
      makeProjectConfig(),
      makeTrackedIssue(),
      { marker, body },
      { token: "test-token", fetchImpl, issueCommentCache: cache }
    );

    expect(result).toMatchObject({ outcome: "unchanged", rateLimits: null });
    expect(cache.delete).toHaveBeenCalledTimes(1);
    expect(entry).toEqual({
      commentId: 42,
      etag: '"comment-v2"',
      body,
    });
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
          repository: {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git",
          },
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

  it("omits nested PR labels and assignees from the project items query", async () => {
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
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
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
          const body = JSON.parse(String(init?.body)) as { query: string };
          expect(body.query.match(/labels\(first: 20\)/g)).toHaveLength(1);
          expect(body.query.match(/assignees\(first: 20\)/g)).toHaveLength(1);
          expect(body.query).toContain("blockedBy(first: 100)");
          expect(body.query).toContain(
            "closedByPullRequestsReferences(first: 20)"
          );
          expect(body.query).not.toContain("archivedStates:");
          expect(body.query).not.toContain("isArchived");
          const pullRequestFragment = body.query.match(
            /fragment PullRequestMetadata on PullRequest \{[\s\S]*?\n {2}\}/
          )?.[0];
          expect(pullRequestFragment).toBeDefined();
          expect(pullRequestFragment).not.toContain("labels(");
          expect(pullRequestFragment).not.toContain("assignees(");

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
  });

  it("excludes terminal states with a negative Project V2 query and logs before/after counts", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    try {
      const issues = await adapter.listIssues(makeProjectConfig(), {
        token: "dependencies-token",
        workflowLifecycle: {
          stateFieldName: "Status",
          activeStates: ["Ready", "In progress", "Land"],
          terminalStates: ["Done", "Won't Do"],
          blockerCheckStates: ["Ready"],
          planningStates: ["Ready"],
        },
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as {
            query: string;
            variables: {
              query: string | null;
              includeUnfilteredCount: boolean;
            };
          };
          expect(body.query).toContain("$query: String");
          expect(body.query).toContain(
            "items(first: $pageSize, after: $cursor, query: $query)"
          );
          expect(body.variables.query).toBe(`-status:Done,"Won't Do"`);
          expect(body.variables.includeUnfilteredCount).toBe(true);

          return makeJsonResponse({
            data: {
              node: {
                __typename: "ProjectV2",
                unfilteredItems: {
                  totalCount: 90,
                },
                items: {
                  totalCount: 2,
                  nodes: [
                    makeProjectItem({
                      itemId: "item-ready",
                      issueId: "issue-ready",
                      number: 1,
                      title: "Ready issue",
                      assignees: [],
                      state: "Ready",
                    }),
                    makeProjectItem({
                      itemId: "item-progress",
                      issueId: "issue-progress",
                      number: 2,
                      title: "Active run issue",
                      assignees: [],
                      state: "In progress",
                    }),
                  ],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          });
        },
      });

      expect(issues.map((issue) => issue.state)).toEqual([
        "Ready",
        "In progress",
      ]);
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '"event":"tracker-project-items-state-filtered"'
        )
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"unfilteredCount":90')
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"filteredCount":2')
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"excludedCount":88')
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("falls back to unfiltered project items for a custom lifecycle state field", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const issues = await adapter.listIssues(makeProjectConfig(), {
      token: "dependencies-token",
      workflowLifecycle: {
        stateFieldName: "Stage",
        activeStates: ["Ready", "In progress"],
        terminalStates: ["Done"],
        blockerCheckStates: ["Ready"],
        planningStates: ["Ready"],
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          variables: {
            query: string | null;
            includeUnfilteredCount: boolean;
          };
        };
        expect(body.variables.query).toBeNull();
        expect(body.variables.includeUnfilteredCount).toBe(false);

        return makeJsonResponse(
          makeProjectItemsPayload([
            makeProjectItem({
              itemId: "item-ready",
              issueId: "issue-ready",
              number: 1,
              title: "Ready issue with custom state field",
              assignees: [],
              state: "Ready",
              stateFieldName: "Stage",
            }),
          ])
        );
      },
    });

    expect(issues.map((issue) => issue.state)).toEqual(["Ready"]);
  });

  it("falls back to unfiltered project items when terminal states are empty", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const issues = await adapter.listIssues(makeProjectConfig(), {
      token: "dependencies-token",
      workflowLifecycle: {
        stateFieldName: "Status",
        activeStates: ["Ready", "In progress"],
        terminalStates: [],
        blockerCheckStates: ["Ready"],
        planningStates: ["Ready"],
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          variables: {
            query: string | null;
            includeUnfilteredCount: boolean;
          };
        };
        expect(body.variables.query).toBeNull();
        expect(body.variables.includeUnfilteredCount).toBe(false);

        return makeJsonResponse(
          makeProjectItemsPayload([
            makeProjectItem({
              itemId: "item-ready",
              issueId: "issue-ready",
              number: 1,
              title: "Ready issue without terminal states",
              assignees: [],
              state: "Ready",
            }),
          ])
        );
      },
    });

    expect(issues.map((issue) => issue.state)).toEqual(["Ready"]);
  });

  it("fails loudly instead of excluding a state configured as active and terminal", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });
    const fetchImpl = vi.fn();

    await expect(
      adapter.listIssues(makeProjectConfig(), {
        token: "dependencies-token",
        workflowLifecycle: {
          stateFieldName: "Status",
          activeStates: ["Ready", "In progress"],
          terminalStates: ["Done", "ready"],
          blockerCheckStates: ["Ready"],
          planningStates: ["Ready"],
        },
        fetchImpl,
      })
    ).rejects.toThrow('state "ready" cannot be both active and terminal');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps explicit state lookups unfiltered when candidate lifecycle filtering is enabled", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const issues = await adapter.listIssuesByStates(
      makeProjectConfig(),
      ["Done"],
      {
        token: "dependencies-token",
        workflowLifecycle: {
          stateFieldName: "Status",
          activeStates: ["Ready", "In progress"],
          terminalStates: ["Done"],
          blockerCheckStates: ["Ready"],
          planningStates: ["Ready"],
        },
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as {
            variables: {
              query: string | null;
              includeUnfilteredCount: boolean;
            };
          };
          expect(body.variables.query).toBeNull();
          expect(body.variables.includeUnfilteredCount).toBe(false);
          return makeJsonResponse(
            makeProjectItemsPayload([
              makeProjectItem({
                itemId: "item-done",
                issueId: "issue-done",
                number: 3,
                title: "Done issue",
                assignees: [],
                state: "Done",
              }),
            ])
          );
        },
      }
    );

    expect(issues.map((issue) => issue.state)).toEqual(["Done"]);
  });

  it("keeps the custom lifecycle field when explicit state lookups disable server filtering", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const issues = await adapter.listIssuesByStates(
      makeProjectConfig(),
      ["Done"],
      {
        token: "dependencies-token",
        workflowLifecycle: {
          stateFieldName: "Stage",
          activeStates: ["Ready", "In progress"],
          terminalStates: ["Done"],
          blockerCheckStates: ["Ready"],
          planningStates: ["Ready"],
        },
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as {
            variables: {
              query: string | null;
              includeUnfilteredCount: boolean;
            };
          };
          expect(body.variables.query).toBeNull();
          expect(body.variables.includeUnfilteredCount).toBe(false);
          return makeJsonResponse(
            makeProjectItemsPayload([
              makeProjectItem({
                itemId: "item-done",
                issueId: "issue-done",
                number: 3,
                title: "Done issue with custom state field",
                assignees: [],
                state: "Done",
                stateFieldName: "Stage",
              }),
            ])
          );
        },
      }
    );

    expect(issues.map((issue) => issue.state)).toEqual(["Done"]);
  });

  it("falls back to legacy assignedOnly tracker setting with a deprecation warning", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

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
          repository: {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git",
          },
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

  it("uses runtime assignedOnly input before legacy tracker settings", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-runtime-assigned",
      settings: {
        projectId: "project-runtime-assigned",
        assignedOnly: true,
      },
    });

    const issues = await adapter.listIssues(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        tracker: {
          adapter: "github-project",
          bindingId: "project-runtime-assigned",
          settings: {
            projectId: "project-runtime-assigned",
            assignedOnly: true,
          },
        },
      },
      {
        assignedOnly: false,
        token: "dependencies-token",
        fetchImpl: async (url, _init) => {
          expect(String(url)).not.toMatch(/\/user$/);
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

    expect(issues).toHaveLength(2);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("automatically scopes Project V2 dispatch to each daemon repository", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-repo-scope",
      settings: {
        projectId: "project-repo-scope",
      },
    });
    const payload = makeProjectItemsPayload([
      makeProjectItem({
        itemId: "item-platform",
        issueId: "issue-platform",
        number: 1,
        title: "Platform issue",
        assignees: [],
        repository: { owner: "acme", name: "platform" },
      }),
      makeProjectItem({
        itemId: "item-web",
        issueId: "issue-web",
        number: 2,
        title: "Web issue",
        assignees: [],
        repository: { owner: "acme", name: "web" },
      }),
    ]);
    const fetchImpl = vi.fn(async () => makeJsonResponse(payload));
    const cacheEntries = new Map<string, Promise<TrackedIssue[]>>();
    const projectItemsCache: ProjectItemsCache = {
      getOrLoad(key, load) {
        const cached = cacheEntries.get(key);
        if (cached) {
          return cached;
        }

        const pending = load();
        cacheEntries.set(key, pending);
        return pending;
      },
    };

    try {
      const platformIssues = await adapter.listIssues(
        makeProjectConfig({ repository: { owner: "acme", name: "platform" } }),
        {
          token: "dependencies-token",
          fetchImpl,
          projectItemsCache,
        }
      );
      const webIssues = await adapter.listIssues(
        makeProjectConfig({ repository: { owner: "acme", name: "web" } }),
        {
          token: "dependencies-token",
          fetchImpl,
          projectItemsCache,
        }
      );

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(platformIssues.map((issue) => issue.identifier)).toEqual([
        "acme/platform#1",
      ]);
      expect(webIssues.map((issue) => issue.identifier)).toEqual([
        "acme/web#2",
      ]);
      const webIssueIds = new Set(webIssues.map((issue) => issue.id));
      expect(platformIssues.some((issue) => webIssueIds.has(issue.id))).toBe(
        false
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"tracker-repository-filtered"')
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("defaults missing tracker repository settings to the project repository", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-default-repo-scope",
      settings: {
        projectId: "project-default-repo-scope",
      },
    });

    const issues = await adapter.listIssues(
      makeProjectConfig({ repository: { owner: "acme", name: "platform" } }),
      {
        token: "dependencies-token",
        fetchImpl: async () =>
          makeJsonResponse(
            makeProjectItemsPayload([
              makeProjectItem({
                itemId: "item-platform",
                issueId: "issue-platform",
                number: 1,
                title: "Platform issue",
                assignees: [],
                repository: { owner: "acme", name: "platform" },
              }),
              makeProjectItem({
                itemId: "item-web",
                issueId: "issue-web",
                number: 2,
                title: "Web issue",
                assignees: [],
                repository: { owner: "acme", name: "web" },
              }),
            ])
          ),
      }
    );

    expect(issues.map((issue) => issue.identifier)).toEqual([
      "acme/platform#1",
    ]);
  });

  it("allows tracker repository '*' to opt out of repository dispatch scoping", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-repo-opt-out",
      settings: {
        projectId: "project-repo-opt-out",
      },
    });

    try {
      const issues = await adapter.listIssues(
        makeProjectConfig({
          repository: { owner: "acme", name: "platform" },
          trackerSettings: { repository: "*" },
        }),
        {
          token: "dependencies-token",
          fetchImpl: async () =>
            makeJsonResponse(
              makeProjectItemsPayload([
                makeProjectItem({
                  itemId: "item-platform",
                  issueId: "issue-platform",
                  number: 1,
                  title: "Platform issue",
                  assignees: [],
                  repository: { owner: "acme", name: "platform" },
                }),
                makeProjectItem({
                  itemId: "item-web",
                  issueId: "issue-web",
                  number: 2,
                  title: "Web issue",
                  assignees: [],
                  repository: { owner: "acme", name: "web" },
                }),
              ])
            ),
        }
      );

      expect(issues.map((issue) => issue.identifier)).toEqual([
        "acme/platform#1",
        "acme/web#2",
      ]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("repository scoping is disabled")
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("uses tracker repository owner/name as an override when it differs from cwd origin", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-repo-override",
      settings: {
        projectId: "project-repo-override",
      },
    });

    const issues = await adapter.listIssues(
      makeProjectConfig({
        repository: { owner: "acme", name: "platform" },
        trackerSettings: { repository: "acme/web" },
      }),
      {
        token: "dependencies-token",
        fetchImpl: async () =>
          makeJsonResponse(
            makeProjectItemsPayload([
              makeProjectItem({
                itemId: "item-platform",
                issueId: "issue-platform",
                number: 1,
                title: "Platform issue",
                assignees: [],
                repository: { owner: "acme", name: "platform" },
              }),
              makeProjectItem({
                itemId: "item-web",
                issueId: "issue-web",
                number: 2,
                title: "Web issue",
                assignees: [],
                repository: { owner: "acme", name: "web" },
              }),
            ])
          ),
      }
    );

    expect(issues.map((issue) => issue.identifier)).toEqual(["acme/web#2"]);
  });

  it("matches repository filters case-insensitively", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-repo-casing",
      settings: {
        projectId: "project-repo-casing",
      },
    });

    const issues = await adapter.listIssues(
      makeProjectConfig({
        repository: { owner: "example", name: "other" },
        trackerSettings: { repository: "Acme/Platform" },
      }),
      {
        token: "dependencies-token",
        fetchImpl: async () =>
          makeJsonResponse(
            makeProjectItemsPayload([
              makeProjectItem({
                itemId: "item-platform",
                issueId: "issue-platform",
                number: 1,
                title: "Platform issue",
                assignees: [],
                repository: { owner: "acme", name: "platform" },
              }),
              makeProjectItem({
                itemId: "item-web",
                issueId: "issue-web",
                number: 2,
                title: "Web issue",
                assignees: [],
                repository: { owner: "acme", name: "web" },
              }),
            ])
          ),
      }
    );

    expect(issues.map((issue) => issue.identifier)).toEqual([
      "acme/platform#1",
    ]);
  });

  it("excludes assigned issues from other repositories before dispatch", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-repo-assignee-cross",
      settings: {
        projectId: "project-repo-assignee-cross",
      },
    });

    const issues = await adapter.listIssues(
      makeProjectConfig({ repository: { owner: "acme", name: "platform" } }),
      {
        assignedOnly: true,
        token: "dependencies-token",
        fetchImpl: async (url) => {
          if (String(url).endsWith("/user")) {
            return makeJsonResponse({ login: "machine-user" });
          }

          return makeJsonResponse(
            makeProjectItemsPayload([
              makeProjectItem({
                itemId: "item-platform",
                issueId: "issue-platform",
                number: 1,
                title: "Platform issue",
                assignees: ["machine-user"],
                repository: { owner: "acme", name: "platform" },
              }),
              makeProjectItem({
                itemId: "item-web",
                issueId: "issue-web",
                number: 2,
                title: "Web issue",
                assignees: ["machine-user"],
                repository: { owner: "acme", name: "web" },
              }),
            ])
          );
        },
      }
    );

    expect(issues.map((issue) => issue.identifier)).toEqual([
      "acme/platform#1",
    ]);
  });

  it("excludes Project V2 draft items without repository content when scoped", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-repo-draft",
      settings: {
        projectId: "project-repo-draft",
      },
    });

    const issues = await adapter.listIssues(
      makeProjectConfig({ repository: { owner: "acme", name: "platform" } }),
      {
        token: "dependencies-token",
        fetchImpl: async () =>
          makeJsonResponse(
            makeProjectItemsPayload([
              {
                id: "item-draft",
                updatedAt: "2026-03-14T00:00:00.000Z",
                fieldValues: { nodes: [] },
                content: {
                  __typename: "DraftIssue",
                  id: "draft-1",
                  title: "Unsupported draft",
                },
              },
              makeProjectItem({
                itemId: "item-platform",
                issueId: "issue-platform",
                number: 1,
                title: "Platform issue",
                assignees: [],
                repository: { owner: "acme", name: "platform" },
              }),
            ])
          ),
      }
    );

    expect(issues.map((issue) => issue.identifier)).toEqual([
      "acme/platform#1",
    ]);
  });

  it("rejects malformed tracker repository overrides", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-repo-parse",
      settings: {
        projectId: "project-repo-parse",
      },
    });

    for (const repository of ["acme", "/platform", "acme/", "acme/web/api"]) {
      await expect(
        adapter.listIssues(
          makeProjectConfig({
            trackerSettings: { repository },
          }),
          {
            token: "dependencies-token",
            fetchImpl: async () =>
              makeJsonResponse(makeProjectItemsPayload([])),
          }
        )
      ).rejects.toThrow(
        'requires the "repository" setting to be "*" or "owner/name"'
      );
    }
  });

  it("records field-based GraphQL cost while retaining rate-limit headers", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const issues = await adapter.listIssues(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
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
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              data: {
                rateLimit: {
                  cost: 11,
                  remaining: 4988,
                  resetAt: "2026-03-19T04:02:00.000Z",
                },
                node: {
                  __typename: "ProjectV2",
                  items: {
                    nodes: [
                      makeProjectItem({
                        itemId: "item-1",
                        issueId: "issue-1",
                        number: 1,
                        title: "Tracked issue",
                        assignees: [],
                      }),
                    ],
                    pageInfo: { endCursor: null, hasNextPage: false },
                  },
                },
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4987",
                "x-ratelimit-used": "13",
                "x-ratelimit-reset": "1773892800",
                "x-ratelimit-resource": "graphql",
              },
            }
          ),
      }
    );

    expect(issues).toHaveLength(1);
    expect(issues.rateLimits).toEqual({
      source: "github",
      limit: 5000,
      remaining: 4988,
      used: 13,
      reset: 1773892800,
      resetAt: "2026-03-19T04:02:00.000Z",
      resource: "graphql",
      cost: 11,
      cycleCost: 11,
      queryCosts: {
        ProjectItems: {
          requestCount: 1,
          cost: 11,
        },
      },
      fieldRateLimits: {
        cost: 11,
        remaining: 4988,
        resetAt: "2026-03-19T04:02:00.000Z",
      },
      headerRateLimits: {
        source: "github",
        limit: 5000,
        remaining: 4987,
        used: 13,
        reset: 1773892800,
        resetAt: "2026-03-19T04:00:00.000Z",
        resource: "graphql",
      },
    });
    expect(issues[0]?.rateLimits).toEqual(
      expect.objectContaining({
        cost: 11,
      })
    );
    expect(issues[0]?.rateLimits).not.toHaveProperty("cycleCost");
  });

  it("waits for the cached GraphQL rate limit reset when exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-19T04:00:00.000Z"));

    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
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
            headers: {
              "content-type": "application/json",
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1773892830",
              "x-ratelimit-resource": "graphql",
            },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
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
            headers: {
              "content-type": "application/json",
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "4999",
              "x-ratelimit-reset": "1773892890",
              "x-ratelimit-resource": "graphql",
            },
          }
        )
      );

    await adapter.listIssues(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
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
        fetchImpl,
      }
    );

    const pendingRequest = adapter.listIssues(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
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
        fetchImpl,
      }
    );

    await vi.advanceTimersByTimeAsync(29_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await pendingRequest;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a secondary rate-limit 403 after Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-19T04:00:00.000Z"));
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: { projectId: "project-123" },
    });
    const success = new Response(
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
      { status: 200, headers: { "content-type": "application/json" } }
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("secondary rate limit exceeded", {
          status: 403,
          headers: { "retry-after": "2" },
        })
      )
      .mockResolvedValueOnce(success);

    const pending = adapter.listIssues(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          settings: { projectId: "project-123" },
        },
      },
      { token: "dependencies-token", fetchImpl }
    );

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry an authentication or permission 403", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: { projectId: "project-123" },
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("Resource not accessible by personal access token", {
        status: 403,
      })
    );

    await expect(
      adapter.listIssues(
        {
          projectId: "workspace-1",
          slug: "workspace-1",
          workspaceDir: "/tmp/workspace-1",
          repository: {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git",
          },
          tracker: {
            adapter: "github-project",
            bindingId: "project-123",
            settings: { projectId: "project-123" },
          },
        },
        { token: "dependencies-token", fetchImpl }
      )
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("allows a soft-threshold GraphQL request when the cached reset is too far away", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-19T04:00:00.000Z"));

    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const createResponse = (remaining: string) =>
      new Response(
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
          headers: {
            "content-type": "application/json",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": remaining,
            "x-ratelimit-reset": "1773892920",
            "x-ratelimit-resource": "graphql",
          },
        }
      );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(createResponse("100"))
      .mockResolvedValueOnce(createResponse("99"));

    await adapter.listIssues(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
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
        fetchImpl,
      }
    );

    await adapter.listIssues(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
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
        fetchImpl,
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("skips the GraphQL request when the cached rate limit is exhausted and reset is too far away", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-19T04:00:00.000Z"));

    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(
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
          headers: {
            "content-type": "application/json",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1773892920",
            "x-ratelimit-resource": "graphql",
          },
        }
      )
    );

    await adapter.listIssues(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
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
        fetchImpl,
      }
    );

    let thrown: unknown;
    try {
      await adapter.listIssues(
        {
          projectId: "workspace-1",
          slug: "workspace-1",
          workspaceDir: "/tmp/workspace-1",
          repository: {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git",
          },
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
          fetchImpl,
        }
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(GitHubGraphQLRateLimitError);
    expect((thrown as Error).message).toBe(
      "GitHub GraphQL rate limit near exhaustion"
    );
    expect((thrown as { rateLimits?: unknown }).rateLimits).toEqual({
      source: "github",
      limit: 5000,
      remaining: 0,
      used: null,
      reset: 1773892920,
      resetAt: "2026-03-19T04:02:00.000Z",
      resource: "graphql",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("scopes the cached GraphQL rate limit to the current token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-19T04:00:00.000Z"));

    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
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
            headers: {
              "content-type": "application/json",
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "100",
              "x-ratelimit-reset": "1773892920",
              "x-ratelimit-resource": "graphql",
            },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
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
            headers: {
              "content-type": "application/json",
              "x-ratelimit-limit": "5000",
              "x-ratelimit-remaining": "4999",
              "x-ratelimit-reset": "1773892890",
              "x-ratelimit-resource": "graphql",
            },
          }
        )
      );

    await adapter.listIssues(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          settings: {
            projectId: "project-123",
          },
        },
      },
      {
        token: "token-a",
        fetchImpl,
      }
    );

    await expect(
      adapter.listIssues(
        {
          projectId: "workspace-1",
          slug: "workspace-1",
          workspaceDir: "/tmp/workspace-1",
          repository: {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git",
          },
          tracker: {
            adapter: "github-project",
            bindingId: "project-123",
            settings: {
              projectId: "project-123",
            },
          },
        },
        {
          token: "token-b",
          fetchImpl,
        }
      )
    ).resolves.toHaveLength(0);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("applies the latest paginated GitHub rate-limit headers to all listed issues", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const issues = await adapter.listIssues(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
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
          const body = JSON.parse(String(init?.body)) as {
            variables?: { cursor?: string | null };
          };
          const cursor = body.variables?.cursor ?? null;
          const page =
            cursor === null
              ? {
                  nodes: [
                    makeProjectItem({
                      itemId: "item-1",
                      issueId: "issue-1",
                      number: 1,
                      title: "First issue",
                      assignees: [],
                    }),
                  ],
                  pageInfo: { endCursor: "cursor-1", hasNextPage: true },
                  rateLimit: {
                    cost: 7,
                    remaining: 4999,
                    resetAt: "2026-03-19T04:00:00.000Z",
                  },
                  headers: {
                    "content-type": "application/json",
                    "x-ratelimit-limit": "5000",
                    "x-ratelimit-remaining": "4999",
                    "x-ratelimit-used": "1",
                    "x-ratelimit-reset": "1773892800",
                    "x-ratelimit-resource": "graphql",
                  },
                }
              : {
                  nodes: [
                    makeProjectItem({
                      itemId: "item-2",
                      issueId: "issue-2",
                      number: 2,
                      title: "Second issue",
                      assignees: [],
                    }),
                  ],
                  pageInfo: { endCursor: null, hasNextPage: false },
                  rateLimit: {
                    cost: 4,
                    remaining: 4997,
                    resetAt: "2026-03-19T04:01:00.000Z",
                  },
                  headers: {
                    "content-type": "application/json",
                    "x-ratelimit-limit": "5000",
                    "x-ratelimit-remaining": "4997",
                    "x-ratelimit-used": "3",
                    "x-ratelimit-reset": "1773892860",
                    "x-ratelimit-resource": "graphql",
                  },
                };

          return new Response(
            JSON.stringify({
              data: {
                rateLimit: page.rateLimit,
                node: {
                  __typename: "ProjectV2",
                  items: {
                    nodes: page.nodes,
                    pageInfo: page.pageInfo,
                  },
                },
              },
            }),
            {
              status: 200,
              headers: page.headers,
            }
          );
        },
      }
    );

    expect(issues).toHaveLength(2);
    expect(issues.rateLimits).toEqual(
      expect.objectContaining({
        cost: 4,
        cycleCost: 11,
        queryCosts: {
          ProjectItems: {
            requestCount: 2,
            cost: 11,
          },
        },
      })
    );
    expect(issues.map((issue) => issue.rateLimits)).toEqual([
      expect.objectContaining({ cost: 7 }),
      expect.objectContaining({ cost: 4 }),
    ]);
    expect(issues[0]?.rateLimits).not.toHaveProperty("cycleCost");
    expect(issues[1]?.rateLimits).not.toHaveProperty("cycleCost");
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
          repository: {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git",
          },
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
          repository: {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git",
          },
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
          repository: {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git",
          },
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
          repository: {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git",
          },
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
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
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
          expect(body.query).toMatch(
            /rateLimit\s*\{\s*cost\s+remaining\s+resetAt\s*\}/s
          );

          if (body.query.includes("query ProjectFields")) {
            expect(body.query).toContain("fields(first: 100)");
            return new Response(
              JSON.stringify({
                data: {
                  rateLimit: {
                    cost: 2,
                    remaining: 4998,
                    resetAt: "2026-03-19T04:00:00.000Z",
                  },
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
                rateLimit: {
                  cost: 11,
                  remaining: 4987,
                  resetAt: "2026-03-19T04:00:00.000Z",
                },
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
    expect(issues.rateLimits).toEqual(
      expect.objectContaining({
        cycleCost: 13,
        queryCosts: {
          ProjectFields: {
            requestCount: 1,
            cost: 2,
          },
          ProjectItems: {
            requestCount: 1,
            cost: 11,
          },
        },
      })
    );
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
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
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

  it("reuses project fields across listing cycles and priority field names", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
        priorityFieldName: "Priority",
      },
    });
    const severityAdapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
        priorityFieldName: "Severity",
      },
    });
    const project = {
      projectId: "workspace-1",
      slug: "workspace-1",
      workspaceDir: "/tmp/workspace-1",
      repository: {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
      tracker: {
        adapter: "github-project",
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
          priorityFieldName: "Priority",
        },
      },
    };
    let fieldQueryCount = 0;
    let itemsQueryCount = 0;
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string };

      if (body.query.includes("query ProjectFields")) {
        fieldQueryCount += 1;
        return new Response(
          JSON.stringify({
            data: {
              rateLimit: {
                cost: 2,
                remaining: 4998,
                resetAt: "2026-03-19T04:00:00.000Z",
              },
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
                      ],
                    },
                    {
                      __typename: "ProjectV2SingleSelectField",
                      name: "Severity",
                      options: [
                        { id: "severity-s0", name: "S0" },
                        { id: "severity-s1", name: "S1" },
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
      return new Response(
        JSON.stringify({
          data: {
            rateLimit: {
              cost: 11,
              remaining: 4987 - itemsQueryCount,
              resetAt: "2026-03-19T04:00:00.000Z",
            },
            node: {
              __typename: "ProjectV2",
              items: {
                nodes: [
                  makeProjectItem({
                    itemId: `item-${itemsQueryCount}`,
                    issueId: `issue-${itemsQueryCount}`,
                    number: itemsQueryCount,
                    title: `Prioritized issue ${itemsQueryCount}`,
                    assignees: [],
                    priorityOptionId:
                      itemsQueryCount === 2 ? "severity-s1" : "priority-p1",
                    priorityFieldName:
                      itemsQueryCount === 2 ? "Severity" : "Priority",
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
    });

    const firstIssues = await adapter.listIssues(project, {
      token: "dependencies-token",
      fetchImpl,
    });
    const secondIssues = await severityAdapter.listIssues(
      {
        ...project,
        tracker: {
          ...project.tracker,
          settings: {
            ...project.tracker.settings,
            priorityFieldName: "Severity",
          },
        },
      },
      {
        token: "dependencies-token",
        fetchImpl,
      }
    );
    const thirdIssues = await adapter.listIssues(project, {
      token: "dependencies-token",
      fetchImpl,
    });

    expect(fieldQueryCount).toBe(1);
    expect(itemsQueryCount).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(firstIssues[0]?.priority).toBe(1);
    expect(secondIssues[0]?.priority).toBe(1);
    expect(thirdIssues[0]?.priority).toBe(1);
    expect(firstIssues.rateLimits?.queryCosts).toEqual(
      expect.objectContaining({
        ProjectFields: {
          requestCount: 1,
          cost: 2,
        },
      })
    );
    expect(secondIssues.rateLimits?.queryCosts).not.toHaveProperty(
      "ProjectFields"
    );
    expect(thirdIssues.rateLimits?.queryCosts).not.toHaveProperty(
      "ProjectFields"
    );
  });

  it("uses explicit project-field mapping during listing without fetching option order", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      priority: {
        source: "project-field",
        field: "Priority",
        values: {
          High: 1,
          Low: 3,
        },
      },
      settings: {
        projectId: "project-123",
        priorityFieldName: "Priority",
      },
    });

    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      expect(body.query).not.toContain("query ProjectFields");

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
                    title: "Explicit priority issue",
                    assignees: [],
                    priorityName: "High",
                    priorityOptionId: "priority-low-order",
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
    });

    const issues = await adapter.listIssues(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          priority: {
            source: "project-field",
            field: "Priority",
            values: {
              High: 1,
              Low: 3,
            },
          },
          settings: {
            projectId: "project-123",
            priorityFieldName: "Priority",
          },
        },
      },
      {
        token: "dependencies-token",
        fetchImpl,
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(issues[0]?.priority).toBe(1);
  });

  it.each([
    ["https://api.github.com/graphql/", "https://api.github.com/user"],
    [
      "https://github.example/api/graphql",
      "https://github.example/api/v3/user",
    ],
    [
      "https://github.example/api/graphql/",
      "https://github.example/api/v3/user",
    ],
    [
      "https://github.example/api/v3/graphql",
      "https://github.example/api/v3/user",
    ],
  ])("resolves the REST user endpoint from %s", async (apiUrl, expectedUrl) => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      apiUrl,
      settings: {
        projectId: "project-123",
        assignedOnly: true,
      },
    });

    await adapter.listIssues(
      makeProjectConfig({
        apiUrl,
        trackerSettings: { assignedOnly: true },
      }),
      {
        token: "dependencies-token",
        fetchImpl: async (url, init) => {
          if (init?.method === "GET") {
            expect(String(url)).toBe(expectedUrl);
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
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
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

  it("reuses a shared project item cache across listIssues and listIssuesByStates", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const entries = new Map<string, Promise<TrackedIssue[]>>();
    const projectItemsCache: ProjectItemsCache = {
      getOrLoad(key, load) {
        const cached = entries.get(key);
        if (cached) {
          return cached;
        }

        const pending = load();
        entries.set(key, pending);
        return pending;
      },
    };
    const fetchImpl = vi.fn(
      async () =>
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
        )
    );

    const project = {
      projectId: "workspace-1",
      slug: "workspace-1",
      workspaceDir: "/tmp/workspace-1",
      repository: {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
      tracker: {
        adapter: "github-project" as const,
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
        },
      },
    };

    const listed = await adapter.listIssues(project, {
      token: "dependencies-token",
      fetchImpl,
      projectItemsCache,
    });
    const filtered = await adapter.listIssuesByStates(project, ["Done"], {
      token: "dependencies-token",
      fetchImpl,
      projectItemsCache,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(listed).toHaveLength(1);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.identifier).toBe(listed[0]?.identifier);
  });

  it("uses separate cache entries for filtered candidates and unfiltered state lookups", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });
    const entries = new Map<string, Promise<TrackedIssue[]>>();
    const projectItemsCache: ProjectItemsCache = {
      getOrLoad(key, load) {
        const cached = entries.get(key);
        if (cached) {
          return cached;
        }

        const pending = load();
        entries.set(key, pending);
        return pending;
      },
    };
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        variables: { query: string | null };
      };
      const filtered = body.variables.query !== null;
      return makeJsonResponse(
        makeProjectItemsPayload([
          makeProjectItem({
            itemId: filtered ? "item-ready" : "item-done",
            issueId: filtered ? "issue-ready" : "issue-done",
            number: filtered ? 1 : 2,
            title: filtered ? "Ready issue" : "Done issue",
            assignees: [],
            state: filtered ? "Ready" : "Done",
          }),
        ])
      );
    });
    const workflowLifecycle = {
      stateFieldName: "Status",
      activeStates: ["Ready", "In progress"],
      terminalStates: ["Done"],
      blockerCheckStates: ["Ready"],
      planningStates: ["Ready"],
    };

    const listed = await adapter.listIssues(makeProjectConfig(), {
      token: "dependencies-token",
      workflowLifecycle,
      fetchImpl,
      projectItemsCache,
    });
    const done = await adapter.listIssuesByStates(
      makeProjectConfig(),
      ["Done"],
      {
        token: "dependencies-token",
        workflowLifecycle,
        fetchImpl,
        projectItemsCache,
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(entries).toHaveProperty("size", 2);
    expect(listed.map((issue) => issue.state)).toEqual(["Ready"]);
    expect(done.map((issue) => issue.state)).toEqual(["Done"]);
  });

  it("uses a non-reversible token fingerprint in the shared project item cache key", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });
    const cacheKeys: string[] = [];
    const projectItemsCache: ProjectItemsCache = {
      getOrLoad(key, load) {
        cacheKeys.push(key);
        return load();
      },
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
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
        )
    );
    const project = {
      projectId: "workspace-1",
      slug: "workspace-1",
      workspaceDir: "/tmp/workspace-1",
      repository: {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
      tracker: {
        adapter: "github-project" as const,
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
        },
      },
    };

    await adapter.listIssues(project, {
      token: "secret-token-a",
      fetchImpl,
      projectItemsCache,
    });
    await adapter.listIssues(project, {
      token: "secret-token-b",
      fetchImpl,
      projectItemsCache,
    });

    expect(cacheKeys).toHaveLength(2);
    const firstKey = JSON.parse(cacheKeys[0] ?? "{}") as {
      tokenFingerprint?: string | null;
    };
    const secondKey = JSON.parse(cacheKeys[1] ?? "{}") as {
      tokenFingerprint?: string | null;
    };

    expect(firstKey.tokenFingerprint).toBe(
      createHash("sha256").update("secret-token-a").digest("hex")
    );
    expect(secondKey.tokenFingerprint).toBe(
      createHash("sha256").update("secret-token-b").digest("hex")
    );
    expect(firstKey.tokenFingerprint).not.toBe("secret-token-a");
    expect(secondKey.tokenFingerprint).not.toBe("secret-token-b");
    expect(firstKey.tokenFingerprint).not.toBe(secondKey.tokenFingerprint);
  });

  it("keys the shared project item cache with the resolved dependency token", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });
    const cacheKeys: string[] = [];
    const projectItemsCache: ProjectItemsCache = {
      getOrLoad(key, load) {
        cacheKeys.push(key);
        process.env.GITHUB_GRAPHQL_TOKEN = "mutated-env-token";
        return load();
      },
    };
    const fetchImpl = vi.fn(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer dependencies-token");

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
    });
    const project = {
      projectId: "workspace-1",
      slug: "workspace-1",
      workspaceDir: "/tmp/workspace-1",
      repository: {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
      tracker: {
        adapter: "github-project" as const,
        bindingId: "project-123",
        settings: {
          projectId: "project-123",
        },
      },
    };

    const previousToken = process.env.GITHUB_GRAPHQL_TOKEN;
    process.env.GITHUB_GRAPHQL_TOKEN = "initial-env-token";

    try {
      await adapter.listIssues(project, {
        token: "dependencies-token",
        fetchImpl,
        projectItemsCache,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(cacheKeys).toHaveLength(1);
      const cacheKey = JSON.parse(cacheKeys[0] ?? "{}") as {
        tokenFingerprint?: string | null;
      };
      expect(cacheKey.tokenFingerprint).toBe(
        createHash("sha256").update("dependencies-token").digest("hex")
      );
      expect(cacheKey.tokenFingerprint).not.toBe(
        createHash("sha256").update("mutated-env-token").digest("hex")
      );
    } finally {
      if (previousToken === undefined) {
        delete process.env.GITHUB_GRAPHQL_TOKEN;
      } else {
        process.env.GITHUB_GRAPHQL_TOKEN = previousToken;
      }
    }
  });

  it("fetches issue states by GraphQL issue ids using nodes lookup", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const issues = await adapter.fetchIssueStatesByIds(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          settings: {
            projectId: "project-123",
          },
        },
      },
      ["issue-1", "issue-2"],
      {
        token: "dependencies-token",
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as {
            query: string;
            variables: { issueIds: string[] };
          };

          expect(body.query).toContain(
            "query IssueStatesByIds($issueIds: [ID!]!)"
          );
          expect(body.query).toContain("nodes(ids: $issueIds)");
          expect(body.query).toContain(
            "projectItems(first: 100, includeArchived: true)"
          );
          expect(body.query).toContain("isArchived");
          expect(body.query).toContain("... on Issue");
          expect(body.query).toContain("... on PullRequest");
          expect(body.query).not.toContain("blockedBy(");
          expect(body.query).not.toContain("labels(");
          expect(body.query).not.toContain("assignees(");
          expect(body.variables.issueIds).toEqual(["issue-1", "issue-2"]);

          return new Response(
            JSON.stringify({
              data: {
                nodes: [
                  makeIssueStateLookupNode({
                    projectId: "project-123",
                    itemId: "item-1",
                    issueId: "issue-1",
                    number: 1,
                    title: "First issue",
                    state: "In Progress",
                  }),
                  makeIssueStateLookupNode({
                    projectId: "project-123",
                    itemId: "item-2",
                    issueId: "issue-2",
                    number: 2,
                    title: "Second issue",
                    state: "Done",
                  }),
                ],
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

    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.identifier)).toEqual([
      "acme/platform#1",
      "acme/platform#2",
    ]);
    expect(issues.map((issue) => issue.state)).toEqual(["In Progress", "Done"]);
  });

  it("returns archived issue states explicitly from the by-id lookup", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });
    const node = makeIssueStateLookupNode({
      projectId: "project-123",
      itemId: "item-archived",
      issueId: "issue-1",
      number: 1,
      title: "Archived issue",
      state: "In progress",
      isArchived: true,
    });
    node.projectItems.nodes[0]!.fieldValues.nodes = [];

    const issues = await adapter.fetchIssueStatesByIds(
      makeProjectConfig(),
      ["issue-1"],
      {
        token: "dependencies-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: { nodes: [node] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      state: "Archived",
      metadata: {
        isArchived: true,
      },
    });
  });

  it("fetches pull request states by GraphQL pull request ids", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const issues = await adapter.fetchIssueStatesByIds(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          settings: {
            projectId: "project-123",
          },
        },
      },
      ["pr-1"],
      {
        token: "dependencies-token",
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as {
            query: string;
            variables: { issueIds: string[] };
          };

          expect(body.query).toContain("... on PullRequest");
          expect(body.query).toContain("headRefName");
          expect(body.variables.issueIds).toEqual(["pr-1"]);

          return new Response(
            JSON.stringify({
              data: {
                nodes: [
                  makePullRequestStateLookupNode({
                    projectId: "project-123",
                    itemId: "item-pr-1",
                    pullRequestId: "pr-1",
                    number: 42,
                    state: "Ready",
                    headRefName: "feature/pr-card",
                  }),
                ],
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
    expect(issues[0]?.id).toBe("pr-1");
    expect(issues[0]?.identifier).toBe("acme/platform#42");
    expect(issues[0]?.state).toBe("Ready");
    expect(issues[0]?.branchName).toBe("feature/pr-card");
    expect(issues[0]?.url).toBe("https://github.com/acme/platform/pull/42");
    expect(issues[0]?.tracker.itemId).toBe("item-pr-1");
  });

  it("fails loudly when refreshed Project metadata omits the state field", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });
    const node = makeIssueStateLookupNode({
      projectId: "project-123",
      itemId: "item-missing-state",
      issueId: "issue-1",
      number: 1,
      title: "Missing state metadata",
      state: "Ready",
    });
    node.projectItems.nodes[0]!.fieldValues.nodes = [];

    await expect(
      adapter.fetchIssueStatesByIds(makeProjectConfig(), ["issue-1"], {
        token: "dependencies-token",
        fetchImpl: async () =>
          new Response(JSON.stringify({ data: { nodes: [node] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      })
    ).rejects.toThrow(
      'github_project_state_field_missing: Project item item-missing-state did not include configured state field "Status". Issue: acme/platform#1.'
    );
  });

  it("attaches GitHub API rate-limit headers to fetched issue state lookups", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const issues = await adapter.fetchIssueStatesByIds(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          settings: {
            projectId: "project-123",
          },
        },
      },
      ["issue-1"],
      {
        token: "dependencies-token",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              data: {
                nodes: [
                  makeIssueStateLookupNode({
                    projectId: "project-123",
                    itemId: "item-1",
                    issueId: "issue-1",
                    number: 1,
                    title: "Tracked issue",
                    state: "In Progress",
                  }),
                ],
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-ratelimit-limit": "5000",
                "x-ratelimit-remaining": "4988",
                "x-ratelimit-used": "12",
                "x-ratelimit-reset": "1773892860",
                "x-ratelimit-resource": "graphql",
              },
            }
          ),
      }
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.rateLimits).toEqual({
      source: "github",
      limit: 5000,
      remaining: 4988,
      used: 12,
      reset: 1773892860,
      resetAt: "2026-03-19T04:01:00.000Z",
      resource: "graphql",
    });
  });

  it("paginates issue projectItems until the configured project item is found", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: {
          issueIds?: string[];
          issueId?: string;
          cursor?: string | null;
        };
      };
      expect(body.query).toMatch(
        /rateLimit\s*\{\s*cost\s+remaining\s+resetAt\s*\}/s
      );

      if (body.query.includes("query IssueStatesByIds")) {
        return new Response(
          JSON.stringify({
            data: {
              rateLimit: {
                cost: 3,
                remaining: 4997,
                resetAt: "2026-03-19T04:00:00.000Z",
              },
              nodes: [
                makeIssueStateLookupNode({
                  projectId: "project-999",
                  itemId: "item-other",
                  issueId: "issue-1",
                  number: 1,
                  title: "First issue",
                  state: "Todo",
                  pageInfo: {
                    endCursor: "cursor-1",
                    hasNextPage: true,
                  },
                }),
              ],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }

      expect(body.query).toContain(
        "query IssueProjectItemsPage($issueId: ID!, $cursor: String)"
      );
      expect(body.query).toContain("... on PullRequest");
      expect(body.variables.issueId).toBe("issue-1");
      expect(body.variables.cursor).toBe("cursor-1");

      return new Response(
        JSON.stringify({
          data: {
            rateLimit: {
              cost: 2,
              remaining: 4995,
              resetAt: "2026-03-19T04:00:00.000Z",
            },
            node: {
              __typename: "Issue",
              id: "issue-1",
              number: 1,
              updatedAt: "2026-03-14T00:00:00.000Z",
              repository: {
                name: "platform",
                url: "https://github.com/acme/platform",
                owner: { login: "acme" },
              },
              projectItems: {
                nodes: [
                  {
                    id: "item-1",
                    updatedAt: "2026-03-14T00:01:00.000Z",
                    project: { id: "project-123" },
                    fieldValues: {
                      nodes: [
                        {
                          __typename: "ProjectV2ItemFieldSingleSelectValue",
                          name: "Done",
                          field: { name: "Status" },
                        },
                      ],
                    },
                  },
                ],
                pageInfo: {
                  endCursor: null,
                  hasNextPage: false,
                },
              },
            },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    });

    const issues = await adapter.fetchIssueStatesByIds(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          settings: {
            projectId: "project-123",
          },
        },
      },
      ["issue-1"],
      {
        token: "dependencies-token",
        fetchImpl,
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.tracker.itemId).toBe("item-1");
    expect(issues[0]?.state).toBe("Done");
    expect(issues.rateLimits).toEqual(
      expect.objectContaining({
        cycleCost: 5,
        queryCosts: {
          IssueStatesByIds: {
            requestCount: 1,
            cost: 3,
          },
          IssueProjectItemsPage: {
            requestCount: 1,
            cost: 2,
          },
        },
      })
    );
  });

  it("paginates pull request projectItems until the configured project item is found", async () => {
    const adapter = resolveTrackerAdapter({
      adapter: "github-project",
      bindingId: "project-123",
      settings: {
        projectId: "project-123",
      },
    });

    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        query: string;
        variables: {
          issueIds?: string[];
          issueId?: string;
          cursor?: string | null;
        };
      };

      if (body.query.includes("query IssueStatesByIds")) {
        return new Response(
          JSON.stringify({
            data: {
              nodes: [
                makePullRequestStateLookupNode({
                  projectId: "project-999",
                  itemId: "item-other",
                  pullRequestId: "pr-1",
                  number: 42,
                  state: "Todo",
                  headRefName: "feature/pr-card",
                  pageInfo: {
                    endCursor: "cursor-1",
                    hasNextPage: true,
                  },
                }),
              ],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      }

      expect(body.query).toContain(
        "query IssueProjectItemsPage($issueId: ID!, $cursor: String)"
      );
      expect(body.query).toContain("... on PullRequest");
      expect(body.variables.issueId).toBe("pr-1");
      expect(body.variables.cursor).toBe("cursor-1");

      return new Response(
        JSON.stringify({
          data: {
            node: {
              __typename: "PullRequest",
              id: "pr-1",
              number: 42,
              url: "https://github.com/acme/platform/pull/42",
              updatedAt: "2026-03-14T00:00:00.000Z",
              headRefName: "feature/pr-card",
              repository: {
                name: "platform",
                url: "https://github.com/acme/platform",
                owner: { login: "acme" },
              },
              projectItems: {
                nodes: [
                  {
                    id: "item-pr-1",
                    updatedAt: "2026-03-14T00:01:00.000Z",
                    project: { id: "project-123" },
                    fieldValues: {
                      nodes: [
                        {
                          __typename: "ProjectV2ItemFieldSingleSelectValue",
                          name: "Done",
                          field: { name: "Status" },
                        },
                      ],
                    },
                  },
                ],
                pageInfo: {
                  endCursor: null,
                  hasNextPage: false,
                },
              },
            },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    });

    const issues = await adapter.fetchIssueStatesByIds(
      {
        projectId: "workspace-1",
        slug: "workspace-1",
        workspaceDir: "/tmp/workspace-1",
        repository: {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          settings: {
            projectId: "project-123",
          },
        },
      },
      ["pr-1"],
      {
        token: "dependencies-token",
        fetchImpl,
      }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.tracker.itemId).toBe("item-pr-1");
    expect(issues[0]?.state).toBe("Done");
    expect(issues[0]?.branchName).toBe("feature/pr-card");
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

describe("pickup label filtering", () => {
  const adapter = resolveTrackerAdapter({
    adapter: "github-project",
    bindingId: "project-123",
  });
  const payload = makeProjectItemsPayload([
    makeProjectItem({
      itemId: "item-1",
      issueId: "issue-1",
      number: 1,
      title: "Alpha work",
      assignees: [],
      labels: ["alpha"],
    }),
    makeProjectItem({
      itemId: "item-2",
      issueId: "issue-2",
      number: 2,
      title: "Beta work",
      assignees: [],
      labels: ["beta"],
    }),
    makeProjectItem({
      itemId: "item-3",
      issueId: "issue-3",
      number: 3,
      title: "Unlabeled work",
      assignees: [],
    }),
  ]);

  it("lists only issues matching the configured pickup labels", async () => {
    const config = makeProjectConfig();
    config.tracker.settings = {
      ...config.tracker.settings,
      pickupLabels: { include: ["alpha"], exclude: ["beta"] },
    } as never;

    const issues = await adapter.listIssues(config, {
      token: "dependencies-token",
      fetchImpl: vi.fn(async () => makeJsonResponse(payload)),
    });

    expect(issues.map((issue) => issue.identifier)).toEqual([
      "acme/platform#1",
    ]);
  });

  it("keeps every issue when no pickup labels are configured", async () => {
    const issues = await adapter.listIssues(makeProjectConfig(), {
      token: "dependencies-token",
      fetchImpl: vi.fn(async () => makeJsonResponse(payload)),
    });

    expect(issues.map((issue) => issue.identifier)).toEqual([
      "acme/platform#1",
      "acme/platform#2",
      "acme/platform#3",
    ]);
  });

  it("preserves rate limit metadata on the filtered list", async () => {
    const config = makeProjectConfig();
    config.tracker.settings = {
      ...config.tracker.settings,
      pickupLabels: { include: ["alpha"], exclude: [] },
    } as never;

    const issues = await adapter.listIssues(config, {
      token: "dependencies-token",
      fetchImpl: vi.fn(async () => makeJsonResponse(payload)),
    });

    expect(issues.map((issue) => issue.identifier)).toEqual([
      "acme/platform#1",
    ]);
    expect("rateLimits" in issues).toBe(true);
  });

  it("preserves skipped-item metadata on the filtered list", async () => {
    const missingState = makeProjectItem({
      itemId: "item-missing-state",
      issueId: "issue-missing-state",
      number: 4,
      title: "Missing state",
      assignees: [],
      labels: ["alpha"],
    });
    missingState.fieldValues = { nodes: [] };
    const config = makeProjectConfig();
    config.tracker.settings = {
      ...config.tracker.settings,
      pickupLabels: { include: ["alpha"], exclude: [] },
    } as never;

    const issues = await adapter.listIssues(config, {
      token: "dependencies-token",
      fetchImpl: vi.fn(async () =>
        makeJsonResponse(
          makeProjectItemsPayload([
            ...payload.data.node.items.nodes,
            missingState,
          ])
        )
      ),
    });

    expect(issues.skippedItems).toEqual([
      {
        id: "item-missing-state",
        identifier: "acme/platform#4",
        reason: "missing Status",
      },
    ]);
  });
});

function makeProjectItem(input: {
  itemId: string;
  issueId: string;
  number: number;
  title: string;
  assignees: string[];
  state?: string;
  stateFieldName?: string;
  labels?: string[];
  priorityName?: string;
  priorityOptionId?: string;
  isArchived?: boolean;
  priorityFieldName?: string;
  repository?: {
    owner: string;
    name: string;
  };
}) {
  const repository = input.repository ?? { owner: "acme", name: "platform" };

  return {
    id: input.itemId,
    isArchived: input.isArchived ?? false,
    updatedAt: "2026-03-14T00:00:00.000Z",
    fieldValues: {
      nodes: [
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue" as const,
          name: input.state ?? "Todo",
          field: { name: input.stateFieldName ?? "Status" },
        },
        ...(input.priorityOptionId
          ? [
              {
                __typename: "ProjectV2ItemFieldSingleSelectValue" as const,
                name: input.priorityName ?? "P1",
                optionId: input.priorityOptionId,
                field: { name: input.priorityFieldName ?? "Priority" },
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
      url: `https://github.com/${repository.owner}/${repository.name}/issues/${input.number}`,
      createdAt: "2026-03-14T00:00:00.000Z",
      updatedAt: "2026-03-14T00:00:00.000Z",
      labels: {
        nodes: (input.labels ?? []).map((name) => ({ name })),
      },
      assignees: {
        nodes: input.assignees.map((login) => ({ login })),
      },
      repository: {
        name: repository.name,
        url: `https://github.com/${repository.owner}/${repository.name}`,
        owner: { login: repository.owner },
      },
      blockedBy: { nodes: [] },
    },
  };
}

function makeProjectItemsPayload(nodes: unknown[]) {
  return {
    data: {
      node: {
        __typename: "ProjectV2",
        items: {
          nodes,
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      },
    },
  };
}

function makeJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makePullRequestProjectItem(input: {
  itemId: string;
  pullRequestId: string;
  number: number;
  title: string;
  state?: string;
  headRepository?: {
    name: string;
    url: string;
    owner: { login: string };
  } | null;
}) {
  return {
    id: input.itemId,
    updatedAt: "2026-03-14T00:05:00.000Z",
    fieldValues: {
      nodes: [
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue" as const,
          name: input.state ?? "Todo",
          field: { name: "Status" },
        },
      ],
    },
    content: {
      __typename: "PullRequest" as const,
      id: input.pullRequestId,
      number: input.number,
      title: input.title,
      body: "PR body",
      url: `https://github.com/acme/platform/pull/${input.number}`,
      state: "OPEN",
      isDraft: false,
      merged: false,
      headRefName: "feature/pr-metadata",
      baseRefName: "main",
      headRepository:
        input.headRepository === undefined
          ? {
              name: "platform",
              url: "https://github.com/acme/platform",
              owner: { login: "acme" },
            }
          : input.headRepository,
      repository: {
        name: "platform",
        url: "https://github.com/acme/platform",
        owner: { login: "acme" },
      },
      createdAt: "2026-03-13T00:00:00.000Z",
      updatedAt: "2026-03-14T00:00:00.000Z",
    },
  };
}

function makeIssueStateLookupNode(input: {
  projectId: string;
  itemId: string;
  issueId: string;
  number: number;
  title: string;
  state: string;
  isArchived?: boolean;
  pageInfo?: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
}) {
  return {
    __typename: "Issue" as const,
    id: input.issueId,
    number: input.number,
    updatedAt: "2026-03-14T00:00:00.000Z",
    repository: {
      name: "platform",
      url: "https://github.com/acme/platform",
      owner: { login: "acme" },
    },
    projectItems: {
      nodes: [
        {
          id: input.itemId,
          isArchived: input.isArchived ?? false,
          updatedAt: "2026-03-14T00:00:00.000Z",
          project: { id: input.projectId },
          fieldValues: {
            nodes: [
              {
                __typename: "ProjectV2ItemFieldSingleSelectValue" as const,
                name: input.state,
                field: { name: "Status" },
              },
            ],
          },
        },
      ],
      pageInfo: input.pageInfo ?? {
        endCursor: null,
        hasNextPage: false,
      },
    },
  };
}

function makePullRequestStateLookupNode(input: {
  projectId: string;
  itemId: string;
  pullRequestId: string;
  number: number;
  state: string;
  isArchived?: boolean;
  headRefName?: string | null;
  pageInfo?: {
    endCursor: string | null;
    hasNextPage: boolean;
  };
}) {
  return {
    __typename: "PullRequest" as const,
    id: input.pullRequestId,
    number: input.number,
    url: `https://github.com/acme/platform/pull/${input.number}`,
    updatedAt: "2026-03-14T00:00:00.000Z",
    headRefName: input.headRefName ?? null,
    repository: {
      name: "platform",
      url: "https://github.com/acme/platform",
      owner: { login: "acme" },
    },
    projectItems: {
      nodes: [
        {
          id: input.itemId,
          isArchived: input.isArchived ?? false,
          updatedAt: "2026-03-14T00:00:00.000Z",
          project: { id: input.projectId },
          fieldValues: {
            nodes: [
              {
                __typename: "ProjectV2ItemFieldSingleSelectValue" as const,
                name: input.state,
                field: { name: "Status" },
              },
            ],
          },
        },
      ],
      pageInfo: input.pageInfo ?? {
        endCursor: null,
        hasNextPage: false,
      },
    },
  };
}

function makeProjectConfig(
  input: {
    apiUrl?: string;
    repository?: {
      owner: string;
      name: string;
    };
    trackerSettings?: Record<string, string | number | boolean | null>;
  } = {}
) {
  const repository = input.repository ?? { owner: "acme", name: "platform" };

  return {
    projectId: "tenant-1",
    slug: "tenant-1",
    workspaceDir: "/tmp/workspaces/tenant-1",
    repository: {
      owner: repository.owner,
      name: repository.name,
      cloneUrl: `https://github.com/${repository.owner}/${repository.name}.git`,
    },
    tracker: {
      adapter: "github-project" as const,
      bindingId: "project-123",
      ...(input.apiUrl ? { apiUrl: input.apiUrl } : {}),
      settings: {
        projectId: "project-123",
        ...input.trackerSettings,
      },
    },
  };
}

function makeTrackedIssue(): TrackedIssue {
  return {
    id: "issue-1",
    identifier: "acme/platform#1",
    number: 1,
    title: "Test issue",
    description: null,
    priority: null,
    state: "In review",
    branchName: null,
    url: "https://github.com/acme/platform/issues/1",
    labels: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null,
    repository: {
      owner: "acme",
      name: "platform",
      cloneUrl: "https://github.com/acme/platform.git",
    },
    tracker: {
      adapter: "github-project",
      bindingId: "project-123",
      itemId: "item-1",
    },
    metadata: {
      contentType: "Issue",
    },
  };
}
