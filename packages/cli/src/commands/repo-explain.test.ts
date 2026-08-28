import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import repoExplainCommand from "./repo-explain.js";
import { saveGlobalConfig, saveProjectConfig } from "../config.js";
import * as ghAuth from "../github/gh-auth.js";

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

function baseOptions(configDir: string) {
  return {
    configDir,
    verbose: false,
    json: false,
    noColor: true,
  };
}

describe("repo explain", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("rejects malformed issue identifiers before loading repository state", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-explain-invalid-"));
    const stderr = captureWrites(process.stderr);

    try {
      await repoExplainCommand(["not-an-issue"], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(process.exitCode).toBe(2);
    expect(stderr.output()).toContain(
      "Issue identifier must use the form <owner>/<repo>#<number>"
    );
  });

  it("prints JSON when repo explain cannot find a runtime config", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-explain-missing-"));
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);

    try {
      await repoExplainCommand(["acme/widgets#42"], {
        ...baseOptions(configDir),
        json: true,
      });
    } finally {
      stdout.restore();
      stderr.restore();
    }

    expect(process.exitCode).toBe(1);
    expect(stderr.output()).toBe("");
    expect(JSON.parse(stdout.output())).toEqual({
      error: {
        code: "missing_repository_runtime_config",
        message:
          "No repository runtime configured. Run 'gh-symphony repo init' in the target repository.",
      },
    });
  });

  it("prints a friendly authentication error when gh auth is unavailable", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-explain-auth-"));
    const stderr = captureWrites(process.stderr);
    await seedRepoRuntime(configDir);
    vi.spyOn(ghAuth, "getGhToken").mockImplementation(() => {
      throw new ghAuth.GhAuthError(
        "not_authenticated",
        "gh is not authenticated."
      );
    });

    try {
      await repoExplainCommand(["acme/widgets#42"], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(process.exitCode).toBe(2);
    expect(stderr.output()).toContain(
      "GitHub authentication is required for repo explain"
    );
    expect(stderr.output()).toContain(
      "gh auth login --scopes repo,read:org,project"
    );
  });

  it("fails clearly instead of silently using default workflow settings", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-explain-workflow-"));
    const stderr = captureWrites(process.stderr);
    await seedRepoRuntime(configDir);
    vi.spyOn(ghAuth, "getGhToken").mockReturnValue("gho_test");
    vi.stubGlobal("fetch", vi.fn(mockProjectItemsFetch));

    try {
      await repoExplainCommand(["acme/widgets#42"], baseOptions(configDir));
    } finally {
      stderr.restore();
      vi.unstubAllGlobals();
    }

    expect(process.exitCode).toBe(2);
    expect(stderr.output()).toContain("No WORKFLOW.md path could be resolved");
    expect(stderr.output()).toContain("--workflow <path-to-WORKFLOW.md>");
  });

  it("uses an explicit workflow path for the explanation report", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-explain-explicit-"));
    const workflowDir = await mkdtemp(
      join(tmpdir(), "repo-explain-workflow-file-")
    );
    const workflowPath = join(workflowDir, "WORKFLOW.md");
    const stdout = captureWrites(process.stdout);
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github-project
  project_id: PVT_test
  state_field: Status
  active_states:
    - Ready
  terminal_states:
    - Done
agent:
  max_concurrent_agents: 2
codex:
  command: codex app-server
---
Follow the issue instructions.
`,
      "utf8"
    );
    await seedRepoRuntime(configDir);
    vi.spyOn(ghAuth, "getGhToken").mockReturnValue("gho_test");
    vi.stubGlobal("fetch", vi.fn(mockProjectItemsFetch));

    try {
      await repoExplainCommand(
        ["acme/widgets#42", "--workflow", workflowPath],
        baseOptions(configDir)
      );
    } finally {
      stdout.restore();
      vi.unstubAllGlobals();
    }

    expect(process.exitCode).toBeUndefined();
    expect(stdout.output()).toContain(
      "Dispatchable: no blocking project, workflow, runtime, or budget condition was found."
    );
    expect(stdout.output()).toContain(
      'Project state "Ready" maps to an active state in WORKFLOW.md.'
    );
    expect(stdout.output()).toContain("gh-symphony repo status");
    expect(stdout.output()).toContain("gh-symphony repo logs --issue");
  });

  it("derives blocker eligibility from the selected workflow", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-explain-blocked-"));
    const workflowDir = await mkdtemp(
      join(tmpdir(), "repo-explain-blocked-workflow-")
    );
    const workflowPath = join(workflowDir, "WORKFLOW.md");
    const stdout = captureWrites(process.stdout);
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github-project
  project_id: PVT_test
  state_field: Status
  active_states:
    - Ready
  terminal_states:
    - Done
  blocker_check_states:
    - Ready
agent:
  max_concurrent_agents: 2
codex:
  command: codex app-server
---
Follow the issue instructions.
`,
      "utf8"
    );
    await seedRepoRuntime(configDir);
    vi.spyOn(ghAuth, "getGhToken").mockReturnValue("gho_test");
    vi.stubGlobal("fetch", vi.fn(mockBlockedProjectItemsFetch));

    try {
      await repoExplainCommand(
        ["acme/widgets#42", "--workflow", workflowPath],
        baseOptions(configDir)
      );
    } finally {
      stdout.restore();
      vi.unstubAllGlobals();
    }

    expect(process.exitCode).toBeUndefined();
    expect(stdout.output()).toContain(
      "Not dispatchable: Blocked by unresolved GitHub issue: acme/widgets#41."
    );
  });

  it("uses the persisted repo workflow path for the explanation report", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-explain-persisted-"));
    const workflowDir = await mkdtemp(
      join(tmpdir(), "repo-explain-persisted-workflow-")
    );
    const workflowPath = join(workflowDir, "custom-workflow.md");
    const stdout = captureWrites(process.stdout);
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github-project
  project_id: PVT_test
  state_field: Status
  active_states:
    - Ready
  terminal_states:
    - Done
agent:
  max_concurrent_agents: 2
codex:
  command: $SYMPHONY_REPO_EXPLAIN_COMMAND
---
Follow the issue instructions.
`,
      "utf8"
    );
    await seedRepoRuntime(configDir, workflowPath);
    const projectDir = join(configDir, "projects", "repository");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, ".env"),
      "SYMPHONY_REPO_EXPLAIN_COMMAND=codex app-server\n",
      "utf8"
    );
    vi.spyOn(ghAuth, "getGhToken").mockReturnValue("gho_test");
    vi.stubGlobal("fetch", vi.fn(mockProjectItemsFetch));

    try {
      await repoExplainCommand(["acme/widgets#42"], baseOptions(configDir));
    } finally {
      stdout.restore();
      vi.unstubAllGlobals();
    }

    expect(process.exitCode).toBeUndefined();
    expect(stdout.output()).toContain(
      "Dispatchable: no blocking project, workflow, runtime, or budget condition was found."
    );
  });
});

async function seedRepoRuntime(
  configDir: string,
  workflowPath?: string
): Promise<void> {
  const projectId = "repository";
  await saveGlobalConfig(configDir, {
    activeProject: projectId,
    projects: [projectId],
  });
  await saveProjectConfig(configDir, projectId, {
    projectId,
    slug: projectId,
    displayName: "acme/widgets",
    workspaceDir: join(configDir, "workspaces"),
    repository: {
      owner: "acme",
      name: "widgets",
      cloneUrl: "https://github.com/acme/widgets.git",
    },
    tracker: {
      adapter: "github-project",
      bindingId: "PVT_test",
      settings: {
        projectId: "PVT_test",
      },
    },
    ...(workflowPath
      ? { workflowSource: { type: "repo" as const, path: workflowPath } }
      : {}),
  });
}

async function mockProjectItemsFetch(
  _input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const body =
    typeof init?.body === "string"
      ? (JSON.parse(init.body) as { query?: string })
      : {};
  const query = body.query ?? "";
  if (query.includes("RepositoryIssue")) {
    return jsonResponse({
      data: {
        repository: {
          issue: {
            ...mockIssueContent(),
            projectItems: {
              nodes: [mockIssueProjectItem()],
              pageInfo: {
                endCursor: null,
                hasNextPage: false,
              },
            },
          },
        },
      },
    });
  }

  return jsonResponse({
    data: {
      node: {
        __typename: "ProjectV2",
        items: {
          nodes: [
            {
              ...mockIssueProjectItem(),
              content: mockIssueContent(),
            },
          ],
          pageInfo: {
            endCursor: null,
            hasNextPage: false,
          },
        },
      },
    },
  });
}

async function mockBlockedProjectItemsFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const response = await mockProjectItemsFetch(input, init);
  const payload = (await response.json()) as Record<string, unknown>;
  const data = payload.data as {
    node?: { items?: { nodes?: unknown[] }; repository?: unknown };
  };
  const item = data.node?.items?.nodes?.[0] as
    | {
        content?: { blockedBy?: { nodes?: unknown[] } };
      }
    | undefined;
  if (item?.content) {
    item.content.blockedBy = {
      nodes: [
        {
          id: "I_41",
          number: 41,
          state: "OPEN",
          repository: {
            name: "widgets",
            owner: { login: "acme" },
          },
        },
      ],
    };
  }
  return jsonResponse(payload);
}

function mockIssueProjectItem() {
  return {
    id: "PVTI_item_42",
    updatedAt: "2026-05-07T00:00:00.000Z",
    project: {
      id: "PVT_test",
    },
    fieldValues: {
      nodes: [
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          name: "Ready",
          optionId: "ready",
          field: {
            name: "Status",
          },
        },
      ],
    },
  };
}

function mockIssueContent() {
  return {
    __typename: "Issue",
    id: "I_42",
    number: 42,
    title: "Make widgets responsive",
    body: "Issue body",
    url: "https://github.com/acme/widgets/issues/42",
    createdAt: "2026-05-06T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    labels: { nodes: [] },
    assignees: { nodes: [] },
    repository: {
      name: "widgets",
      url: "https://github.com/acme/widgets",
      owner: { login: "acme" },
    },
    blockedBy: { nodes: [] },
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}
