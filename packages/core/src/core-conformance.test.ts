import { describe, expect, it } from "vitest";
import {
  buildHookEnv,
  buildPromptVariables,
  buildProjectSnapshot,
  calculateRetryDelay,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_WORKFLOW_AGENT,
  DEFAULT_WORKFLOW_LIFECYCLE,
  deriveIssueWorkspaceKey,
  isStateActive,
  isStateTerminal,
  renderPrompt,
  resolveIssueRepositoryPath,
  resolveIssueWorkspaceDirectory,
  scheduleRetryAt,
} from "./index.js";
import type { RunDispatchedEvent } from "./observability/structured-events.js";

describe("deriveIssueWorkspaceKey", () => {
  it("produces a stable deterministic key", () => {
    const identity = {
      projectId: "ws-1",
      adapter: "github-project",
      issueSubjectId: "issue-abc",
    };

    const key1 = deriveIssueWorkspaceKey(identity, "acme/platform#42");
    const key2 = deriveIssueWorkspaceKey(identity, "acme/platform#42");

    expect(key1).toBe(key2);
    expect(key1).toBe("acme_platform_42");
  });

  it("produces different keys for different identifiers", () => {
    const keyA = deriveIssueWorkspaceKey({
      projectId: "ws-1",
      adapter: "github-project",
      issueSubjectId: "issue-1",
    }, "acme/platform#1");
    const keyB = deriveIssueWorkspaceKey({
      projectId: "ws-1",
      adapter: "github-project",
      issueSubjectId: "issue-2",
    }, "acme/platform#2");
    const keyC = deriveIssueWorkspaceKey({
      projectId: "ws-2",
      adapter: "github-project",
      issueSubjectId: "issue-1",
    }, "acme/api#1");

    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(keyC);
  });

  it("produces the same key when normalized identifiers collide (spec 4.2: pure substitution)", () => {
    const keyA = deriveIssueWorkspaceKey(
      {
        projectId: "ws-1",
        adapter: "github-project",
        issueSubjectId: "issue-1",
      },
      "acme/foo-bar#1"
    );
    const keyB = deriveIssueWorkspaceKey(
      {
        projectId: "ws-1",
        adapter: "github-project",
        issueSubjectId: "issue-2",
      },
      "acme/foo_bar#1"
    );

    // Per spec 4.2, workspace key is pure identifier substitution.
    // Collisions are handled by the directory layout (projectId/issues/key).
    expect(keyA).toBe("acme_foo_bar_1");
    expect(keyB).toBe("acme_foo_bar_1");
  });

  it("falls back to 'issue' when sanitization strips everything", () => {
    const key = deriveIssueWorkspaceKey(
      {
        projectId: "ws-1",
        adapter: "github-project",
        issueSubjectId: "issue-1",
      },
      "!!!"
    );

    expect(key).toBe("issue");
  });
});

describe("resolveIssueWorkspaceDirectory", () => {
  it("produces the correct issue workspace path", () => {
    const result = resolveIssueWorkspaceDirectory(
      "/runtime/projects/ws-1",
      "abc123"
    );

    expect(result).toBe("/runtime/projects/ws-1/issues/abc123");
  });

  it("rejects path traversal that escapes the root", () => {
    expect(() =>
      resolveIssueWorkspaceDirectory(
        "/runtime/projects/ws-1",
        "../../../../../../tmp"
      )
    ).toThrow("escapes");
  });
});

describe("resolveIssueRepositoryPath", () => {
  it("appends /repository to the workspace directory", () => {
    expect(resolveIssueRepositoryPath("/projects/ws-1/issues/abc")).toBe(
      "/projects/ws-1/issues/abc/repository"
    );
  });
});

