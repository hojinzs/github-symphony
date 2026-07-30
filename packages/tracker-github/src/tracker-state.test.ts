import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestGithubProjectItemState,
  resetGitHubRateLimitCacheForTests,
  type GitHubTrackerConfig,
} from "./adapter.js";

const config: GitHubTrackerConfig = {
  projectId: "project-1",
  token: "token-1",
};

afterEach(() => {
  resetGitHubRateLimitCacheForTests();
  vi.restoreAllMocks();
});

describe("requestGithubProjectItemState", () => {
  it("serializes five exact-item transitions without listing the board", async () => {
    const states = new Map(
      Array.from({ length: 5 }, (_, index) => [
        `item-${index + 1}`,
        "In progress",
      ])
    );
    const seenQueries: string[] = [];
    const seenItemIds: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, string>;
        };
        seenQueries.push(body.query);
        if (body.variables.itemId) {
          seenItemIds.push(body.variables.itemId);
        }
        const response = graphqlResponse(body.query, body.variables, states);
        inFlight -= 1;
        return response;
      }
    ) as typeof fetch;

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        requestGithubProjectItemState(
          config,
          {
            issueSubjectId: `issue-${index + 1}`,
            itemId: `item-${index + 1}`,
            request: {
              type: "transition-request",
              expectedState: "In progress",
              targetState: "In review",
              reason: `worker ${index + 1} completed`,
            },
          },
          fetchImpl
        )
      )
    );

    expect(results).toHaveLength(5);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.every((result) => result.state === "In review")).toBe(true);
    expect(results.every((result) => result.rateLimits?.cycleCost === 4)).toBe(
      true
    );
    expect(maxInFlight).toBe(1);
    expect(seenQueries).toHaveLength(20);
    expect(seenQueries.join("\n")).not.toContain("query ProjectItems");
    expect(new Set(seenItemIds)).toEqual(
      new Set(["item-1", "item-2", "item-3", "item-4", "item-5"])
    );
  });

  it("rejects an expected-state mismatch before mutation", async () => {
    const states = new Map([["item-1", "Ready"]]);
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, string>;
        };
        return graphqlResponse(body.query, body.variables, states);
      }
    ) as typeof fetch;

    const result = await requestGithubProjectItemState(
      config,
      {
        issueSubjectId: "issue-1",
        itemId: "item-1",
        request: {
          type: "transition-request",
          expectedState: "In progress",
          targetState: "In review",
          reason: "handoff",
        },
      },
      fetchImpl
    );

    expect(result).toMatchObject({
      ok: false,
      outcome: "expected_state_mismatch",
      state: "Ready",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries a rate-limited mutation and confirms exact-item readback", async () => {
    const states = new Map([["item-1", "In progress"]]);
    let mutationAttempts = 0;
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, string>;
        };
        if (body.query.includes("mutation UpdateProjectItemState")) {
          mutationAttempts += 1;
          if (mutationAttempts === 1) {
            return new Response("rate limit exceeded", {
              status: 429,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(Math.floor(Date.now() / 1_000)),
              },
            });
          }
        }
        return graphqlResponse(body.query, body.variables, states);
      }
    ) as typeof fetch;

    const result = await requestGithubProjectItemState(
      config,
      {
        issueSubjectId: "issue-1",
        itemId: "item-1",
        request: {
          type: "transition-request",
          expectedState: "In progress",
          targetState: "In review",
          reason: "handoff",
        },
      },
      fetchImpl
    );

    expect(mutationAttempts).toBe(2);
    expect(result).toMatchObject({
      ok: true,
      outcome: "confirmed",
      state: "In review",
    });
  });

  it("rejects an exact item that does not belong to the run issue", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        data: {
          rateLimit: rateLimit(),
          node: {
            __typename: "ProjectV2Item",
            id: "item-1",
            project: { id: "project-1" },
            content: { id: "different-issue" },
            fieldValues: { nodes: [statusFieldValue("In progress")] },
          },
        },
      })
    ) as typeof fetch;

    await expect(
      requestGithubProjectItemState(
        config,
        {
          issueSubjectId: "issue-1",
          itemId: "item-1",
          request: { type: "state-read" },
        },
        fetchImpl
      )
    ).rejects.toThrow("tracker_item_authorization_mismatch");
  });
});

function graphqlResponse(
  query: string,
  variables: Record<string, string>,
  states: Map<string, string>
): Response {
  if (query.includes("query ExactProjectItemState")) {
    const itemId = variables.itemId;
    const issueId = itemId.replace("item-", "issue-");
    return jsonResponse({
      data: {
        rateLimit: rateLimit(),
        node: {
          __typename: "ProjectV2Item",
          id: itemId,
          project: { id: "project-1" },
          content: { id: issueId },
          fieldValues: {
            nodes: [statusFieldValue(states.get(itemId) ?? "unknown")],
          },
        },
      },
    });
  }
  if (query.includes("query ProjectFields")) {
    return jsonResponse({
      data: {
        rateLimit: rateLimit(),
        node: {
          __typename: "ProjectV2",
          fields: {
            nodes: [
              {
                __typename: "ProjectV2SingleSelectField",
                id: "status-field",
                name: "Status",
                options: [
                  { id: "in-progress", name: "In progress" },
                  { id: "in-review", name: "In review" },
                ],
              },
            ],
          },
        },
      },
    });
  }
  if (query.includes("mutation UpdateProjectItemState")) {
    states.set(variables.itemId, "In review");
    return jsonResponse({
      data: {
        rateLimit: rateLimit(),
        updateProjectV2ItemFieldValue: {
          projectV2Item: { id: variables.itemId },
        },
      },
    });
  }
  throw new Error(`Unexpected GraphQL operation: ${query.slice(0, 80)}`);
}

function statusFieldValue(name: string) {
  return {
    __typename: "ProjectV2ItemFieldSingleSelectValue",
    name,
    optionId: name.toLowerCase().replaceAll(" ", "-"),
    field: { name: "Status" },
  };
}

function rateLimit() {
  return {
    cost: 1,
    remaining: 4_000,
    resetAt: "2026-07-30T14:00:00.000Z",
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-ratelimit-limit": "5_000",
      "x-ratelimit-remaining": "4_000",
      "x-ratelimit-resource": "graphql",
    },
  });
}
