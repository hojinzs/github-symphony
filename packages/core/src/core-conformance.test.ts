import { describe, expect, it } from "vitest";
import {
  buildHookEnv,
  buildPromptVariables,
  buildWorkspaceSnapshot,
  calculateRetryDelay,
  DEFAULT_WORKFLOW_LIFECYCLE,
  deriveIssueWorkspaceKey,
  isWorkflowPhaseActionable,
  isWorkflowPhaseTerminal,
  renderPrompt,
  resolveIssueRepositoryPath,
  resolveIssueWorkspaceDirectory,
  resolveWorkflowExecutionPhase,
  scheduleRetryAt,
} from "./index.js";

describe("deriveIssueWorkspaceKey", () => {
  it("produces a stable deterministic key", () => {
    const identity = {
      workspaceId: "ws-1",
      adapter: "github-project",
      issueSubjectId: "issue-abc",
    };

    const key1 = deriveIssueWorkspaceKey(identity);
    const key2 = deriveIssueWorkspaceKey(identity);

    expect(key1).toBe(key2);
    expect(key1).toHaveLength(16);
    expect(key1).toMatch(/^[a-f0-9]{16}$/);
  });

  it("produces different keys for different identities", () => {
    const keyA = deriveIssueWorkspaceKey({
      workspaceId: "ws-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
    });
    const keyB = deriveIssueWorkspaceKey({
      workspaceId: "ws-1",
      adapter: "github-project",
      issueSubjectId: "issue-2",
    });
    const keyC = deriveIssueWorkspaceKey({
      workspaceId: "ws-2",
      adapter: "github-project",
      issueSubjectId: "issue-1",
    });

    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(keyC);
  });
});

describe("resolveIssueWorkspaceDirectory", () => {
  it("produces the correct issue workspace path", () => {
    const result = resolveIssueWorkspaceDirectory(
      "/runtime/workspaces",
      "ws-1",
      "abc123"
    );

    expect(result).toBe("/runtime/workspaces/workspaces/ws-1/issues/abc123");
  });

  it("rejects path traversal that escapes the root", () => {
    expect(() =>
      resolveIssueWorkspaceDirectory("/runtime/workspaces", "../../../../../../tmp", "key")
    ).toThrow("escapes");
  });
});

describe("resolveIssueRepositoryPath", () => {
  it("appends /repository to the workspace directory", () => {
    expect(resolveIssueRepositoryPath("/workspaces/ws-1/issues/abc")).toBe(
      "/workspaces/ws-1/issues/abc/repository"
    );
  });
});

describe("buildHookEnv", () => {
  it("produces the standard hook environment variables", () => {
    const env = buildHookEnv({
      workspaceId: "ws-1",
      workspaceKey: "key-abc",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#42",
      workspacePath: "/workspace",
      repositoryPath: "/workspace/repository",
    });

    expect(env.SYMPHONY_WORKSPACE_ID).toBe("ws-1");
    expect(env.SYMPHONY_ISSUE_WORKSPACE_KEY).toBe("key-abc");
    expect(env.SYMPHONY_ISSUE_SUBJECT_ID).toBe("issue-1");
    expect(env.SYMPHONY_ISSUE_IDENTIFIER).toBe("acme/platform#42");
    expect(env.SYMPHONY_WORKSPACE_PATH).toBe("/workspace");
    expect(env.SYMPHONY_REPOSITORY_PATH).toBe("/workspace/repository");
    expect(env.SYMPHONY_RUN_ID).toBeUndefined();
    expect(env.SYMPHONY_RUN_PHASE).toBeUndefined();
  });

  it("includes run-level variables when provided", () => {
    const env = buildHookEnv({
      workspaceId: "ws-1",
      workspaceKey: "key-abc",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#42",
      workspacePath: "/workspace",
      repositoryPath: "/workspace/repository",
      runId: "run-1",
      phase: "planning",
    });

    expect(env.SYMPHONY_RUN_ID).toBe("run-1");
    expect(env.SYMPHONY_RUN_PHASE).toBe("planning");
  });
});

describe("renderPrompt", () => {
  it("substitutes issue variables into the template", () => {
    const variables = buildPromptVariables(
      {
        id: "issue-1",
        identifier: "acme/platform#42",
        number: 42,
        title: "Fix the bug",
        description: "It crashes on startup",
        priority: null,
        state: "Todo",
        branchName: null,
        url: "https://github.com/acme/platform/issues/42",
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
        phase: "planning",
        metadata: {},
      },
      { attempt: null, guidelines: "Be concise." }
    );

    const rendered = renderPrompt(
      "Fix {{issue.title}} in {{issue.repository}}. {{guidelines}}",
      variables
    );

    expect(rendered).toBe("Fix Fix the bug in acme/platform. Be concise.");
  });

  it("leaves unresolved variables as-is", () => {
    const variables = buildPromptVariables(
      {
        id: "issue-1",
        identifier: "acme/platform#1",
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
          cloneUrl: "https://github.com/acme/platform.git",
        },
        tracker: {
          adapter: "github-project",
          bindingId: "project-123",
          itemId: "item-1",
        },
        phase: "planning",
        metadata: {},
      },
      { attempt: null, guidelines: "" }
    );

    expect(renderPrompt("{{unknown.var}}", variables)).toBe("{{unknown.var}}");
  });
});

