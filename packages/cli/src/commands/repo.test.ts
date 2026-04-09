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
  getRepositoryMetadata: vi.fn(),
}));

const ghAuthMock = vi.hoisted(() => ({
  getGhToken: vi.fn(),
}));

vi.mock("../github/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github/client.js")>();
  return {
    ...actual,
    createClient: githubClientMock.createClient,
    validateToken: githubClientMock.validateToken,
    checkRequiredScopes: githubClientMock.checkRequiredScopes,
    getProjectDetail: githubClientMock.getProjectDetail,
    getRepositoryMetadata: githubClientMock.getRepositoryMetadata,
  };
});

vi.mock("../github/gh-auth.js", () => ({
  getGhToken: ghAuthMock.getGhToken,
}));

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
    ghAuthMock.getGhToken.mockReset();
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
    ghAuthMock.getGhToken.mockReturnValue("gho_test");
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
    ghAuthMock.getGhToken.mockReturnValue("gho_test");
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
    ghAuthMock.getGhToken.mockReturnValue("gho_test");
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
          name: "api",
          url: "https://github.com/acme/api",
          cloneUrl: "https://github.com/acme/api.git",
        },
        {
          owner: "acme",
          name: "platform",
          url: "https://github.com/acme/platform",
          cloneUrl: "https://github.com/acme/platform.git",
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

  it("preserves existing order for retained repositories in prune mode", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-sync-prune-order-"));
    const repoCommand = await loadRepoCommand();

    await seedActiveProject(configDir, [
      {
        owner: "acme",
        name: "zeta",
        cloneUrl: "https://github.com/acme/zeta.git",
      },
      {
        owner: "acme",
        name: "alpha",
        cloneUrl: "https://github.com/acme/alpha.git",
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
          name: "beta",
          url: "https://github.com/acme/beta",
          cloneUrl: "https://github.com/acme/beta.git",
        },
        {
          owner: "acme",
          name: "alpha",
          url: "https://github.com/acme/alpha",
          cloneUrl: "https://github.com/acme/alpha.git",
        },
        {
          owner: "acme",
          name: "zeta",
          url: "https://github.com/acme/zeta",
          cloneUrl: "https://github.com/acme/zeta.git",
        },
      ],
    });

    await repoCommand(["sync", "--prune"], baseOptions(configDir));

    const saved = JSON.parse(
      await readFile(projectConfigPath(configDir, "managed-project"), "utf8")
    ) as CliProjectConfig;

    expect(saved.repositories).toEqual([
      {
        owner: "acme",
        name: "zeta",
        cloneUrl: "https://github.com/acme/zeta.git",
      },
      {
        owner: "acme",
        name: "alpha",
        cloneUrl: "https://github.com/acme/alpha.git",
      },
      {
        owner: "acme",
        name: "beta",
        cloneUrl: "https://github.com/acme/beta.git",
      },
    ]);
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

describe("repo add", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    ghAuthMock.getGhToken.mockReset();
    delete process.env.GITHUB_GRAPHQL_TOKEN;
    process.exitCode = undefined;
  });

  it("stores canonical repository metadata after validation", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-add-validated-"));
    const stdout = captureWrites(process.stdout);
    const repoCommand = await loadRepoCommand();

    await seedActiveProject(configDir, []);
    process.env.GITHUB_GRAPHQL_TOKEN = "gho_test";
    ghAuthMock.getGhToken.mockReturnValue("gho_test");
    githubClientMock.createClient.mockReturnValue({ token: "gho_test" });
    githubClientMock.getRepositoryMetadata.mockResolvedValue({
      owner: "AcmeOrg",
      name: "Platform",
      url: "https://github.com/AcmeOrg/Platform",
      cloneUrl: "https://github.com/AcmeOrg/Platform.git",
      visibility: "private",
    });

    try {
      await repoCommand(["add", "acmeorg/platform"], baseOptions(configDir));
    } finally {
      stdout.restore();
    }

    const saved = JSON.parse(
      await readFile(projectConfigPath(configDir, "managed-project"), "utf8")
    ) as CliProjectConfig;

    expect(githubClientMock.getRepositoryMetadata).toHaveBeenCalledWith(
      { token: "gho_test" },
      "acmeorg",
      "platform"
    );
    expect(saved.repositories).toEqual([
      {
        owner: "AcmeOrg",
        name: "Platform",
        cloneUrl: "https://github.com/AcmeOrg/Platform.git",
      },
    ]);
    expect(stdout.output()).toContain(
      "Added repository after validation: AcmeOrg/Platform"
    );
  });

  it("removes a validated repository regardless of input casing", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-remove-casing-"));
    const stdout = captureWrites(process.stdout);
    const repoCommand = await loadRepoCommand();

    await seedActiveProject(configDir, [
      {
        owner: "AcmeOrg",
        name: "Platform",
        cloneUrl: "https://github.com/AcmeOrg/Platform.git",
      },
    ]);

    try {
      await repoCommand(["remove", "acmeorg/platform"], baseOptions(configDir));
    } finally {
      stdout.restore();
    }

    const saved = JSON.parse(
      await readFile(projectConfigPath(configDir, "managed-project"), "utf8")
    ) as CliProjectConfig;

    expect(saved.repositories).toEqual([]);
    expect(stdout.output()).toContain("Removed repository: acmeorg/platform");
  });

  it("falls back to unvalidated save when authentication is unavailable", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-add-no-auth-"));
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);
    const repoCommand = await loadRepoCommand();

    await seedActiveProject(configDir, []);
    delete process.env.GITHUB_GRAPHQL_TOKEN;
    ghAuthMock.getGhToken.mockImplementation(() => {
      throw new Error("no auth");
    });

    try {
      await repoCommand(["add", "acme/platform"], baseOptions(configDir));
    } finally {
      stdout.restore();
      stderr.restore();
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
    expect(stderr.output()).toContain(
      "Warning: GitHub authentication is unavailable"
    );
    expect(stdout.output()).toContain(
      "Added repository without validation: acme/platform"
    );
  });

  it("falls back to unvalidated save when the GitHub API is offline", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-add-offline-"));
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);
    const repoCommand = await loadRepoCommand();

    await seedActiveProject(configDir, []);
    process.env.GITHUB_GRAPHQL_TOKEN = "gho_test";
    ghAuthMock.getGhToken.mockReturnValue("gho_test");
    githubClientMock.createClient.mockReturnValue({ token: "gho_test" });
    const { GitHubRepositoryLookupError } = await import("../github/client.js");
    githubClientMock.getRepositoryMetadata.mockRejectedValue(
      new GitHubRepositoryLookupError(
        "offline",
        "GitHub repository validation could not reach the API.",
        "Check your network connection and re-run the command to validate before saving."
      )
    );

    try {
      await repoCommand(["add", "acme/platform"], baseOptions(configDir));
    } finally {
      stdout.restore();
      stderr.restore();
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
    expect(stderr.output()).toContain(
      "Warning: GitHub repository validation could not reach the API. Saved the repository without validation."
    );
    expect(stdout.output()).toContain(
      "Added repository without validation: acme/platform"
    );
  });

  it("reports a missing repository with remediation and does not save it", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-add-not-found-"));
    const stderr = captureWrites(process.stderr);
    const repoCommand = await loadRepoCommand();

    await seedActiveProject(configDir, []);
    process.env.GITHUB_GRAPHQL_TOKEN = "gho_test";
    ghAuthMock.getGhToken.mockReturnValue("gho_test");
    githubClientMock.createClient.mockReturnValue({ token: "gho_test" });
    const { GitHubRepositoryLookupError } = await import("../github/client.js");
    githubClientMock.getRepositoryMetadata.mockRejectedValue(
      new GitHubRepositoryLookupError(
        "not_found",
        "Repository acme/missing was not found.",
        "Check the owner/name spelling. If the repository is private, confirm the current token can access it.",
        404
      )
    );

    try {
      await repoCommand(["add", "acme/missing"], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    const saved = JSON.parse(
      await readFile(projectConfigPath(configDir, "managed-project"), "utf8")
    ) as CliProjectConfig;

    expect(saved.repositories).toEqual([]);
    expect(process.exitCode).toBe(1);
    expect(stderr.output()).toContain("Repository acme/missing was not found.");
    expect(stderr.output()).toContain("Check the owner/name spelling.");
  });

  it("reports rate limits with a distinct remediation message", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "repo-add-rate-limit-"));
    const stderr = captureWrites(process.stderr);
    const repoCommand = await loadRepoCommand();

    await seedActiveProject(configDir, []);
    process.env.GITHUB_GRAPHQL_TOKEN = "gho_test";
    ghAuthMock.getGhToken.mockReturnValue("gho_test");
    githubClientMock.createClient.mockReturnValue({ token: "gho_test" });
    const { GitHubRepositoryLookupError } = await import("../github/client.js");
    githubClientMock.getRepositoryMetadata.mockRejectedValue(
      new GitHubRepositoryLookupError(
        "rate_limited",
        "GitHub API rate limit blocked repository validation.",
        "Wait for the rate limit window to reset, then re-run 'gh-symphony repo add owner/name'.",
        403
      )
    );

    try {
      await repoCommand(["add", "acme/platform"], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(process.exitCode).toBe(1);
    expect(stderr.output()).toContain(
      "GitHub API rate limit blocked repository validation."
    );
    expect(stderr.output()).toContain("Wait for the rate limit window to reset");
  });
});
