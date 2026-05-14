import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import workflowCommand, {
  resetWorkflowCommandDependenciesForTest,
  setWorkflowCommandDependenciesForTest,
} from "./workflow.js";

function captureWrites(stream: NodeJS.WriteStream): {
  output: () => string;
  restore: () => void;
} {
  let buffer = "";
  const spy = vi.spyOn(stream, "write").mockImplementation(((
    chunk: string | Uint8Array
  ) => {
    buffer +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof stream.write);

  return {
    output: () => buffer,
    restore: () => spy.mockRestore(),
  };
}

const SAMPLE_WORKFLOW = `---
continuation_guidance: Continue after {{ cumulativeTurnCount }} turns. Summary: {{ lastTurnSummary }}
tracker:
  kind: github-project
  project_id: project-123
  state_field: Status
  active_states:
    - Ready
    - In progress
  terminal_states:
    - Done
codex:
  command: codex app-server
---
# Issue
{{ issue.identifier }}: {{ issue.title }}

Attempt={{ attempt }}
Labels={% for label in issue.labels %}{{ label }} {% endfor %}
`;

const LINEAR_WORKFLOW = `---
tracker:
  kind: linear
  api_key: lin_test_token
  project_slug: symphony-0c79b11b75ea
  active_states:
    - Todo
  terminal_states:
    - Done
runtime:
  kind: codex-app-server
  command: codex
  args:
    - app-server
---
# Issue
{{ issue.identifier }}: {{ issue.title }}
`;

afterEach(() => {
  vi.restoreAllMocks();
  resetWorkflowCommandDependenciesForTest();
  process.exitCode = undefined;
});

describe("workflow command handler", () => {
  it("validates a workflow file with strict prompt and continuation rendering", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-validate-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const stdout = captureWrites(process.stdout);

    await writeFile(workflowPath, SAMPLE_WORKFLOW, "utf8");

    try {
      await workflowCommand(["validate", "--file", workflowPath], {
        configDir: root,
        verbose: false,
        json: false,
        noColor: false,
      });
    } finally {
      stdout.restore();
    }

    expect(stdout.output()).toContain("WORKFLOW.md validation passed");
    expect(stdout.output()).toContain(`Path: ${workflowPath}`);
    expect(stdout.output()).toContain("continuation_guidance=pass");
    expect(stdout.output()).toContain("active_states=Ready, In progress");
  });

  it("previews a workflow with the built-in sample issue", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-preview-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const stdout = captureWrites(process.stdout);

    await writeFile(workflowPath, SAMPLE_WORKFLOW, "utf8");

    try {
      await workflowCommand(
        ["preview", "--file", workflowPath, "--attempt", "2"],
        {
          configDir: root,
          verbose: false,
          json: false,
          noColor: false,
        }
      );
    } finally {
      stdout.restore();
    }

    expect(stdout.output()).toContain("WORKFLOW.md prompt preview");
    expect(stdout.output()).toContain("Attempt: 2");
    expect(stdout.output()).toContain(
      "octo/hello-world#157: Add workflow validate and preview commands"
    );
    expect(stdout.output()).toContain("Attempt=2");
  });

  it("loads sample issue JSON for preview rendering", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-preview-sample-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const samplePath = join(root, "sample-issue.json");
    const stdout = captureWrites(process.stdout);

    await writeFile(workflowPath, SAMPLE_WORKFLOW, "utf8");
    await writeFile(
      samplePath,
      JSON.stringify({
        id: "sample-1",
        identifier: "acme/api#9",
        number: 9,
        title: "Fix preview rendering",
        description: "Preview should use sample issue payloads.",
        state: "Ready",
        labels: ["bug"],
        blocked_by: [],
        repository: {
          owner: "acme",
          name: "api",
        },
      }),
      "utf8"
    );

    try {
      await workflowCommand(
        [
          "preview",
          "--file",
          workflowPath,
          "--sample",
          samplePath,
          "--attempt",
          "3",
        ],
        {
          configDir: root,
          verbose: false,
          json: false,
          noColor: false,
        }
      );
    } finally {
      stdout.restore();
    }

    expect(stdout.output()).toContain(`Sample: ${samplePath}`);
    expect(stdout.output()).toContain("acme/api#9: Fix preview rendering");
    expect(stdout.output()).toContain("Attempt=3");
  });

  it("loads a live GitHub Project issue for preview rendering", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-preview-live-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const stdout = captureWrites(process.stdout);

    await writeFile(workflowPath, SAMPLE_WORKFLOW, "utf8");

    setWorkflowCommandDependenciesForTest({
      getGitHubTokenWithSource: () => ({
        token: "token-123",
        source: "gh",
      }),
      validateGitHubToken: vi.fn().mockResolvedValue({
        token: "token-123",
        source: "gh",
        login: "octocat",
        scopes: ["repo", "read:org", "project"],
      }),
      createGitHubClient: vi.fn().mockReturnValue({
        token: "token-123",
        apiUrl: "https://api.github.com/graphql",
        fetchImpl: fetch,
      }),
      resolveManagedProjectSelection: vi.fn().mockResolvedValue({
        kind: "resolved",
        projectId: "tenant-a",
        projectConfig: {
          projectId: "tenant-a",
          slug: "tenant-a",
          workspaceDir: "/tmp/tenant-a",
          tracker: {
            adapter: "github-project",
            bindingId: "PVT_project_123",
            settings: {
              projectId: "PVT_project_123",
            },
          },
        },
      }),
      getGitHubProjectDetail: vi.fn().mockResolvedValue({
        id: "PVT_project_123",
        title: "Acme Roadmap",
        url: "https://github.com/users/acme/projects/1",
        statusFields: [],
        textFields: [],
        linkedRepositories: [
          {
            owner: "acme",
            name: "api",
            url: "https://github.com/acme/api",
            cloneUrl: "https://github.com/acme/api.git",
          },
        ],
      }),
      fetchLiveIssue: vi.fn().mockResolvedValue({
        id: "issue-9",
        identifier: "acme/api#9",
        number: 9,
        title: "Fix preview rendering",
        description: "Preview should use live issue payloads.",
        priority: 1,
        state: "Ready",
        branchName: null,
        url: "https://github.com/acme/api/issues/9",
        labels: ["bug"],
        blockedBy: [],
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-02T00:00:00Z",
        repository: {
          owner: "acme",
          name: "api",
          url: "https://github.com/acme/api",
          cloneUrl: "https://github.com/acme/api.git",
        },
        tracker: {
          adapter: "github-project",
          bindingId: "PVT_project_123",
          itemId: "PVTI_issue_9",
        },
        metadata: {},
      }),
    });

    try {
      await workflowCommand(
        [
          "preview",
          "--file",
          workflowPath,
          "--issue",
          "acme/api#9",
          "--attempt",
          "2",
        ],
        {
          configDir: root,
          verbose: false,
          json: false,
          noColor: false,
        }
      );
    } finally {
      stdout.restore();
    }

    expect(stdout.output()).toContain("Sample: live:acme/api#9");
    expect(stdout.output()).toContain("acme/api#9: Fix preview rendering");
    expect(stdout.output()).toContain("Attempt=2");
  });

  it("routes Linear identifiers through the active tracker adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-preview-linear-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const stdout = captureWrites(process.stdout);
    const fetchIssueStatesByIds = vi.fn().mockResolvedValue([
      {
        id: "linear-issue-id",
        identifier: "ENG-123",
        number: 123,
        title: "Add Linear preview",
        description: "Preview should fetch through Linear.",
        priority: 2,
        state: "Todo",
        branchName: null,
        url: "https://linear.app/acme/issue/ENG-123",
        labels: ["cli"],
        blockedBy: [],
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-02T00:00:00Z",
        repository: {
          owner: "acme",
          name: "api",
          cloneUrl: "https://github.com/acme/api.git",
        },
        tracker: {
          adapter: "linear",
          bindingId: "symphony-0c79b11b75ea",
          itemId: "linear-issue-id",
        },
        metadata: {},
      },
    ]);
    const resolveTrackerAdapter = vi.fn().mockReturnValue({
      listIssues: vi.fn(),
      listIssuesByStates: vi.fn(),
      fetchIssueStatesByIds,
      buildWorkerEnvironment: vi.fn(),
      reviveIssue: vi.fn(),
    });

    await writeFile(workflowPath, LINEAR_WORKFLOW, "utf8");

    setWorkflowCommandDependenciesForTest({
      loadActiveProjectConfig: vi.fn().mockResolvedValue({
        projectId: "repository",
        slug: "api",
        workspaceDir: root,
        repository: {
          owner: "acme",
          name: "api",
          cloneUrl: "https://github.com/acme/api.git",
        },
        tracker: {
          adapter: "linear",
          bindingId: "symphony-0c79b11b75ea",
          settings: {
            projectSlug: "symphony-0c79b11b75ea",
          },
        },
      }),
      resolveTrackerAdapter,
    });

    try {
      await workflowCommand(["preview", "--file", workflowPath, "ENG-123"], {
        configDir: root,
        verbose: false,
        json: false,
        noColor: false,
      });
    } finally {
      stdout.restore();
    }

    expect(resolveTrackerAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        adapter: "linear",
        bindingId: "symphony-0c79b11b75ea",
        settings: expect.objectContaining({
          projectSlug: "symphony-0c79b11b75ea",
        }),
      })
    );
    expect(fetchIssueStatesByIds).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: expect.objectContaining({
          owner: "acme",
          name: "api",
        }),
      }),
      ["ENG-123"],
      { token: "lin_test_token" }
    );
    expect(stdout.output()).toContain("Sample: live:ENG-123");
    expect(stdout.output()).toContain("ENG-123: Add Linear preview");
  });

  it("fails live preview when the repository is not linked to the bound GitHub Project", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "workflow-preview-live-missing-repo-")
    );
    const workflowPath = join(root, "WORKFLOW.md");
    const stderr = captureWrites(process.stderr);

    await writeFile(workflowPath, SAMPLE_WORKFLOW, "utf8");

    setWorkflowCommandDependenciesForTest({
      getGitHubTokenWithSource: () => ({
        token: "token-123",
        source: "gh",
      }),
      validateGitHubToken: vi.fn().mockResolvedValue({
        token: "token-123",
        source: "gh",
        login: "octocat",
        scopes: ["repo", "read:org", "project"],
      }),
      createGitHubClient: vi.fn().mockReturnValue({
        token: "token-123",
        apiUrl: "https://api.github.com/graphql",
        fetchImpl: fetch,
      }),
      resolveManagedProjectSelection: vi.fn().mockResolvedValue({
        kind: "resolved",
        projectId: "tenant-a",
        projectConfig: {
          projectId: "tenant-a",
          slug: "tenant-a",
          workspaceDir: "/tmp/tenant-a",
          tracker: {
            adapter: "github-project",
            bindingId: "PVT_project_123",
          },
        },
      }),
      getGitHubProjectDetail: vi.fn().mockResolvedValue({
        id: "PVT_project_123",
        title: "Acme Roadmap",
        url: "https://github.com/users/acme/projects/1",
        statusFields: [],
        textFields: [],
        linkedRepositories: [],
      }),
    });

    try {
      await workflowCommand(
        ["preview", "--file", workflowPath, "--issue", "acme/api#9"],
        {
          configDir: root,
          verbose: false,
          json: false,
          noColor: false,
        }
      );
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).toContain(
      'Repository acme/api is not linked to the configured GitHub Project "Acme Roadmap".'
    );
    expect(process.exitCode).toBe(1);
  });

  it("fails live preview when the issue is not in the configured GitHub Project", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "workflow-preview-live-missing-issue-")
    );
    const workflowPath = join(root, "WORKFLOW.md");
    const stderr = captureWrites(process.stderr);

    await writeFile(workflowPath, SAMPLE_WORKFLOW, "utf8");

    setWorkflowCommandDependenciesForTest({
      getGitHubTokenWithSource: () => ({
        token: "token-123",
        source: "gh",
      }),
      validateGitHubToken: vi.fn().mockResolvedValue({
        token: "token-123",
        source: "gh",
        login: "octocat",
        scopes: ["repo", "read:org", "project"],
      }),
      createGitHubClient: vi.fn().mockReturnValue({
        token: "token-123",
        apiUrl: "https://api.github.com/graphql",
        fetchImpl: fetch,
      }),
      resolveManagedProjectSelection: vi.fn().mockResolvedValue({
        kind: "resolved",
        projectId: "tenant-a",
        projectConfig: {
          projectId: "tenant-a",
          slug: "tenant-a",
          workspaceDir: "/tmp/tenant-a",
          tracker: {
            adapter: "github-project",
            bindingId: "PVT_project_123",
          },
        },
      }),
      getGitHubProjectDetail: vi.fn().mockResolvedValue({
        id: "PVT_project_123",
        title: "Acme Roadmap",
        url: "https://github.com/users/acme/projects/1",
        statusFields: [],
        textFields: [],
        linkedRepositories: [
          {
            owner: "acme",
            name: "api",
            url: "https://github.com/acme/api",
            cloneUrl: "https://github.com/acme/api.git",
          },
        ],
      }),
      fetchLiveIssue: vi.fn().mockResolvedValue(null),
    });

    try {
      await workflowCommand(
        ["preview", "--file", workflowPath, "--issue", "acme/api#9"],
        {
          configDir: root,
          verbose: false,
          json: false,
          noColor: false,
        }
      );
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).toContain(
      'Issue acme/api#9 is not in the configured GitHub Project "Acme Roadmap".'
    );
    expect(process.exitCode).toBe(1);
  });

  it("fails live preview with actionable auth guidance when scopes are missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-preview-live-auth-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const stderr = captureWrites(process.stderr);

    await writeFile(workflowPath, SAMPLE_WORKFLOW, "utf8");

    setWorkflowCommandDependenciesForTest({
      getGitHubTokenWithSource: () => ({
        token: "token-123",
        source: "gh",
      }),
      resolveManagedProjectSelection: vi.fn().mockResolvedValue({
        kind: "resolved",
        projectId: "tenant-a",
        projectConfig: {
          projectId: "tenant-a",
          slug: "tenant-a",
          workspaceDir: "/tmp/tenant-a",
          tracker: {
            adapter: "github-project",
            bindingId: "PVT_project_123",
          },
        },
      }),
      validateGitHubToken: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Run 'gh auth refresh --scopes repo,read:org,project'. Missing scopes: project"
          )
        ),
    });

    try {
      await workflowCommand(
        ["preview", "--file", workflowPath, "--issue", "acme/api#9"],
        {
          configDir: root,
          verbose: false,
          json: false,
          noColor: false,
        }
      );
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).toContain(
      "GitHub authentication is required for live issue preview."
    );
    expect(stderr.output()).toContain("Missing scopes: project");
    expect(process.exitCode).toBe(1);
  });

  it("rejects unsupported continuation guidance Liquid syntax during validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-validate-invalid-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const stderr = captureWrites(process.stderr);

    await writeFile(
      workflowPath,
      SAMPLE_WORKFLOW.replace(
        "Continue after {{ cumulativeTurnCount }} turns. Summary: {{ lastTurnSummary }}",
        "{% if attempt %}Retry{% endif %}"
      ),
      "utf8"
    );

    try {
      await workflowCommand(["validate", "--file", workflowPath], {
        configDir: root,
        verbose: false,
        json: false,
        noColor: false,
      });
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).toContain(
      "continuation guidance does not support Liquid tags"
    );
    expect(process.exitCode).toBe(1);
  });

  it("reports field-aware sample JSON validation errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-preview-invalid-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const samplePath = join(root, "sample-issue.json");
    const stderr = captureWrites(process.stderr);

    await writeFile(workflowPath, SAMPLE_WORKFLOW, "utf8");
    await writeFile(
      samplePath,
      JSON.stringify({
        id: "sample-1",
        identifier: "acme/api#9",
        number: 9,
        title: "Fix preview rendering",
        description: 42,
        state: "Ready",
        repository: {
          owner: "acme",
          name: "api",
        },
      }),
      "utf8"
    );

    try {
      await workflowCommand(
        ["preview", "--file", workflowPath, "--sample", samplePath],
        {
          configDir: root,
          verbose: false,
          json: false,
          noColor: false,
        }
      );
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).toContain(
      "Sample JSON field 'description' must be a string."
    );
    expect(process.exitCode).toBe(1);
  });
});
