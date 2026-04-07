import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectStatusSnapshot } from "@gh-symphony/core";
vi.mock("@clack/prompts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clack/prompts")>();

  return {
    ...actual,
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    note: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    multiselect: vi.fn(),
    text: vi.fn(),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
    })),
    log: {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      step: vi.fn(),
      success: vi.fn(),
      message: vi.fn(),
    },
  };
});

import projectCommand from "./project.js";
import * as p from "@clack/prompts";
import {
  saveGlobalConfig,
  saveProjectConfig,
  type CliProjectConfig,
} from "../config.js";
import * as ghAuth from "../github/gh-auth.js";
import * as githubClient from "../github/client.js";
import { generateProjectId } from "./init.js";

function captureWrites(stream: NodeJS.WriteStream): {
  output: () => string;
  restore: () => void;
} {
  let buffer = "";
  const spy = vi
    .spyOn(stream, "write")
    .mockImplementation(((chunk: string | Uint8Array) => {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof stream.write);

  return {
    output: () => buffer,
    restore: () => spy.mockRestore(),
  };
}

async function seedProject(
  configDir: string,
  input: {
    projectId: string;
    displayName: string;
    pid?: number;
    snapshot?: ProjectStatusSnapshot;
    endpoint?: string;
  }
): Promise<void> {
  const project: CliProjectConfig = {
    projectId: input.projectId,
    slug: input.projectId,
    displayName: input.displayName,
    workspaceDir: join(configDir, "workspaces"),
    repositories: [],
    tracker: {
      adapter: "github-project",
      bindingId: `binding-${input.projectId}`,
    },
  };

  await saveProjectConfig(configDir, input.projectId, project);

  if (input.pid !== undefined) {
    await writeFile(
      join(configDir, "projects", input.projectId, "daemon.pid"),
      `${input.pid}\n`,
      "utf8"
    );
  }

  if (input.snapshot) {
    const runtimeDir = join(
      configDir,
      "projects",
      input.projectId
    );
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      join(runtimeDir, "status.json"),
      JSON.stringify(input.snapshot, null, 2) + "\n",
      "utf8"
    );
  }

  if (input.endpoint) {
    const httpRuntimeDir = join(
      configDir,
      "orchestrator",
      "workspaces",
      input.projectId
    );
    await mkdir(httpRuntimeDir, { recursive: true });
    await writeFile(
      join(httpRuntimeDir, "http.json"),
      JSON.stringify(
        {
          host: "127.0.0.1",
          port: Number.parseInt(new URL(input.endpoint).port, 10),
          endpoint: input.endpoint,
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  }
}

describe("project list", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T14:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a table with running and stopped project states", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "project-list-"));
    const stdout = captureWrites(process.stdout);

    await saveGlobalConfig(configDir, {
      activeProject: "backend-a1b2",
      projects: ["backend-a1b2", "front-c3d4"],
    });

    await seedProject(configDir, {
      projectId: "backend-a1b2",
      displayName: "Backend Tasks",
      pid: process.pid,
      endpoint: "http://localhost:4680",
      snapshot: {
        projectId: "backend-a1b2",
        slug: "backend-a1b2",
        tracker: { adapter: "github-project", bindingId: "project-1" },
        lastTickAt: "2026-03-15T13:58:00.000Z",
        health: "running",
        summary: { dispatched: 1, suppressed: 0, recovered: 0, activeRuns: 2 },
        activeRuns: [],
        retryQueue: [],
        lastError: null,
      },
    });

    await seedProject(configDir, {
      projectId: "front-c3d4",
      displayName: "Frontend Features",
      pid: 999999,
    });

    try {
      await projectCommand(["list"], {
        configDir,
        verbose: false,
        json: false,
        noColor: true,
      });
    } finally {
      stdout.restore();
    }

    const output = stdout.output();
    expect(output).toContain("│ ID");
    expect(output).toContain("Backend Tasks");
    expect(output).toContain("Frontend Features");
    expect(output).toContain("running");
    expect(output).toContain("stopped");
    expect(output).toContain("2m ago");
    expect(output).toContain("│ running ");
    expect(output).toContain("│ 2 ");
    expect(output).toContain("Endpoint");
    expect(output).toContain("http://localhost:4680");
    expect(output).toContain("│ - ");
  });

  it("emits structured JSON rows with persisted status metadata", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "project-list-json-"));
    const stdout = captureWrites(process.stdout);

    await saveGlobalConfig(configDir, {
      activeProject: "infra-e5f6",
      projects: ["infra-e5f6"],
    });

    await seedProject(configDir, {
      projectId: "infra-e5f6",
      displayName: "Infra Automation",
      pid: process.pid,
      endpoint: "http://localhost:4680",
      snapshot: {
        projectId: "infra-e5f6",
        slug: "infra-e5f6",
        tracker: { adapter: "github-project", bindingId: "project-2" },
        lastTickAt: "2026-03-15T13:59:30.000Z",
        health: "idle",
        summary: { dispatched: 0, suppressed: 0, recovered: 0, activeRuns: 0 },
        activeRuns: [],
        retryQueue: [],
        lastError: null,
      },
    });

    try {
      await projectCommand(["list"], {
        configDir,
        verbose: false,
        json: true,
        noColor: true,
      });
    } finally {
      stdout.restore();
    }

    const output = JSON.parse(stdout.output()) as Array<Record<string, unknown>>;
    expect(output).toEqual([
      expect.objectContaining({
        id: "infra-e5f6",
        name: "Infra Automation",
        status: "running",
        health: "idle",
        activeRuns: 0,
        lastTick: "30s ago",
        endpoint: "http://localhost:4680",
        active: true,
      }),
    ]);
    expect(typeof output[0]?.uptime).toBe("string");
  });

  it("emits nulls for unknown runtime fields in JSON mode", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "project-list-json-stopped-"));
    const stdout = captureWrites(process.stdout);

    await saveGlobalConfig(configDir, {
      activeProject: null,
      projects: ["front-c3d4"],
    });

    await seedProject(configDir, {
      projectId: "front-c3d4",
      displayName: "프론트엔드 기능",
      pid: 999999,
    });

    try {
      await projectCommand(["list"], {
        configDir,
        verbose: false,
        json: true,
        noColor: true,
      });
    } finally {
      stdout.restore();
    }

    const output = JSON.parse(stdout.output()) as Array<Record<string, unknown>>;
    expect(output).toEqual([
      {
        id: "front-c3d4",
        name: "프론트엔드 기능",
        status: "stopped",
        health: "-",
        activeRuns: null,
        lastTick: "-",
        uptime: "-",
        endpoint: null,
        active: false,
      },
    ]);
  });

  it("omits the endpoint column when no project has HTTP enabled", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "project-list-no-http-"));
    const stdout = captureWrites(process.stdout);

    await saveGlobalConfig(configDir, {
      activeProject: null,
      projects: ["front-c3d4"],
    });

    await seedProject(configDir, {
      projectId: "front-c3d4",
      displayName: "Frontend Features",
      pid: 999999,
    });

    try {
      await projectCommand(["list"], {
        configDir,
        verbose: false,
        json: false,
        noColor: true,
      });
    } finally {
      stdout.restore();
    }

    expect(stdout.output()).not.toContain("Endpoint");
  });
});

