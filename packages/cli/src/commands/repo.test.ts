import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  projectConfigPath,
  saveGlobalConfig,
  saveProjectConfig,
  type CliProjectConfig,
} from "../config.js";

type RepoConfigEntry = CliProjectConfig["repositories"][number];

const githubClientMock = vi.hoisted(() => ({
  createClient: vi.fn(),
  validateToken: vi.fn(),
  checkRequiredScopes: vi.fn(),
  getProjectDetail: vi.fn(),
}));

vi.mock("../github/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github/client.js")>();
  return {
    ...actual,
    createClient: githubClientMock.createClient,
    validateToken: githubClientMock.validateToken,
    checkRequiredScopes: githubClientMock.checkRequiredScopes,
    getProjectDetail: githubClientMock.getProjectDetail,
  };
});

async function loadRepoCommand() {
  vi.resetModules();
  const mod = await import("./repo.js");
  return mod.default;
}

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

function createProjectConfig(repositories: CliProjectConfig["repositories"]): CliProjectConfig {
  return {
    projectId: "managed-project",
    slug: "managed-project",
    displayName: "Managed Project",
    workspaceDir: join(tmpdir(), "managed-project"),
    repositories,
    tracker: {
      adapter: "github-project",
      bindingId: "PVT_project_123",
      settings: {
        projectId: "PVT_project_123",
      },
    },
  };
}

async function seedActiveProject(
  configDir: string,
  repositories: CliProjectConfig["repositories"]
): Promise<void> {
  await saveGlobalConfig(configDir, {
    activeProject: "managed-project",
    projects: ["managed-project"],
  });
  await saveProjectConfig(
    configDir,
    "managed-project",
    createProjectConfig(repositories)
  );
}

