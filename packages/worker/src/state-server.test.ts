import { describe, expect, it, vi } from "vitest";
import {
  buildWorkerRuntimeState,
  createWorkerRequestHandler,
} from "./state-server.js";
import { DEFAULT_WORKFLOW_LIFECYCLE } from "./workflow-lifecycle.js";

describe("buildWorkerRuntimeState", () => {
  it("uses mounted workflow metadata when available", async () => {
    const state = await buildWorkerRuntimeState(
      {
        GITHUB_PROJECT_ID: "project-123",
        WORKSPACE_RUNTIME_DIR: "/workspace-runtime",
      },
      vi.fn().mockResolvedValue(`---
tracker:
  kind: github-project
  project_id: project-123
  state_field: Status
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
  blocker_check_states:
    - Todo
codex:
  command: codex app-server
hooks:
  after_create: hooks/after_create.sh
---
Prefer small changes.
`)
    );

    expect(state.workflow).toEqual({
      githubProjectId: "project-123",
      agentCommand: "codex app-server",
      hookPath: "hooks/after_create.sh",
      lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
    });
    expect(state.executionPhase).toBeNull();
    expect(state.runPhase).toBeNull();
    expect(state.sessionId).toBeNull();
  });

  it("falls back to environment metadata when workflow is missing", async () => {
    const state = await buildWorkerRuntimeState(
      {
        GITHUB_PROJECT_ID: "project-123",
      },
      vi.fn().mockRejectedValue(new Error("missing"))
    );

    expect(state.projectId).toBe("project-123");
    expect(state.workflow).toBeNull();
    expect(state.executionPhase).toBeNull();
    expect(state.runPhase).toBeNull();
    expect(state.sessionId).toBeNull();
  });

  it("surfaces assigned run metadata from the orchestrator", async () => {
    const state = await buildWorkerRuntimeState(
      {
        GITHUB_PROJECT_ID: "project-123",
        WORKING_DIRECTORY: "/workspace-runtime/repository",
        SYMPHONY_RUN_ID: "run-1",
        SYMPHONY_ISSUE_ID: "issue-1",
        SYMPHONY_ISSUE_IDENTIFIER: "acme/platform#1",
        SYMPHONY_ISSUE_STATE: "Todo",
        TARGET_REPOSITORY_OWNER: "acme",
        TARGET_REPOSITORY_NAME: "platform",
        TARGET_REPOSITORY_CLONE_URL: "https://github.com/acme/platform.git",
      },
      vi.fn().mockResolvedValue(`---
tracker:
  kind: github-project
codex:
  command: codex app-server
---
Prefer small changes.
`)
    );

    expect(state.run).toEqual({
      runId: "run-1",
      issueId: "issue-1",
      issueIdentifier: "acme/platform#1",
      state: "Todo",
      processId: null,
      repository: {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
        url: null,
      },
      lastError: null,
    });
    expect(state.executionPhase).toBeNull();
    expect(state.runPhase).toBeNull();
    expect(state.sessionId).toBeNull();
  });

  it("includes runtime execution and run phase metadata when provided", async () => {
    const state = await buildWorkerRuntimeState(
      {
        GITHUB_PROJECT_ID: "project-123",
      },
      vi.fn().mockRejectedValue(new Error("missing")),
      {
        status: "running",
        executionPhase: "implementation",
        runPhase: "streaming_turn",
        sessionId: "thread-1-turn-1",
        sessionInfo: {
          threadId: "thread-1",
          turnId: "turn-1",
          turnCount: 1,
          sessionId: "thread-1-turn-1",
        },
      }
    );

    expect(state.status).toBe("running");
    expect(state.executionPhase).toBe("implementation");
    expect(state.runPhase).toBe("streaming_turn");
    expect(state.sessionId).toBe("thread-1-turn-1");
    expect(state.sessionInfo).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      turnCount: 1,
      sessionId: "thread-1-turn-1",
    });
  });
});

describe("createWorkerRequestHandler", () => {
  it("serves state payloads from /api/v1/state", async () => {
    const response = createMockResponse();
    const handler = createWorkerRequestHandler(async () => ({
      package: "@gh-symphony/worker",
      runtime: "self-hosted-sample",
      status: "idle",
      executionPhase: "planning",
      runPhase: "streaming_turn",
      sessionId: "thread-1-turn-1",
      projectId: "project-123",
      workspaceRuntimeDir: "/workspace-runtime",
      run: null,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      sessionInfo: {
        threadId: "thread-1",
        turnId: "turn-1",
        turnCount: 1,
        sessionId: "thread-1-turn-1",
      },
      workflow: null,
    }));

    await handler(
      {
        url: "/api/v1/state",
      } as never,
      response as never
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"projectId":"project-123"');
    expect(response.body).toContain('"executionPhase":"planning"');
    expect(response.body).toContain('"runPhase":"streaming_turn"');
    expect(response.body).toContain('"sessionId":"thread-1-turn-1"');
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
    },
  };
}
