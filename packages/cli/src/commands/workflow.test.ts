import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWorkflowMarkdown } from "@gh-symphony/core";
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
  api_key: $LINEAR_API_KEY
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
  it("prints typed front-matter errors from workflow validate", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-validate-error-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const stdout = captureWrites(process.stdout);

    await writeFile(workflowPath, "---\n- tracker\n---\nPrompt", "utf8");

    try {
      await workflowCommand(["validate", "--file", workflowPath], {
        configDir: root,
        verbose: false,
        json: true,
        noColor: false,
      });
    } finally {
      stdout.restore();
    }

    expect(JSON.parse(stdout.output())).toMatchObject({
      error: { code: "workflow_front_matter_not_a_map" },
    });
  });

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

  it("prints a validation warning when legacy priority_field is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-validate-priority-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const stdout = captureWrites(process.stdout);

    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github-project
  project_id: project-123
  priority_field: Priority
codex:
  command: codex app-server
---
Prompt {{ issue.identifier }}
`,
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
      stdout.restore();
    }

    expect(stdout.output()).toContain("Warnings");
    expect(stdout.output()).toContain("Deprecated tracker provider keys");
    expect(stdout.output()).toContain("tracker:\n  provider:");
    expect(stdout.output()).toContain('priority_field: "Priority"');
    expect(stdout.output()).toContain("Legacy priority mapping");
  });

  it("renders a copyable provider migration block that round-trips", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-provider-migration-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const stdout = captureWrites(process.stdout);

    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github-project
  project_id: project-123
  pickup_labels:
    include:
      - agent-ready
    exclude:
      - blocked
  priority:
    source: labels
    labels:
      urgent: 1
codex:
  command: codex app-server
---
Prompt {{ issue.identifier }}
`,
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
      stdout.restore();
    }

    const providerBlock = stdout
      .output()
      .match(/```yaml\n([\s\S]*?)\n```/)?.[1];
    expect(stdout.output()).toContain("tracker.project_id=project-123");
    expect(providerBlock).toContain("pickup_labels:\n      include:");
    expect(providerBlock).toContain("priority:\n      source:");
    const migrated = parseWorkflowMarkdown(
      `---\n${providerBlock?.replace("tracker:\n", "tracker:\n  kind: github-project\n")}\ncodex:\n  command: codex app-server\n---\nPrompt`
    );
    expect(migrated.tracker.provider).toMatchObject({
      project_id: "project-123",
      pickup_labels: { include: ["agent-ready"], exclude: ["blocked"] },
      priority: { source: "labels", labels: { urgent: 1 } },
    });
  });

  it("includes priority precedence warnings in JSON validation output", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-validate-json-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const stdout = captureWrites(process.stdout);

    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github-project
  project_id: project-123
  priority_field: Priority
  priority:
    source: disabled
codex:
  command: codex app-server
---
Prompt {{ issue.identifier }}
`,
      "utf8"
    );

    try {
      await workflowCommand(["validate", "--file", workflowPath], {
        configDir: root,
        verbose: false,
        json: true,
        noColor: false,
      });
    } finally {
      stdout.restore();
    }

    const report = JSON.parse(stdout.output()) as {
      warnings: Array<{ title: string; summary: string }>;
    };
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Priority mapping precedence",
          summary: expect.stringContaining("explicit tracker.priority wins"),
        }),
      ])
    );
  });

  it("reports ignored per-state concurrency entries in validation output", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "workflow-validate-concurrency-")
    );
    const workflowPath = join(root, "WORKFLOW.md");
    const stdout = captureWrites(process.stdout);

    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github-project
agent:
  max_concurrent_agents_by_state:
    Ready: 0
    Review: '2'
    " In Progress ": 2
codex:
  command: codex app-server
---
Prompt {{ issue.identifier }}
`,
      "utf8"
    );

    try {
      await workflowCommand(["validate", "--file", workflowPath], {
        configDir: root,
        verbose: false,
        json: true,
        noColor: false,
      });
    } finally {
      stdout.restore();
    }

    const report = JSON.parse(stdout.output()) as {
      warnings: Array<{
        title: string;
        summary: string;
        details: { path: string };
      }>;
    };
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Ignored per-state concurrency entry",
          summary: expect.stringContaining(
            "agent.max_concurrent_agents_by_state.Ready"
          ),
          details: {
            path: "agent.max_concurrent_agents_by_state.Ready",
            reason: "must be greater than zero",
          },
        }),
        expect.objectContaining({
          title: "Ignored per-state concurrency entry",
          summary: expect.stringContaining(
            "agent.max_concurrent_agents_by_state.Review"
          ),
        }),
      ])
    );
  });

  it("includes normalized required labels in JSON validation output", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "workflow-validate-required-labels-")
    );
    const workflowPath = join(root, "WORKFLOW.md");
    const stdout = captureWrites(process.stdout);

    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github-project
  required_labels: [" Ready ", Agent]