describe("repo sync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.GITHUB_GRAPHQL_TOKEN;
    process.exitCode = undefined;
  });

  it("adds newly linked repositories in additive mode and keeps local-only entries", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-sync-additive-"));
    const stdout = captureWrites(process.stdout);
    const repoCommand = await loadRepoCommand();

    await seedActiveProject(configDir, [
      {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
      {
        owner: "acme",
        name: "legacy-tools",
        cloneUrl: "https://github.com/acme/legacy-tools.git",
      },
    ]);

    process.env.GITHUB_GRAPHQL_TOKEN = "gho_test";
    githubClientMock.createClient.mockReturnValue({ token: "gho_test" });
    githubClientMock.validateToken.mockResolvedValue({
      login: "octocat",
      name: "Octocat",
      scopes: ["repo", "read:org", "project"],
    });
    githubClientMock.checkRequiredScopes.mockReturnValue({
      valid: true,
      missing: [],
    });
    githubClientMock.getProjectDetail.mockResolvedValue({
      id: "PVT_project_123",
      title: "Acme Project",
      url: "https://github.com/orgs/acme/projects/1",
      statusFields: [],
      textFields: [],
      linkedRepositories: [
        {
          owner: "acme",
          name: "platform",
          url: "https://github.com/acme/platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        {
          owner: "acme",
          name: "api",
          url: "https://github.com/acme/api",
          cloneUrl: "https://github.com/acme/api.git",
        },
      ],
    });

    try {
      await repoCommand(["sync"], baseOptions(configDir));
    } finally {
      stdout.restore();
    }

    const saved = JSON.parse(
      await readFile(projectConfigPath(configDir, "managed-project"), "utf8")
    ) as CliProjectConfig;

    expect(saved.repositories).toEqual([
      {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
      {
        owner: "acme",
        name: "legacy-tools",
        cloneUrl: "https://github.com/acme/legacy-tools.git",
      },
      {
        owner: "acme",
        name: "api",
        cloneUrl: "https://github.com/acme/api.git",
      },
    ]);
    expect(stdout.output()).toContain("Repository sync complete for managed-project");
    expect(stdout.output()).toContain("Mode: additive");
    expect(stdout.output()).toContain("Added");
    expect(stdout.output()).toContain("acme/api");
    expect(stdout.output()).toContain("Unchanged");
    expect(stdout.output()).toContain("acme/legacy-tools");
  });

  it("reports planned changes without writing config in dry-run mode", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-sync-dry-run-"));
    const stdout = captureWrites(process.stdout);
    const repoCommand = await loadRepoCommand();

    await seedActiveProject(configDir, [
      {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
    ]);

    process.env.GITHUB_GRAPHQL_TOKEN = "gho_test";
    githubClientMock.createClient.mockReturnValue({ token: "gho_test" });
    githubClientMock.validateToken.mockResolvedValue({
      login: "octocat",
      name: "Octocat",
      scopes: ["repo", "read:org", "project"],
    });
    githubClientMock.checkRequiredScopes.mockReturnValue({
      valid: true,
      missing: [],
    });
    githubClientMock.getProjectDetail.mockResolvedValue({
      id: "PVT_project_123",
      title: "Acme Project",
      url: "https://github.com/orgs/acme/projects/1",
      statusFields: [],
      textFields: [],
      linkedRepositories: [
        {
          owner: "acme",
          name: "platform",
          url: "https://github.com/acme/platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        {
          owner: "acme",
          name: "api",
          url: "https://github.com/acme/api",
          cloneUrl: "https://github.com/acme/api.git",
        },
      ],
    });

    try {
      await repoCommand(["sync", "--dry-run"], baseOptions(configDir));
    } finally {
      stdout.restore();
    }

    const saved = JSON.parse(
      await readFile(projectConfigPath(configDir, "managed-project"), "utf8")
    ) as CliProjectConfig;

    expect(saved.repositories).toEqual([
      {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
    ]);
    expect(stdout.output()).toContain("Repository sync preview for managed-project");
    expect(stdout.output()).toContain("No config changes written.");
  });

  it("prunes removed repositories and emits structured JSON output", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-sync-prune-"));
    const stdout = captureWrites(process.stdout);
    const repoCommand = await loadRepoCommand();

    await seedActiveProject(configDir, [
      {
        owner: "acme",
        name: "legacy-tools",
        cloneUrl: "https://github.com/acme/legacy-tools.git",
      },
      {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
    ]);

    process.env.GITHUB_GRAPHQL_TOKEN = "gho_test";
    githubClientMock.createClient.mockReturnValue({ token: "gho_test" });
    githubClientMock.validateToken.mockResolvedValue({
      login: "octocat",
      name: "Octocat",
      scopes: ["repo", "read:org", "project"],
    });
    githubClientMock.checkRequiredScopes.mockReturnValue({
      valid: true,
      missing: [],
    });
    githubClientMock.getProjectDetail.mockResolvedValue({
      id: "PVT_project_123",
      title: "Acme Project",
      url: "https://github.com/orgs/acme/projects/1",
      statusFields: [],
      textFields: [],
      linkedRepositories: [
        {
          owner: "acme",
          name: "platform",
          url: "https://github.com/acme/platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        {
          owner: "acme",
          name: "api",
          url: "https://github.com/acme/api",
          cloneUrl: "https://github.com/acme/api.git",
        },
      ],
    });

    try {
      await repoCommand(["sync", "--prune"], {
        ...baseOptions(configDir),
        json: true,
      });
    } finally {
      stdout.restore();
    }

    const saved = JSON.parse(
      await readFile(projectConfigPath(configDir, "managed-project"), "utf8")
    ) as CliProjectConfig;
    const output = JSON.parse(stdout.output()) as {
      projectId: string;
      githubProjectId: string;
      dryRun: boolean;
      prune: boolean;
      added: RepoConfigEntry[];
      removed: RepoConfigEntry[];
      unchanged: RepoConfigEntry[];
      repositories: RepoConfigEntry[];
    };

    expect(saved.repositories).toEqual([
      {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
      {
        owner: "acme",
        name: "api",
        cloneUrl: "https://github.com/acme/api.git",
      },
    ]);
    expect(output).toEqual({
      projectId: "managed-project",
      githubProjectId: "PVT_project_123",
      dryRun: false,
      prune: true,
      added: [
        {
          owner: "acme",
          name: "api",
          cloneUrl: "https://github.com/acme/api.git",
        },
      ],
      removed: [
        {
          owner: "acme",
          name: "legacy-tools",
          cloneUrl: "https://github.com/acme/legacy-tools.git",
        },
      ],
      unchanged: [
        {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
      ],
      repositories: [
        {
          owner: "acme",
          name: "platform",
          cloneUrl: "https://github.com/acme/platform.git",
        },
        {
          owner: "acme",
          name: "api",
          cloneUrl: "https://github.com/acme/api.git",
        },
      ],
    });
  });

  it("fails when the active project has no GitHub Project binding", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-sync-missing-binding-"));
    const stderr = captureWrites(process.stderr);
    const repoCommand = await loadRepoCommand();

    await saveGlobalConfig(configDir, {
      activeProject: "managed-project",
      projects: ["managed-project"],
    });
    await saveProjectConfig(configDir, "managed-project", {
      ...createProjectConfig([]),
      tracker: {
        adapter: "github-project",
        bindingId: "",
        settings: {},
      },
    });

    try {
      await repoCommand(["sync"], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(process.exitCode).toBe(1);
    expect(stderr.output()).toContain("Active project is missing its GitHub Project binding");
  });
});