describe("resolveWorkflowExecutionPhase", () => {
  const lifecycle = DEFAULT_WORKFLOW_LIFECYCLE;

  it("maps planning states to the planning phase", () => {
    expect(resolveWorkflowExecutionPhase("Todo", lifecycle)).toBe("planning");
  });

  it("maps human review states correctly", () => {
    expect(resolveWorkflowExecutionPhase("Plan Review", lifecycle)).toBe(
      "human-review"
    );
  });

  it("maps implementation states correctly", () => {
    expect(resolveWorkflowExecutionPhase("In Progress", lifecycle)).toBe(
      "implementation"
    );
  });

  it("returns unknown for unmapped states", () => {
    expect(resolveWorkflowExecutionPhase("Backlog", lifecycle)).toBe("unknown");
  });
});

describe("isWorkflowPhaseActionable", () => {
  it("treats planning and implementation as actionable", () => {
    expect(isWorkflowPhaseActionable("planning")).toBe(true);
    expect(isWorkflowPhaseActionable("implementation")).toBe(true);
  });

  it("treats other phases as non-actionable", () => {
    expect(isWorkflowPhaseActionable("human-review")).toBe(false);
    expect(isWorkflowPhaseActionable("completed")).toBe(false);
    expect(isWorkflowPhaseActionable("unknown")).toBe(false);
  });
});

describe("isWorkflowPhaseTerminal", () => {
  it("treats only completed as terminal", () => {
    expect(isWorkflowPhaseTerminal("completed")).toBe(true);
    expect(isWorkflowPhaseTerminal("planning")).toBe(false);
    expect(isWorkflowPhaseTerminal("unknown")).toBe(false);
  });
});

describe("scheduleRetryAt", () => {
  const now = new Date("2026-03-08T00:00:00.000Z");

  it("applies exponential backoff", () => {
    const first = scheduleRetryAt(now, 1, {
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    });
    const second = scheduleRetryAt(now, 2, {
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    });
    const third = scheduleRetryAt(now, 3, {
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    });

    expect(first.getTime() - now.getTime()).toBe(1000);
    expect(second.getTime() - now.getTime()).toBe(2000);
    expect(third.getTime() - now.getTime()).toBe(4000);
  });

  it("caps the delay at maxDelayMs", () => {
    const result = scheduleRetryAt(now, 20, {
      baseDelayMs: 1000,
      maxDelayMs: 5000,
    });
    expect(result.getTime() - now.getTime()).toBe(5000);
  });
});

describe("calculateRetryDelay", () => {
  it("doubles the delay for each attempt", () => {
    expect(
      calculateRetryDelay(1, { baseDelayMs: 100, maxDelayMs: 10000 })
    ).toBe(100);
    expect(
      calculateRetryDelay(2, { baseDelayMs: 100, maxDelayMs: 10000 })
    ).toBe(200);
    expect(
      calculateRetryDelay(3, { baseDelayMs: 100, maxDelayMs: 10000 })
    ).toBe(400);
  });
});

describe("buildWorkspaceSnapshot", () => {
  const baseWorkspace = {
    workspaceId: "ws-1",
    slug: "ws-1",
    promptGuidelines: "",
    repositories: [],
    tracker: {
      adapter: "github-project" as const,
      bindingId: "project-123",
    },
    runtime: {
      driver: "local" as const,
      workspaceRuntimeDir: "/runtime",
      projectRoot: "/project",
    },
  };

  it("produces idle health when no runs or errors", () => {
    const snapshot = buildWorkspaceSnapshot({
      workspace: baseWorkspace,
      activeRuns: [],
      summary: { dispatched: 0, suppressed: 0, recovered: 0 },
      lastTickAt: "2026-03-08T00:00:00.000Z",
      lastError: null,
    });

    expect(snapshot.health).toBe("idle");
    expect(snapshot.summary.activeRuns).toBe(0);
  });

  it("produces running health when active runs exist", () => {
    const snapshot = buildWorkspaceSnapshot({
      workspace: baseWorkspace,
      activeRuns: [
        {
          runId: "run-1",
          workspaceId: "ws-1",
          workspaceSlug: "ws-1",
          issueId: "issue-1",
          issueSubjectId: "issue-1",
          issueIdentifier: "acme/platform#1",
          phase: "planning",
          repository: { owner: "acme", name: "platform", cloneUrl: "" },
          status: "running",
          attempt: 1,
          processId: 1234,
          port: 4601,
          workingDirectory: "/work",
          issueWorkspaceKey: "key-1",
          workspaceRuntimeDir: "/runtime",
          workflowPath: null,
          retryKind: null,
          createdAt: "2026-03-08T00:00:00.000Z",
          updatedAt: "2026-03-08T00:00:00.000Z",
          startedAt: "2026-03-08T00:00:00.000Z",
          completedAt: null,
          lastError: null,
          nextRetryAt: null,
        },
      ],
      summary: { dispatched: 1, suppressed: 0, recovered: 0 },
      lastTickAt: "2026-03-08T00:00:00.000Z",
      lastError: null,
    });

    expect(snapshot.health).toBe("running");
    expect(snapshot.summary.activeRuns).toBe(1);
    expect(snapshot.activeRuns).toHaveLength(1);
    expect(snapshot.activeRuns[0]?.runId).toBe("run-1");
  });

  it("produces degraded health when lastError is present", () => {
    const snapshot = buildWorkspaceSnapshot({
      workspace: baseWorkspace,
      activeRuns: [],
      summary: { dispatched: 0, suppressed: 0, recovered: 0 },
      lastTickAt: "2026-03-08T00:00:00.000Z",
      lastError: "Tracker query failed",
    });

    expect(snapshot.health).toBe("degraded");
    expect(snapshot.lastError).toBe("Tracker query failed");
  });
});
