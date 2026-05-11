import { mkdtemp, writeFile } from "node:fs/promises";
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
});

async function seedRepoRuntime(configDir: string): Promise<void> {
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
