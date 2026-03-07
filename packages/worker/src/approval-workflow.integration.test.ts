import { describe, expect, it } from "vitest";
import {
  executeImplementationPhase,
  executePlanningPhase,
  type ApprovalWorkflowClient,
  type ApprovalWorkflowComment,
  type ApprovalWorkflowIssue,
  type ApprovalWorkflowPullRequest
} from "./approval-workflow.js";
import { DEFAULT_WORKFLOW_LIFECYCLE } from "./workflow-lifecycle.js";

describe("approval workflow integration", () => {
  it("hands planning off for human review without duplicating comments on retry", async () => {
    const client = createMemoryApprovalClient();
    const issue = createIssue({
      state: "Todo"
    });

    const firstResult = await executePlanningPhase(
      {
        issue,
        lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
        report: {
          summary: "Investigate the issue and stage the implementation.",
          steps: ["Inspect the worker workflow", "Document the implementation plan"]
        }
      },
      client
    );
    const secondResult = await executePlanningPhase(
      {
        issue,
        lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
        report: {
          summary: "Investigate the issue and stage the implementation.",
          steps: ["Inspect the worker workflow", "Document the implementation plan"]
        }
      },
      client
    );

    expect(firstResult.nextState).toBe("Human Review");
    expect(client.comments).toHaveLength(1);
    expect(client.projectStateUpdates).toEqual(["Human Review", "Human Review"]);
    expect(secondResult.operations).toContain("updated planning comment");
  });

  it("resumes after approval, upserts a pull request, and transitions to awaiting merge", async () => {
    const client = createMemoryApprovalClient();
    const issue = createIssue({
      state: "Approved"
    });

    const firstResult = await executeImplementationPhase(
      {
        issue,
        lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
        report: {
          summary: "Implemented the approval-aware worker loop.",
          validation: ["pnpm test --filter @github-symphony/worker"]
        }
      },
      client
    );
    const secondResult = await executeImplementationPhase(
      {
        issue,
        lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
        report: {
          summary: "Implemented the approval-aware worker loop.",
          validation: ["pnpm test --filter @github-symphony/worker"]
        }
      },
      client
    );

    expect(firstResult.pullRequest?.url).toContain("/pull/");
    expect(firstResult.nextState).toBe("Await Merge");
    expect(client.pullRequests).toHaveLength(1);
    expect(secondResult.operations).toContain("updated pull request");
    expect(client.projectStateUpdates.slice(-1)[0]).toBe("Await Merge");
  });
});

function createIssue(overrides: Partial<ApprovalWorkflowIssue>): ApprovalWorkflowIssue {
  return {
    id: "issue-1",
    number: 42,
    title: "Implement approval workflow",
    body: "Ship the workflow",
    url: "https://github.com/acme/platform/issues/42",
    state: "Todo",
    projectId: "project-1",
    projectItemId: "project-item-1",
    repository: {
      owner: "acme",
      name: "platform",
      defaultBranch: "main"
    },
    ...overrides
  };
}

function createMemoryApprovalClient(): ApprovalWorkflowClient & {
  comments: ApprovalWorkflowComment[];
  pullRequests: ApprovalWorkflowPullRequest[];
  projectStateUpdates: string[];
} {
  const comments: ApprovalWorkflowComment[] = [];
  const pullRequests: ApprovalWorkflowPullRequest[] = [];
  const projectStateUpdates: string[] = [];

  return {
    comments,
    pullRequests,
    projectStateUpdates,
    async findIssueCommentByMarker(_issueId, marker) {
      return comments.find((comment) => comment.body.includes(marker)) ?? null;
    },
    async createIssueComment(_issueId, body) {
      const comment = {
        id: `comment-${comments.length + 1}`,
        body
      };
      comments.push(comment);
      return comment;
    },
    async updateIssueComment(commentId, body) {
      const index = comments.findIndex((comment) => comment.id === commentId);
      comments[index] = {
        ...comments[index],
        body
      };
      return comments[index]!;
    },
    async updateProjectItemState(input) {
      projectStateUpdates.push(input.state);
    },
    async findPullRequestByBranch(input) {
      return pullRequests.find((pullRequest) => pullRequest.headBranch === input.branchName) ?? null;
    },
    async createPullRequest(input) {
      const pullRequest = {
        id: `pr-${pullRequests.length + 1}`,
        number: pullRequests.length + 1,
        url: `https://github.com/${input.owner}/${input.repository}/pull/${pullRequests.length + 1}`,
        headBranch: input.headBranch,
        title: input.title,
        body: input.body
      };
      pullRequests.push(pullRequest);
      return pullRequest;
    },
    async updatePullRequest(input) {
      const index = pullRequests.findIndex((pullRequest) => pullRequest.id === input.pullRequestId);
      pullRequests[index] = {
        ...pullRequests[index],
        title: input.title,
        body: input.body
      };
      return pullRequests[index]!;
    }
  };
}