describe("buildHookEnv", () => {
  it("produces the standard hook environment variables", () => {
    const env = buildHookEnv({
      projectId: "ws-1",
      workspaceKey: "key-abc",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#42",
      workspacePath: "/workspace",
      repositoryPath: "/workspace/repository",
    });

    expect(env.SYMPHONY_PROJECT_ID).toBe("ws-1");
    expect(env.SYMPHONY_ISSUE_WORKSPACE_KEY).toBe("key-abc");
    expect(env.SYMPHONY_ISSUE_SUBJECT_ID).toBe("issue-1");
    expect(env.SYMPHONY_ISSUE_IDENTIFIER).toBe("acme/platform#42");
    expect(env.SYMPHONY_WORKSPACE_PATH).toBe("/workspace");
    expect(env.SYMPHONY_REPOSITORY_PATH).toBe("/workspace/repository");
    expect(env.SYMPHONY_RUN_ID).toBeUndefined();
    expect(env.SYMPHONY_ISSUE_STATE).toBeUndefined();
  });

  it("includes run-level variables when provided", () => {
    const env = buildHookEnv({
      projectId: "ws-1",
      workspaceKey: "key-abc",
      issueSubjectId: "issue-1",
      issueIdentifier: "acme/platform#42",
      workspacePath: "/workspace",
      repositoryPath: "/workspace/repository",
      runId: "run-1",
      state: "Todo",
    });

    expect(env.SYMPHONY_RUN_ID).toBe("run-1");
    expect(env.SYMPHONY_ISSUE_STATE).toBe("Todo");
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
        metadata: {},
      },
      { attempt: null }
    );

    const rendered = renderPrompt(
      "Fix {{issue.title}} in {{issue.repository}}.",
      variables
    );

    expect(rendered).toBe("Fix Fix the bug in acme/platform.");
  });

  it("renders Liquid control flow and filters in strict mode", () => {
    const variables = buildPromptVariables(
      {
        id: "issue-1",
        identifier: "acme/platform#42",
        number: 42,
        title: "Fix the bug",
        description: "It crashes on startup",
        priority: 1,
        state: "Todo",
        branchName: "fix/issue-42",
        url: "https://github.com/acme/platform/issues/42",
        labels: ["bug", "backend"],
        blockedBy: [
          {
            id: "issue-41",
            identifier: "acme/platform#41",
            state: "In Progress",
          },
        ],
        createdAt: "2026-03-18T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z",
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
        metadata: {},
      },
      { attempt: 2 }
    );

    const rendered = renderPrompt(
      [
        "{% if issue.labels.size > 0 %}",
        "{{ issue.title | upcase }}",
        "{% endif %}",
        "{% for label in issue.labels %}[{{ label }}]{% endfor %}",
        "priority={{ issue.priority }}",
        "branch={{ issue.branch_name }}",
        "blocked={{ issue.blocked_by[0].identifier }}",
        "attempt={{ attempt }}",
      ].join("\n"),
      variables
    );

    expect(rendered).toContain("FIX THE BUG");
    expect(rendered).toContain("[bug][backend]");
    expect(rendered).toContain("priority=1");
    expect(rendered).toContain("branch=fix/issue-42");
    expect(rendered).toContain("blocked=acme/platform#41");
    expect(rendered).toContain("attempt=2");
  });

  it("exposes spec-defined issue fields in prompt variables", () => {
    const variables = buildPromptVariables(
      {
        id: "issue-1",
        identifier: "acme/platform#42",
        number: 42,
        title: "Fix the bug",
        description: "It crashes on startup",
        priority: 0,
        state: "Todo",
        branchName: "fix/issue-42",
        url: "https://github.com/acme/platform/issues/42",
        labels: ["bug"],
        blockedBy: [
          {
            id: "issue-40",
            identifier: "acme/platform#40",
            state: "Done",
          },
        ],
        createdAt: "2026-03-18T00:00:00.000Z",
        updatedAt: "2026-03-19T00:00:00.000Z",
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
        metadata: {},
      },
      { attempt: null }
    );

    expect(variables.issue.priority).toBe(0);
    expect(variables.issue.labels).toEqual(["bug"]);
    expect(variables.issue.blocked_by).toEqual([
      {
        id: "issue-40",
        identifier: "acme/platform#40",
        state: "Done",
      },
    ]);
    expect(variables.issue.branch_name).toBe("fix/issue-42");
    expect(variables.issue.created_at).toBe("2026-03-18T00:00:00.000Z");
    expect(variables.issue.updated_at).toBe("2026-03-19T00:00:00.000Z");
  });

  it("leaves unresolved variables as-is in non-strict mode", () => {
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
        metadata: {},
      },
      { attempt: null }
    );

    expect(renderPrompt("{{unknown.var}}", variables, { strict: false })).toBe(
      "{{unknown.var}}"
    );
  });

  it("throws template_render_error for unresolved variables in strict mode (default)", () => {
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
        metadata: {},
      },
      { attempt: null }
    );

    expect(() => renderPrompt("{{unknown.var}}", variables)).toThrow(
      "template_render_error"
    );
    expect(() =>
      renderPrompt("{{unknown.var}}", variables, { strict: true })
    ).toThrow("template_render_error");
    expect(() =>
      renderPrompt("{% if unknown_var %}x{% endif %}", variables)
    ).toThrow("template_render_error");
    expect(() =>
      renderPrompt("{% for item in unknown_list %}{{ item }}{% endfor %}", variables)
    ).toThrow("template_render_error");
  });

  it("throws template_render_error for unknown filters in strict mode", () => {
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
        metadata: {},
      },
      { attempt: null }
    );

    expect(() =>
      renderPrompt("{{ issue.title | does_not_exist }}", variables)
    ).toThrow("template_render_error");
  });

  it("throws template_parse_error for malformed Liquid templates", () => {
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
        metadata: {},
      },
      { attempt: null }
    );

    expect(() => renderPrompt("{% if %}", variables)).toThrow(
      "template_parse_error"
    );
  });

  it("does not throw in strict mode when all variables resolve", () => {
    const variables = buildPromptVariables(
      {
        id: "issue-1",
        identifier: "acme/platform#1",
        number: 1,
        title: "Fix the bug",
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
        metadata: {},
      },
      { attempt: null }
    );

    expect(() => renderPrompt("Fix {{issue.title}}", variables)).not.toThrow();
  });

  it("does not throw when substituted value contains mustache-like patterns", () => {
    const variables = buildPromptVariables(
      {
        id: "issue-1",
        identifier: "acme/platform#76",
        number: 76,
        title: "Replace template engine",
        description:
          '현재 `renderPrompt()`는 `{{variable.path}}` 단순 치환만 지원한다.',
        priority: null,
        state: "Ready",
        branchName: null,
        url: "https://github.com/acme/platform/issues/76",
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
        metadata: {},
      },
      { attempt: null }
    );

    // The issue description contains {{variable.path}} — a mustache-like
    // pattern that is NOT a template variable.  Strict mode must only
    // validate the original template, not the substituted result.
    const rendered = renderPrompt(
      "Issue: {{issue.title}}\n\n{{issue.description}}",
      variables
    );

    expect(rendered).toContain("{{variable.path}}");
    expect(rendered).toContain("Replace template engine");
  });

  it("renders null variables as empty string in strict mode", () => {
    const variables = buildPromptVariables(
      {
        id: "issue-1",
        identifier: "acme/platform#1",
        number: 1,
        title: "Fix the bug",
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
        metadata: {},
      },
      { attempt: null }
    );

    // null description → empty string, no template_render_error
    expect(
      renderPrompt(
        "Title: {{issue.title}}\nDesc: {{issue.description}}",
        variables
      )
    ).toBe("Title: Fix the bug\nDesc: ");
    // null url → empty string
    expect(renderPrompt("URL: {{issue.url}}", variables)).toBe("URL: ");
    // null attempt → empty string
    expect(renderPrompt("Attempt: {{attempt}}", variables)).toBe("Attempt: ");
  });
});