const MOCK_PROJECT_SUMMARY = {
  id: "PVT_project_1",
  title: "My Project",
  owner: { login: "acme", type: "Organization" as const },
  openItemCount: 12,
  url: "https://github.com/orgs/acme/projects/1",
};

const MOCK_REPOS = [
  {
    owner: "acme",
    name: "repo-a",
    url: "https://github.com/acme/repo-a",
    cloneUrl: "https://github.com/acme/repo-a.git",
  },
  {
    owner: "acme",
    name: "repo-b",
    url: "https://github.com/acme/repo-b",
    cloneUrl: "https://github.com/acme/repo-b.git",
  },
  {
    owner: "acme",
    name: "repo-c",
    url: "https://github.com/acme/repo-c",
    cloneUrl: "https://github.com/acme/repo-c.git",
  },
];

const MOCK_PROJECT_DETAIL = {
  id: "PVT_project_1",
  title: "My Project",
  url: "https://github.com/orgs/acme/projects/1",
  statusFields: [],
  textFields: [],
  linkedRepositories: MOCK_REPOS,
};

const EMPTY_PROJECT_DETAIL = {
  ...MOCK_PROJECT_DETAIL,
  id: "PVT_project_empty",
  title: "Empty Project",
  linkedRepositories: [],
};

function mockSpinner() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
  };
}