codex:
  command: codex app-server
---
Prompt {{ issue.identifier }}
`,
      "utf8"
    );

    try {
      await workflowCommand(["validate", "--file", workflowPath], {
        configDir: root,
        verbose: false,
        json: true,
        noColor: false,
      });
    } finally {
      stdout.restore();
    }

    const report = JSON.parse(stdout.output()) as {
      summary: { requiredLabels: string[] };
    };
    expect(report.summary.requiredLabels).toEqual(["ready", "agent"]);
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

  it("previews the normalized execution phase for planning states", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-preview-phase-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const stdout = captureWrites(process.stdout);
    const workflow = SAMPLE_WORKFLOW.replace(
      "  terminal_states:\n    - Done",
      "  terminal_states:\n    - Done\n  planning_states:\n    - IN PROGRESS"
    ).replace(
      "{{ issue.identifier }}: {{ issue.title }}",
      "{{ issue.identifier }}: phase={{ execution_phase }}"
    );

    await writeFile(workflowPath, workflow, "utf8");

    try {
      await workflowCommand(["preview", "--file", workflowPath], {
        configDir: root,
        verbose: false,
        json: false,
        noColor: false,
      });
    } finally {
      stdout.restore();
    }

    expect(stdout.output()).toContain("octo/hello-world#157: phase=planning");
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

  it("rejects a malformed dispatchability gate in a preview sample", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "workflow-preview-dispatchable-")
    );
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
        title: "Malformed dispatchability",
        state: "Ready",
        labels: [],
        dispatchable: "false",
        blocked_by: [],
        repository: { owner: "acme", name: "api" },
      }),
      "utf8"
    );

    try {
      await workflowCommand(
        ["preview", "--file", workflowPath, "--sample", samplePath],
        { configDir: root, verbose: false, json: false, noColor: false }
      );
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).toContain(
      "Sample JSON field 'dispatchable' must be a boolean."
    );
    expect(process.exitCode).toBe(1);
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
    const originalLinearApiKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_test_token";

    await writeFile(workflowPath, LINEAR_WORKFLOW, "utf8");

    const resolveManagedProjectSelection = vi.fn().mockResolvedValue({
      kind: "resolved",
      projectId: "repository",
      projectConfig: {
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
      },
    });
    setWorkflowCommandDependenciesForTest({
      resolveManagedProjectSelection,
      resolveTrackerAdapter,
    });

    try {
      await workflowCommand(
        [
          "preview",
          "--file",
          workflowPath,
          "--project-id",
          "tenant-a",
          "ENG-123",
        ],
        {
          configDir: root,
          verbose: false,
          json: false,
          noColor: false,
        }
      );
    } finally {
      if (originalLinearApiKey === undefined) {
        delete process.env.LINEAR_API_KEY;
      } else {
        process.env.LINEAR_API_KEY = originalLinearApiKey;
      }
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
    expect(resolveManagedProjectSelection).toHaveBeenCalledWith({
      configDir: root,
      requestedProjectId: "tenant-a",
    });
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

  it("rejects Linear preview when the active runtime is not bound to the workflow project", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "workflow-preview-linear-mismatch-")
    );
    const workflowPath = join(root, "WORKFLOW.md");
    const stderr = captureWrites(process.stderr);
    const resolveTrackerAdapter = vi.fn();
    const originalLinearApiKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_test_token";

    await writeFile(workflowPath, LINEAR_WORKFLOW, "utf8");

    setWorkflowCommandDependenciesForTest({
      resolveManagedProjectSelection: vi.fn().mockResolvedValue({
        kind: "resolved",
        projectId: "tenant-a",
        projectConfig: {
          projectId: "tenant-a",
          slug: "tenant-a",
          workspaceDir: root,
          repository: {
            owner: "acme",
            name: "api",
            cloneUrl: "https://github.com/acme/api.git",
          },
          tracker: {
            adapter: "github-project",
            bindingId: "PVT_project_123",
            settings: {
              projectId: "PVT_project_123",
            },
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
      if (originalLinearApiKey === undefined) {
        delete process.env.LINEAR_API_KEY;
      } else {
        process.env.LINEAR_API_KEY = originalLinearApiKey;
      }
      stderr.restore();
    }

    expect(stderr.output()).toContain(
      'Linear live issue preview requires an active repository runtime initialized for project "symphony-0c79b11b75ea".'
    );
    expect(resolveTrackerAdapter).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("rejects duplicate preview issue identifiers regardless of argument order", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-preview-duplicate-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const stderr = captureWrites(process.stderr);

    await writeFile(workflowPath, LINEAR_WORKFLOW, "utf8");

    try {
      await workflowCommand(
        ["preview", "--file", workflowPath, "ENG-123", "--issue", "ENG-124"],
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
      "Only one preview issue identifier can be provided."
    );
    expect(process.exitCode).toBe(1);
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
