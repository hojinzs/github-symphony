import { describe, expect, it, vi } from "vitest";
import {
  buildWorkerRuntimeState,
  createWorkerRequestHandler
} from "./state-server.js";
import { DEFAULT_WORKFLOW_LIFECYCLE } from "./workflow-lifecycle.js";

describe("buildWorkerRuntimeState", () => {
  it("uses mounted workflow metadata when available", async () => {
    const state = await buildWorkerRuntimeState(
      {
        GITHUB_PROJECT_ID: "project-123",
        WORKSPACE_RUNTIME_DIR: "/workspace-runtime"
      },
      vi.fn().mockResolvedValue(`---
github_project_id: project-123
allowed_repositories:
  - https://github.com/acme/platform.git
lifecycle:
  state_field: Status
  planning_active:
    - Todo
    - Needs Plan
  human_review:
    - Human Review
  implementation_active:
    - Approved
    - Ready to Implement
  awaiting_merge:
    - Await Merge
  completed:
    - Done
  transitions:
    planning_complete: Human Review
    implementation_complete: Await Merge
    merge_complete: Done
runtime:
  agent_command: bash -lc codex app-server
hooks:
  after_create: hooks/after_create.sh
---
Prefer small changes.
`)
    );

    expect(state.workflow).toEqual({
      githubProjectId: "project-123",
      agentCommand: "bash -lc codex app-server",
      hookPath: "hooks/after_create.sh",
      lifecycle: DEFAULT_WORKFLOW_LIFECYCLE
    });
    expect(state.allowedRepositories).toEqual([
      "https://github.com/acme/platform.git"
    ]);
  });

  it("falls back to environment metadata when workflow is missing", async () => {
    const state = await buildWorkerRuntimeState(
      {
        GITHUB_PROJECT_ID: "project-123",
        WORKSPACE_ALLOWED_REPOSITORIES:
          "https://github.com/acme/platform.git,https://github.com/acme/api.git"
      },
      vi.fn().mockRejectedValue(new Error("missing"))
    );

    expect(state.projectId).toBe("project-123");
    expect(state.allowedRepositories).toHaveLength(2);
    expect(state.workflow).toBeNull();
  });

  it("surfaces assigned run metadata from the orchestrator", async () => {
    const state = await buildWorkerRuntimeState(
      {
        GITHUB_PROJECT_ID: "project-123",
        WORKING_DIRECTORY: "/workspace-runtime/repository",
        SYMPHONY_RUN_ID: "run-1",
        SYMPHONY_ISSUE_ID: "issue-1",
        SYMPHONY_ISSUE_IDENTIFIER: "acme/platform#1",
        SYMPHONY_RUN_PHASE: "planning",
        TARGET_REPOSITORY_OWNER: "acme",
        TARGET_REPOSITORY_NAME: "platform",
        TARGET_REPOSITORY_CLONE_URL: "https://github.com/acme/platform.git"
      },
      vi.fn().mockResolvedValue(`---
runtime:
  agent_command: bash -lc codex app-server
---
Prefer small changes.
`)
    );

    expect(state.run).toEqual({
      runId: "run-1",
      issueId: "issue-1",
      issueIdentifier: "acme/platform#1",
      phase: "planning",
      processId: null,
      repository: {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
        url: null
      },
      lastError: null
    });
  });
});

describe("createWorkerRequestHandler", () => {
  it("serves state payloads from /api/v1/state", async () => {
    const response = createMockResponse();
    const handler = createWorkerRequestHandler(async () => ({
      package: "@github-symphony/worker",
      runtime: "self-hosted-sample",
      status: "idle",
      projectId: "project-123",
      workspaceRuntimeDir: "/workspace-runtime",
      allowedRepositories: [],
      run: null,
      workflow: null
    }));

    await handler(
      {
        url: "/api/v1/state"
      } as never,
      response as never
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"projectId":"project-123"');
  });
});

function createMockResponse() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(statusCode: number, headers: Record<string, string>) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk: string) {
      this.body = chunk;
    }
  };
}