describe("project add interactive", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    vi.mocked(p.intro).mockImplementation(() => undefined);
    vi.mocked(p.outro).mockImplementation(() => undefined);
    vi.mocked(p.cancel).mockImplementation(() => undefined);
    vi.mocked(p.note).mockImplementation(() => undefined);
    vi.mocked(p.spinner).mockImplementation(mockSpinner);
    vi.mocked(p.log.error).mockImplementation(() => undefined);
    vi.mocked(p.log.warn).mockImplementation(() => undefined);
    vi.spyOn(ghAuth, "resolveGitHubAuth").mockResolvedValue({
      source: "gh",
      login: "stevelee",
      token: "test-token",
      scopes: ["repo", "read:org", "project"],
    });
    vi.spyOn(githubClient, "createClient").mockReturnValue({} as never);
    vi.spyOn(githubClient, "listUserProjects").mockResolvedValue([
      MOCK_PROJECT_SUMMARY,
    ]);
    vi.spyOn(githubClient, "getProjectDetail").mockResolvedValue(
      MOCK_PROJECT_DETAIL
    );
  });

  it("uses all linked repositories and the default workspace when advanced options are skipped", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "project-add-default-"));
    const projectId = generateProjectId(
      MOCK_PROJECT_DETAIL.title,
      MOCK_PROJECT_DETAIL.id
    );
    const selectSpy = vi
      .mocked(p.select)
      .mockResolvedValue(MOCK_PROJECT_SUMMARY.id as never);
    const confirmSpy = vi
      .mocked(p.confirm)
      .mockResolvedValueOnce(false as never)
      .mockResolvedValueOnce(false as never)
      .mockResolvedValueOnce(true as never);

    await projectCommand(["add"], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    const project = JSON.parse(
      await readFile(
        join(
          configDir,
          "projects",
          projectId,
          "project.json"
        ),
        "utf8"
      )
    ) as CliProjectConfig;

    expect(selectSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Step 1/2 - Select a GitHub Project board:",
      })
    );
    expect(confirmSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        message:
          "Step 2/2 - Only process issues assigned to the authenticated GitHub user?",
      })
    );
    expect(confirmSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: "Customize advanced options? (default: No)",
      })
    );
    expect(p.multiselect).not.toHaveBeenCalled();
    expect(p.text).not.toHaveBeenCalled();
    expect(project.workspaceDir).toBe(join(configDir, "workspaces"));
    expect(project.repositories).toHaveLength(3);
    expect(project.repositories.map((repo) => repo.name)).toEqual([
      "repo-a",
      "repo-b",
      "repo-c",
    ]);
    expect(p.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Repos:      acme/repo-a, acme/repo-b, acme/repo-c  (all 3 linked)"
      ),
      "Configuration Summary"
    );
  });

  it("shows advanced repository and workspace prompts only when customization is enabled", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "project-add-advanced-"));
    const projectId = generateProjectId(
      MOCK_PROJECT_DETAIL.title,
      MOCK_PROJECT_DETAIL.id
    );
    const confirmSpy = vi
      .mocked(p.confirm)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(true as never);
    const multiselectSpy = vi
      .mocked(p.multiselect)
      .mockResolvedValue([MOCK_REPOS[1], MOCK_REPOS[2]] as never);
    const textSpy = vi
      .mocked(p.text)
      .mockResolvedValue("/tmp/custom-workspaces" as never);
    vi.mocked(p.select).mockResolvedValue(MOCK_PROJECT_SUMMARY.id as never);

    await projectCommand(["add"], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    const project = JSON.parse(
      await readFile(
        join(
          configDir,
          "projects",
          projectId,
          "project.json"
        ),
        "utf8"
      )
    ) as CliProjectConfig;

    expect(confirmSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: "Customize advanced options? (default: No)",
      })
    );
    expect(confirmSpy).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        message: "Filter specific repositories? (default: No)",
      })
    );
    expect(multiselectSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Select repositories to orchestrate:",
      })
    );
    expect(textSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Workspace root directory:",
        defaultValue: join(configDir, "workspaces"),
      })
    );
    expect(project.workspaceDir).toBe("/tmp/custom-workspaces");
    expect(project.repositories.map((repo) => repo.name)).toEqual([
      "repo-b",
      "repo-c",
    ]);
    expect(p.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "Repos:      acme/repo-b, acme/repo-c  (2 of 3 linked)"
      ),
      "Configuration Summary"
    );
  });

  it("does not skip step numbering when advanced options keep all repositories", async () => {
    const configDir = await mkdtemp(
      join(tmpdir(), "project-add-advanced-default-repos-")
    );
    const projectId = generateProjectId(
      MOCK_PROJECT_DETAIL.title,
      MOCK_PROJECT_DETAIL.id
    );
    const confirmSpy = vi
      .mocked(p.confirm)
      .mockResolvedValueOnce(false as never)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(false as never)
      .mockResolvedValueOnce(true as never);
    const textSpy = vi
      .mocked(p.text)
      .mockResolvedValue(join(configDir, "custom-workspaces") as never);
    vi.mocked(p.select).mockResolvedValue(MOCK_PROJECT_SUMMARY.id as never);

    await projectCommand(["add"], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    const project = JSON.parse(
      await readFile(
        join(configDir, "projects", projectId, "project.json"),
        "utf8"
      )
    ) as CliProjectConfig;

    expect(confirmSpy).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        message: "Filter specific repositories? (default: No)",
      })
    );
    expect(p.multiselect).not.toHaveBeenCalled();
    expect(textSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Workspace root directory:",
        defaultValue: join(configDir, "workspaces"),
      })
    );
    expect(project.repositories).toHaveLength(3);
    expect(project.workspaceDir).toBe(join(configDir, "custom-workspaces"));
  });

  it("uses --assigned-only as the interactive prompt default", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "project-add-assigned-only-"));
    const projectId = generateProjectId(
      MOCK_PROJECT_DETAIL.title,
      MOCK_PROJECT_DETAIL.id
    );
    vi.mocked(p.select).mockResolvedValue(MOCK_PROJECT_SUMMARY.id as never);
    vi.mocked(p.confirm)
      .mockResolvedValueOnce(true as never)
      .mockResolvedValueOnce(false as never)
      .mockResolvedValueOnce(true as never);

    await projectCommand(["add", "--assigned-only"], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    const project = JSON.parse(
      await readFile(join(configDir, "projects", projectId, "project.json"), "utf8")
    ) as CliProjectConfig;

    expect(project.tracker.settings?.assignedOnly).toBe(true);
    expect(vi.mocked(p.confirm).mock.calls[0]?.[0]).toMatchObject({
      message:
        "Step 2/2 - Only process issues assigned to the authenticated GitHub user?",
      initialValue: true,
    });
  });

  it("allows saving a project with no linked repositories and shows next actions", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "project-add-empty-"));
    const projectId = generateProjectId(
      EMPTY_PROJECT_DETAIL.title,
      EMPTY_PROJECT_DETAIL.id
    );
    vi.spyOn(githubClient, "getProjectDetail").mockResolvedValue(
      EMPTY_PROJECT_DETAIL
    );
    vi.mocked(p.select).mockResolvedValue(MOCK_PROJECT_SUMMARY.id as never);
    const confirmSpy = vi
      .mocked(p.confirm)
      .mockResolvedValueOnce(false as never)
      .mockResolvedValueOnce(false as never)
      .mockResolvedValueOnce(true as never);

    await projectCommand(["add"], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    const project = JSON.parse(
      await readFile(join(configDir, "projects", projectId, "project.json"), "utf8")
    ) as CliProjectConfig;

    expect(confirmSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: "Customize advanced options? (default: No)",
      })
    );
    expect(project.repositories).toEqual([]);
    expect(p.log.warn).toHaveBeenCalledWith(
      "No linked repositories found in this project yet. You can save it now and add repositories later with 'gh-symphony repo add <owner/name>' or by adding a repo-linked issue to the GitHub Project."
    );
    expect(p.note).toHaveBeenCalledWith(
      expect.stringContaining("Repos:      none linked yet (0 linked)"),
      "Configuration Summary"
    );
    expect(p.outro).toHaveBeenCalledWith(
      expect.stringContaining(`Project "${projectId}" created with 0 repositories.`)
    );
    expect(p.outro).toHaveBeenCalledWith(
      expect.stringContaining("gh-symphony repo add <owner/name>")
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("reports env auth usage when GITHUB_GRAPHQL_TOKEN is selected", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "project-add-env-auth-"));
    const authSpinner = mockSpinner();
    vi.mocked(p.spinner)
      .mockReturnValueOnce(authSpinner as never)
      .mockImplementation(mockSpinner);
    vi.spyOn(ghAuth, "resolveGitHubAuth").mockResolvedValue({
      source: "env",
      login: "env-user",
      token: "env-token",
      scopes: ["repo", "read:org", "project"],
    });
    const ensureSpy = vi.spyOn(ghAuth, "ensureGhAuth");
    vi.mocked(p.select).mockResolvedValue(MOCK_PROJECT_SUMMARY.id as never);
    vi.mocked(p.confirm)
      .mockResolvedValueOnce(false as never)
      .mockResolvedValueOnce(false as never)
      .mockResolvedValueOnce(true as never);

    await projectCommand(["add"], {
      configDir,
      verbose: false,
      json: false,
      noColor: true,
    });

    expect(ensureSpy).not.toHaveBeenCalled();
    expect(authSpinner.start).toHaveBeenCalledWith(
      "Checking GitHub authentication..."
    );
    expect(authSpinner.stop).toHaveBeenCalledWith(
      "Authenticated via GITHUB_GRAPHQL_TOKEN as env-user"
    );
  });
});