describe("isStateActive", () => {
  const lifecycle = DEFAULT_WORKFLOW_LIFECYCLE;

  it("treats configured active states as active", () => {
    expect(isStateActive("Todo", lifecycle)).toBe(true);
    expect(isStateActive("In Progress", lifecycle)).toBe(true);
  });

  it("treats non-active states as inactive", () => {
    expect(isStateActive("Done", lifecycle)).toBe(false);
    expect(isStateActive("Backlog", lifecycle)).toBe(false);
  });
});

describe("isStateTerminal", () => {
  const lifecycle = DEFAULT_WORKFLOW_LIFECYCLE;

  it("treats configured terminal states as terminal", () => {
    expect(isStateTerminal("Done", lifecycle)).toBe(true);
  });

  it("treats non-terminal states as non-terminal", () => {
    expect(isStateTerminal("Todo", lifecycle)).toBe(false);
    expect(isStateTerminal("In Progress", lifecycle)).toBe(false);
    expect(isStateTerminal("Backlog", lifecycle)).toBe(false);
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
  it("uses the core default base delay when options are omitted", () => {
    expect(DEFAULT_BASE_DELAY_MS).toBe(10_000);
    expect(DEFAULT_WORKFLOW_AGENT.retryBaseDelayMs).toBe(10_000);
    expect(calculateRetryDelay(1)).toBe(10_000);
    expect(calculateRetryDelay(2)).toBe(20_000);
  });

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

describe("buildProjectSnapshot", () => {
  const baseWorkspace = {
    projectId: "ws-1",
    slug: "ws-1",
    promptGuidelines: "",
    workspaceDir: "/runtime",
    repositories: [],
    tracker: {
      adapter: "github-project" as const,
      bindingId: "project-123",
    },
  };

  it("produces idle health when no runs or errors", () => {
    const snapshot = buildProjectSnapshot({
      project: baseWorkspace,
      activeRuns: [],
      summary: { dispatched: 0, suppressed: 0, recovered: 0 },
      lastTickAt: "2026-03-08T00:00:00.000Z",
      lastError: null,
    });

    expect(snapshot.health).toBe("idle");
    expect(snapshot.summary.activeRuns).toBe(0);
  });

  it("produces running health when active runs exist", () => {
    const snapshot = buildProjectSnapshot({
      project: baseWorkspace,
      activeRuns: [
        {
          runId: "run-1",
          projectId: "ws-1",
          projectSlug: "ws-1",
          issueId: "issue-1",
          issueSubjectId: "issue-1",
          issueIdentifier: "acme/platform#1",
          issueState: "Todo",
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
    const snapshot = buildProjectSnapshot({
      project: baseWorkspace,
      activeRuns: [],
      summary: { dispatched: 0, suppressed: 0, recovered: 0 },
      lastTickAt: "2026-03-08T00:00:00.000Z",
      lastError: "Tracker query failed",
    });

    expect(snapshot.health).toBe("degraded");
    expect(snapshot.lastError).toBe("Tracker query failed");
  });
});

describe("structured event field enrichment", () => {
  it("RunDispatchedEvent includes optional issueId and sessionId fields", () => {
    const event: RunDispatchedEvent = {
      at: new Date().toISOString(),
      event: "run-dispatched",
      projectId: "ws-1",
      issueIdentifier: "acme/repo#1",
      issueId: "issue-node-id",
      sessionId: "thread-1-turn-1",
    };

    expect(event.issueId).toBe("issue-node-id");
    expect(event.sessionId).toBe("thread-1-turn-1");
  });

  it("issueId and sessionId are optional on events", () => {
    const event: RunDispatchedEvent = {
      at: new Date().toISOString(),
      event: "run-dispatched",
      projectId: "ws-1",
      issueIdentifier: "acme/repo#1",
    };

    expect(event.issueId).toBeUndefined();
    expect(event.sessionId).toBeUndefined();
  });
});

describe("token accounting - buildProjectSnapshot", () => {
  it("includes codexTotals from run tokenUsage data", () => {
    const snapshot = buildProjectSnapshot({
      project: {
        projectId: "ws-1",
        slug: "test",
        workspaceDir: "/tmp",
        repositories: [],
        tracker: { adapter: "github-project", bindingId: "proj-1" },
      },
      activeRuns: [],
      allRuns: [
        {
          runId: "run-1",
          projectId: "ws-1",
          projectSlug: "test",
          issueId: "i1",
          issueSubjectId: "s1",
          issueIdentifier: "acme/repo#1",
          issueState: "Todo",
          repository: {
            owner: "acme",
            name: "repo",
            cloneUrl: "https://github.com/acme/repo.git",
          },
          status: "succeeded",
          attempt: 1,
          processId: null,
          port: null,
          workingDirectory: "/tmp",
          issueWorkspaceKey: null,
          workspaceRuntimeDir: "/tmp",
          workflowPath: null,
          retryKind: null,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T01:00:00Z",
          startedAt: "2025-01-01T00:00:00Z",
          completedAt: "2025-01-01T01:00:00Z",
          lastError: null,
          nextRetryAt: null,
          tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        },
      ],
      summary: { dispatched: 0, suppressed: 0, recovered: 0 },
      lastTickAt: "2025-01-01T01:00:00Z",
      lastError: null,
    });

    expect(snapshot.codexTotals).toBeDefined();
    expect(snapshot.codexTotals?.inputTokens).toBe(100);
    expect(snapshot.codexTotals?.totalTokens).toBe(150);
  });

  it("aggregates tokens across multiple runs", () => {
    const snapshot = buildProjectSnapshot({
      project: {
        projectId: "ws-1",
        slug: "test",
        workspaceDir: "/tmp",
        repositories: [],
        tracker: { adapter: "github-project", bindingId: "proj-1" },
      },
      activeRuns: [],
      allRuns: [
        {
          runId: "run-1",
          projectId: "ws-1",
          projectSlug: "test",
          issueId: "i1",
          issueSubjectId: "s1",
          issueIdentifier: "acme/repo#1",
          issueState: "Todo",
          repository: {
            owner: "acme",
            name: "repo",
            cloneUrl: "https://github.com/acme/repo.git",
          },
          status: "succeeded",
          attempt: 1,
          processId: null,
          port: null,
          workingDirectory: "/tmp",
          issueWorkspaceKey: null,
          workspaceRuntimeDir: "/tmp",
          workflowPath: null,
          retryKind: null,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T01:00:00Z",
          startedAt: "2025-01-01T00:00:00Z",
          completedAt: "2025-01-01T01:00:00Z",
          lastError: null,
          nextRetryAt: null,
          tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        },
        {
          runId: "run-2",
          projectId: "ws-1",
          projectSlug: "test",
          issueId: "i2",
          issueSubjectId: "s2",
          issueIdentifier: "acme/repo#2",
          issueState: "Todo",
          repository: {
            owner: "acme",
            name: "repo",
            cloneUrl: "https://github.com/acme/repo.git",
          },
          status: "succeeded",
          attempt: 1,
          processId: null,
          port: null,
          workingDirectory: "/tmp",
          issueWorkspaceKey: null,
          workspaceRuntimeDir: "/tmp",
          workflowPath: null,
          retryKind: null,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T02:00:00Z",
          startedAt: "2025-01-01T01:00:00Z",
          completedAt: "2025-01-01T02:00:00Z",
          lastError: null,
          nextRetryAt: null,
          tokenUsage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
        },
      ],
      summary: { dispatched: 0, suppressed: 0, recovered: 0 },
      lastTickAt: "2025-01-01T02:00:00Z",
      lastError: null,
    });

    expect(snapshot.codexTotals).toBeDefined();
    expect(snapshot.codexTotals?.inputTokens).toBe(300);
    expect(snapshot.codexTotals?.outputTokens).toBe(150);
    expect(snapshot.codexTotals?.totalTokens).toBe(450);
  });
});
