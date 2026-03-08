import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentCredentialProvider,
  AgentCredentialStatus,
  WorkspaceAgentCredentialSource
} from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWorkspaceDashboard } from "./dashboard-service";
import { createWorkspaceIssue } from "./github-projects";
import { createIssueForWorkspace, parseCreateIssueInput } from "./issue-service";
import { createMemoryDatabase } from "./test-harness";
import { parseCreateWorkspaceInput } from "./workspace-service";
import { provisionWorkspace } from "./workspace-orchestrator";
import { prepareCodexRuntimePlan } from "../../../packages/worker/src/runtime";
import {
  executeImplementationPhase,
  executePlanningPhase,
  hasMergedCompletionSignal,
  type ApprovalWorkflowClient,
  type ApprovalWorkflowComment,
  type ApprovalWorkflowIssue,
  type ApprovalWorkflowPullRequest
} from "../../../packages/worker/src/approval-workflow";
import { DEFAULT_WORKFLOW_LIFECYCLE } from "../../../packages/worker/src/workflow-lifecycle";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0, tempPaths.length).map((path) =>
      rm(path, {
        recursive: true,
        force: true
      })
    )
  );
});

describe("Platform end-to-end flow", () => {
  it("covers auth, planning handoff, approval-triggered implementation, PR reporting, and merge completion", async () => {
    const { db } = createMemoryDatabase();
    const seededCredential = await db.agentCredential.create({
      data: {
        label: "Platform default",
        provider: AgentCredentialProvider.openai,
        encryptedSecret: "encrypted-agent-secret",
        secretFingerprint: "fingerprint-platform-default",
        status: AgentCredentialStatus.ready,
        lastValidatedAt: new Date("2026-03-07T08:30:00.000Z"),
        degradedReason: null
      }
    });
    await db.platformAgentCredentialConfig.upsert({
      where: {
        singletonKey: "system"
      },
      update: {
        defaultAgentCredentialId: seededCredential.id
      },
      create: {
        singletonKey: "system",
        defaultAgentCredentialId: seededCredential.id
      }
    });
    const runtimeRoot = mkdtempSync(join(tmpdir(), "github-symphony-e2e-"));
    tempPaths.push(runtimeRoot);

    let latestProjectItemState = "Todo";
    const graphFetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      const body = JSON.parse(String(init?.body ?? "{}")) as {
        query?: string;
      };
      const query = body.query ?? "";

      if (query.includes("query ResolveOrganization")) {
        return new Response(
          JSON.stringify({
            data: {
              organization: { id: "owner-1" }
            }
          }),
          { status: 200 }
        );
      }

      if (query.includes("mutation CreateProject")) {
        return new Response(
          JSON.stringify({
            data: {
              createProjectV2: {
                projectV2: {
                  id: "project-1",
                  number: 7,
                  title: "Platform Workspace",
                  url: "https://github.com/orgs/acme/projects/7"
                }
              }
            }
          }),
          { status: 200 }
        );
      }

      if (query.includes("query ResolveRepository")) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                id: "repo-1"
              }
            }
          }),
          { status: 200 }
        );
      }

      if (query.includes("mutation CreateIssue")) {
        return new Response(
          JSON.stringify({
            data: {
              createIssue: {
                issue: {
                  id: "issue-1",
                  number: 99,
                  url: "https://github.com/acme/platform/issues/99"
                }
              }
            }
          }),
          { status: 200 }
        );
      }

      if (query.includes("mutation AddProjectItem")) {
        return new Response(
          JSON.stringify({
            data: {
              addProjectV2ItemById: {
                item: {
                  id: "project-item-1"
                }
              }
            }
          }),
          { status: 200 }
        );
      }

      throw new Error(`Unhandled request: ${url}`);
    });

    const docker = {
      createContainer: vi.fn().mockResolvedValue({
        id: "container-1",
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          State: {
            Running: true,
            Status: "running"
          }
        })
      }),
      getContainer: vi.fn()
    };
    const credentialBroker = vi.fn().mockResolvedValue({
      token: "ghp_machine_user",
      expiresAt: new Date("2026-03-07T11:00:00.000Z"),
      installationId: null,
      ownerLogin: "acme",
      ownerType: "Organization",
      provider: "pat_classic",
      source: "pat",
      actorLogin: "machine-user",
      tokenFingerprint: "pat-fingerprint"
    });

    const workspaceInput = parseCreateWorkspaceInput({
      name: "Platform Workspace",
      promptGuidelines: "Prefer small changes",
      repositories: [
        {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git"
        }
      ],
      agentCredentialSource: WorkspaceAgentCredentialSource.platform_default
    });

    const { workspace, runtime } = await provisionWorkspace(workspaceInput, {
      db,
      fetchImpl: graphFetch as typeof fetch,
      docker,
      runtimeRoot,
      portAllocator: async () => 4510,
      credentialBroker,
      runtimeAuthEnv: {
        WORKSPACE_RUNTIME_AUTH_SECRET: "runtime-auth-secret"
      }
    });

    const issueInput = parseCreateIssueInput({
      workspaceId: workspace.id,
      repositoryOwner: "acme",
      repositoryName: "platform",
      title: "Close the loop",
      body: "Mark the project item done when work completes."
    });

    const issue = await createIssueForWorkspace(issueInput, {
      db,
      credentialBroker,
      createWorkspaceIssueImpl: (token, input) =>
        createWorkspaceIssue(token, input, graphFetch as typeof fetch)
    });

    const runtimePlan = await prepareCodexRuntimePlan(
      {
        workspaceId: workspace.id,
        workingDirectory: runtime.workspaceRuntimeDir,
        githubTokenBrokerUrl:
          "http://host.docker.internal:3000/api/workspaces/workspace-1/runtime-credentials",
        githubTokenBrokerSecret: "runtime-secret",
        githubTokenCachePath: "/workspace-runtime/.github-token.json",
        agentCredentialBrokerUrl:
          "http://host.docker.internal:3000/api/workspaces/workspace-1/agent-credentials",
        agentCredentialBrokerSecret: "runtime-secret",
        githubProjectId: workspace.githubProjectId ?? undefined
      },
      {
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              env: {
                OPENAI_API_KEY: "sk-e2e-agent"
              }
            }),
            { status: 200 }
          )
        ) as unknown as typeof fetch
      }
    );

    expect(runtimePlan.command).toBe("bash");
    expect(runtimePlan.tools[0].name).toBe("github_graphql");
    expect(runtimePlan.env.OPENAI_API_KEY).toBe("sk-e2e-agent");
    const approvalClient = createMemoryApprovalClient((state) => {
      latestProjectItemState = state;
    });
    const approvalIssue = createApprovalIssue({
      issueId: issue.id,
      issueNumber: issue.number,
      issueTitle: issueInput.title,
      issueBody: issueInput.body,
      issueUrl: issue.url,
      projectId: workspace.githubProjectId ?? "project-1",
      projectItemId: issue.projectItemId
    });
    const planningResult = await executePlanningPhase(
      {
        issue: approvalIssue,
        lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
        report: {
          summary: "Outlined the implementation before code changes.",
          steps: ["Inspect the repository", "Prepare the implementation plan"],
          risks: ["Repository policy settings must permit linked issue closure"]
        }
      },
      approvalClient
    );

    expect(planningResult.nextState).toBe("Human Review");
    expect(latestProjectItemState).toBe("Human Review");

    const implementationResult = await executeImplementationPhase(
      {
        issue: {
          ...approvalIssue,
          state: "Approved"
        },
        lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
        report: {
          summary: "Implemented the approval-gated delivery flow.",
          validation: ["pnpm test --filter control-plane"],
          followUps: ["Confirm repository linked-issue settings stay enabled"]
        }
      },
      approvalClient
    );

    expect(implementationResult.pullRequest?.url).toContain("/pull/");
    expect(implementationResult.pullRequest?.body).toContain(`Fixes #${issue.number}`);
    expect(latestProjectItemState).toBe("Await Merge");

    latestProjectItemState = "Done";
    expect(
      hasMergedCompletionSignal(latestProjectItemState, DEFAULT_WORKFLOW_LIFECYCLE)
    ).toBe(true);

    const dashboard = await loadWorkspaceDashboard(
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            issueNumber: issue.number,
            projectItemState: latestProjectItemState,
            planCommentId: approvalClient.comments[0]?.id ?? null,
            pullRequestUrl: implementationResult.pullRequest?.url ?? null
          }),
          { status: 200 }
        )
      ) as unknown as Promise<Response> as unknown as typeof fetch,
      db,
      {
        syncWorkspaceRuntimeStatusImpl: vi.fn().mockResolvedValue("running")
      }
    );

    expect(issue.url).toContain("/issues/99");
    expect(latestProjectItemState).toBe("Done");
    expect(dashboard[0]?.runtime).toMatchObject({
      driver: "docker",
      health: "healthy",
      status: "running",
      port: 4510,
      state: {
        issueNumber: 99,
        projectItemState: "Done",
        pullRequestUrl: implementationResult.pullRequest?.url
      }
    });
    expect(dashboard[0]?.agentCredential.status).toBe("ready");
  });
});

function createApprovalIssue(input: {
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueUrl: string;
  projectId: string;
  projectItemId: string;
}): ApprovalWorkflowIssue {
  return {
    id: input.issueId,
    number: input.issueNumber,
    title: input.issueTitle,
    body: input.issueBody,
    url: input.issueUrl,
    state: "Todo",
    projectId: input.projectId,
    projectItemId: input.projectItemId,
    repository: {
      owner: "acme",
      name: "platform",
      defaultBranch: "main"
    }
  };
}

function createMemoryApprovalClient(
  onStateChange: (state: string) => void
): ApprovalWorkflowClient & {
  comments: ApprovalWorkflowComment[];
  pullRequests: ApprovalWorkflowPullRequest[];
} {
  const comments: ApprovalWorkflowComment[] = [];
  const pullRequests: ApprovalWorkflowPullRequest[] = [];

  return {
    comments,
    pullRequests,
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
      onStateChange(input.state);
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