describe("project add non-interactive", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    vi.spyOn(ghAuth, "getGhToken").mockReturnValue("test-token");
    vi.spyOn(githubClient, "createClient").mockReturnValue({} as never);
    vi.spyOn(githubClient, "validateToken").mockResolvedValue({
      login: "stevelee",
      scopes: ["repo", "read:org", "project"],
    } as never);
    vi.spyOn(githubClient, "checkRequiredScopes").mockReturnValue({
      valid: true,
      missing: [],
    });
    vi.spyOn(githubClient, "listUserProjects").mockResolvedValue([
      MOCK_PROJECT_SUMMARY,
    ]);
  });

  it("prints zero-repository completion guidance in non-interactive mode", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "project-add-non-interactive-empty-"));
    const stdout = captureWrites(process.stdout);
    const projectId = generateProjectId(
      EMPTY_PROJECT_DETAIL.title,
      EMPTY_PROJECT_DETAIL.id
    );
    vi.spyOn(githubClient, "getProjectDetail").mockResolvedValue(
      EMPTY_PROJECT_DETAIL
    );

    try {
      await projectCommand(
        ["add", "--non-interactive", "--project", MOCK_PROJECT_SUMMARY.id],
        {
          configDir,
          verbose: false,
          json: false,
          noColor: true,
        }
      );
    } finally {
      stdout.restore();
    }

    const project = JSON.parse(
      await readFile(join(configDir, "projects", projectId, "project.json"), "utf8")
    ) as CliProjectConfig;

    expect(project.repositories).toEqual([]);
    expect(stdout.output()).toContain(
      `Project "${projectId}" created with 0 repositories.`
    );
    expect(stdout.output()).toContain("gh-symphony repo add <owner/name>");
    expect(stdout.output()).toContain(
      "Or add a repo-linked issue to the GitHub Project and re-run setup later."
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("prints repository count without zero-repository follow-up when linked repositories exist", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "project-add-non-interactive-linked-"));
    const stdout = captureWrites(process.stdout);
    const projectId = generateProjectId(
      MOCK_PROJECT_DETAIL.title,
      MOCK_PROJECT_DETAIL.id
    );
    vi.spyOn(githubClient, "getProjectDetail").mockResolvedValue(
      MOCK_PROJECT_DETAIL
    );

    try {
      await projectCommand(
        ["add", "--non-interactive", "--project", MOCK_PROJECT_DETAIL.url],
        {
          configDir,
          verbose: false,
          json: false,
          noColor: true,
        }
      );
    } finally {
      stdout.restore();
    }

    const project = JSON.parse(
      await readFile(join(configDir, "projects", projectId, "project.json"), "utf8")
    ) as CliProjectConfig;

    expect(project.repositories).toHaveLength(3);
    expect(stdout.output()).toContain(
      `Project "${projectId}" created with 3 repositories.`
    );
    expect(stdout.output()).toContain(
      "Run 'gh-symphony start' to begin orchestration."
    );
    expect(stdout.output()).not.toContain("gh-symphony repo add <owner/name>");
    expect(process.exitCode).toBeUndefined();
  });
});
