import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliProjectConfig } from "../config.js";
import type { GlobalOptions } from "../index.js";
import doctorCommand, {
  runDoctorCommand,
  runDoctorDiagnostics,
} from "./doctor.js";

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

function baseOptions(configDir: string): GlobalOptions {
  return {
    configDir,
    verbose: false,
    json: false,
    noColor: false,
  };
}

function createProjectConfig(
  workspaceDir: string,
  bindingId = "PVT_test"
): CliProjectConfig {
  return {
    projectId: "tenant-a",
    slug: "tenant-a",
    workspaceDir,
    repositories: [],
    tracker: {
      adapter: "github-project",
      bindingId,
    },
  };
}

const originalGraphQlToken = process.env.GITHUB_GRAPHQL_TOKEN;

async function createWorkflowFixture(
  command = "fake-agent",
  options?: { includeGit?: boolean }
): Promise<{
  repoDir: string;
  pathEnv: string;
}> {
  const repoDir = await mkdtemp(join(tmpdir(), "doctor-repo-"));
  const binDir = join(repoDir, "bin");
  await mkdir(binDir, { recursive: true });
  const executable = join(binDir, "fake-agent");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);
  if (options?.includeGit !== false) {
    const gitExecutable = join(binDir, "git");
    await writeFile(
      gitExecutable,
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo 'git version 2.44.0'\n  exit 0\nfi\nexit 1\n",
      "utf8"
    );
    await chmod(gitExecutable, 0o755);
  }
  await writeFile(
    join(repoDir, "WORKFLOW.md"),
    `---\ntracker:\n  kind: github-project\ncodex:\n  command: ${command}\n---\nPrompt body\n`,
    "utf8"
  );
  return { repoDir, pathEnv: binDir };
}

async function createWindowsWorkflowFixture(command = "agent"): Promise<{
  repoDir: string;
  pathEnv: string;
}> {
  const repoDir = await mkdtemp(join(tmpdir(), "doctor-win-repo-"));
  const binDir = join(repoDir, "bin");
  await mkdir(binDir, { recursive: true });
  const executable = join(binDir, "agent.EXE");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(executable, 0o755);
  await writeFile(
    join(repoDir, "WORKFLOW.md"),
    `---\ntracker:\n  kind: github-project\ncodex:\n  command: ${command}\n---\nPrompt body\n`,
    "utf8"
  );
  return { repoDir, pathEnv: binDir };
}

async function withCwd<T>(cwd: string, action: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await action();
  } finally {
    process.chdir(previous);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalGraphQlToken === undefined) {
    delete process.env.GITHUB_GRAPHQL_TOKEN;
  } else {
    process.env.GITHUB_GRAPHQL_TOKEN = originalGraphQlToken;
  }
  process.exitCode = undefined;
});

beforeEach(() => {
  delete process.env.GITHUB_GRAPHQL_TOKEN;
});

describe("runDoctorDiagnostics", () => {
  it("reports success when all required checks pass", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await mkdir(workspaceDir, { recursive: true });
    const { repoDir, pathEnv } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        checkGhInstalled: () => true,
        checkGhAuthenticated: () => ({ authenticated: true, login: "tester" }),
        checkGhScopes: () => ({
          valid: true,
          missing: [],
          scopes: ["repo", "read:org", "project"],
        }),
        getGhToken: () => "ghp_test",
        validateGitHubToken: (async (token: string, source) =>
          ({
            source,
            token,
            login: "tester",
            scopes: ["repo", "read:org", "project"],
          }) as never) as never,
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir),
        }),
        createClient: ((token: string) => ({ token })) as never,
        getProjectDetail: (async () =>
          ({
            id: "PVT_test",
            title: "Acme Platform",
            url: "https://github.com/orgs/acme/projects/1",
            statusFields: [],
            textFields: [],
            linkedRepositories: [],
          }) as never) as never,
        execFileSync: (() => "git version 2.43.0") as never,
        pathEnv,
      })
    );

    expect(report.ok).toBe(true);
    expect(report.projectId).toBe("tenant-a");
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(report.checks.find((check) => check.id === "node_runtime")).toMatchObject({
      status: "pass",
      details: {
        currentVersion: process.version,
        minimumVersion: "v24.0.0",
      },
    });
    expect(
      report.checks.find((check) => check.id === "git_installation")
    ).toMatchObject({
      status: "pass",
      details: expect.objectContaining({
        version: expect.stringContaining("git version"),
      }),
    });
  });

  it("reports an actionable failure for unsupported Node.js versions", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await mkdir(workspaceDir, { recursive: true });
    const { repoDir, pathEnv } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        checkGhInstalled: () => true,
        checkGhAuthenticated: () => ({ authenticated: true, login: "tester" }),
        checkGhScopes: () => ({
          valid: true,
          missing: [],
          scopes: ["repo", "read:org", "project"],
        }),
        getGhToken: () => "ghp_test",
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir),
        }),
        createClient: ((token: string) => ({ token })) as never,
        getProjectDetail: (async () =>
          ({
            id: "PVT_test",
            title: "Acme Platform",
            url: "https://github.com/orgs/acme/projects/1",
            statusFields: [],
            textFields: [],
            linkedRepositories: [],
          }) as never) as never,
        pathEnv,
        processVersion: "v22.11.0",
      })
    );

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "node_runtime")).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("v22.11.0"),
      remediation: expect.stringContaining("v24.0.0"),
      details: {
        currentVersion: "v22.11.0",
        minimumVersion: "v24.0.0",
      },
    });
  });

  it("reports an actionable failure when Git is missing from PATH", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await mkdir(workspaceDir, { recursive: true });
    const { repoDir, pathEnv } = await createWorkflowFixture("fake-agent", {
      includeGit: false,
    });

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        checkGhInstalled: () => true,
        checkGhAuthenticated: () => ({ authenticated: true, login: "tester" }),
        checkGhScopes: () => ({
          valid: true,
          missing: [],
          scopes: ["repo", "read:org", "project"],
        }),
        getGhToken: () => "ghp_test",
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir),
        }),
        createClient: ((token: string) => ({ token })) as never,
        getProjectDetail: (async () =>
          ({
            id: "PVT_test",
            title: "Acme Platform",
            url: "https://github.com/orgs/acme/projects/1",
            statusFields: [],
            textFields: [],
            linkedRepositories: [],
          }) as never) as never,
        pathEnv,
        execFileSync: (() => {
          const error = new Error("git: command not found") as Error & {
            code?: string;
          };
          error.code = "ENOENT";
          throw error;
        }) as never,
      })
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((check) => check.id === "git_installation")
    ).toMatchObject({
      status: "fail",
      summary: "Git could not be found on PATH.",
      remediation: expect.stringContaining("git --version"),
    });
  });

  it("fails the Git prerequisite when git --version cannot execute", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await mkdir(workspaceDir, { recursive: true });
    const { repoDir, pathEnv } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        checkGhInstalled: () => true,
        checkGhAuthenticated: () => ({ authenticated: true, login: "tester" }),
        checkGhScopes: () => ({
          valid: true,
          missing: [],
          scopes: ["repo", "read:org", "project"],
        }),
        getGhToken: () => "ghp_test",
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir),
        }),
        createClient: ((token: string) => ({ token })) as never,
        getProjectDetail: (async () =>
          ({
            id: "PVT_test",
            title: "Acme Platform",
            url: "https://github.com/orgs/acme/projects/1",
            statusFields: [],
            textFields: [],
            linkedRepositories: [],
          }) as never) as never,
        pathEnv,
        execFileSync: (() => {
          throw new Error("permission denied");
        }) as never,
      })
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((check) => check.id === "git_installation")
    ).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("permission denied"),
      remediation: expect.stringContaining("git --version"),
      details: expect.objectContaining({ error: "permission denied" }),
    });
  });

  it("reports actionable failures for missing authentication and managed project config", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const { repoDir } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        checkGhInstalled: () => true,
        checkGhAuthenticated: () => ({ authenticated: false }),
        inspectManagedProjectSelection: async () => ({
          kind: "no_projects",
          message:
            "No managed projects are configured. Run 'gh-symphony project add' first.",
        }),
        pathEnv: "",
      })
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((check) => check.id === "gh_authentication")
    ).toMatchObject({
      status: "fail",
      remediation: expect.stringContaining("gh auth login"),
    });
    expect(
      report.checks.find((check) => check.id === "managed_project")
    ).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("project add"),
    });
  });

  it("accepts env-token auth when gh CLI is unavailable", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await mkdir(workspaceDir, { recursive: true });
    const { repoDir, pathEnv } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        checkGhInstalled: () => false,
        getEnvGitHubToken: () => "env-token",
        validateGitHubToken: (async () =>
          ({
            source: "env",
            token: "env-token",
            login: "env-user",
            scopes: ["repo", "read:org", "project"],
          }) as never) as never,
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir),
        }),
        createClient: ((token: string) => ({ token })) as never,
        getProjectDetail: (async () =>
          ({
            id: "PVT_test",
            title: "Acme Platform",
            url: "https://github.com/orgs/acme/projects/1",
            statusFields: [],
            textFields: [],
            linkedRepositories: [],
          }) as never) as never,
        pathEnv,
      })
    );

    expect(report.ok).toBe(true);
    expect(
      report.checks.find((check) => check.id === "gh_installation")
    ).toMatchObject({
      status: "pass",
      summary: expect.stringContaining("gh is optional"),
    });
    expect(
      report.checks.find((check) => check.id === "gh_authentication")
    ).toMatchObject({
      status: "pass",
      summary: "Using GITHUB_GRAPHQL_TOKEN as env-user.",
    });
  });

  it("falls back to gh auth without reusing an invalid env token", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await mkdir(workspaceDir, { recursive: true });
    const { repoDir, pathEnv } = await createWorkflowFixture();
    const getGhToken = vi.fn(() => "gh-token");
    const validateGitHubToken = vi
      .fn()
      .mockRejectedValueOnce(new Error("GITHUB_GRAPHQL_TOKEN is invalid or expired."))
      .mockResolvedValueOnce({
        source: "gh",
        token: "gh-token",
        login: "gh-user",
        scopes: ["repo", "read:org", "project"],
      });

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        checkGhInstalled: () => true,
        checkGhAuthenticated: () => ({ authenticated: true, login: "gh-user" }),
        checkGhScopes: () => ({
          valid: true,
          missing: [],
          scopes: ["repo", "read:org", "project"],
        }),
        getEnvGitHubToken: () => "bad-env-token",
        getGhToken: getGhToken as never,
        validateGitHubToken: validateGitHubToken as never,
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir),
        }),
        createClient: ((token: string) => ({ token })) as never,
        getProjectDetail: (async () =>
          ({
            id: "PVT_test",
            title: "Acme Platform",
            url: "https://github.com/orgs/acme/projects/1",
            statusFields: [],
            textFields: [],
            linkedRepositories: [],
          }) as never) as never,
        pathEnv,
      })
    );

    expect(report.ok).toBe(true);
    expect(getGhToken).toHaveBeenCalledWith({ allowEnv: false });
    expect(validateGitHubToken).toHaveBeenNthCalledWith(1, "bad-env-token", "env");
    expect(validateGitHubToken).toHaveBeenNthCalledWith(2, "gh-token", "gh");
    expect(
      report.checks.find((check) => check.id === "gh_authentication")
    ).toMatchObject({
      status: "pass",
      summary: "Using gh CLI as gh-user.",
    });
  });

  it("reports missing scopes with a refresh command", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    const { repoDir } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        checkGhInstalled: () => true,
        checkGhAuthenticated: () => ({ authenticated: true, login: "tester" }),
        checkGhScopes: () => ({
          valid: false,
          missing: ["project"],
          scopes: ["repo", "read:org"],
        }),
        getGhToken: () => "ghp_test",
        validateGitHubToken: (async (token: string, source) =>
          ({
            source,
            token,
            login: "tester",
            scopes: ["repo", "read:org"],
          }) as never) as never,
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir),
        }),
        pathEnv: "",
      })
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((check) => check.id === "gh_scopes")
    ).toMatchObject({
      status: "fail",
      remediation: expect.stringContaining("gh auth refresh --scopes"),
      details: expect.objectContaining({ missing: ["project"] }),
    });
  });

  it("reports invalid workflow files and blocks runtime command validation", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const repoDir = await mkdtemp(join(tmpdir(), "doctor-repo-"));
    await writeFile(join(repoDir, "WORKFLOW.md"), "invalid workflow", "utf8");

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        checkGhInstalled: () => false,
        inspectManagedProjectSelection: async () => ({
          kind: "no_projects",
          message:
            "No managed projects are configured. Run 'gh-symphony project add' first.",
        }),
      })
    );

    expect(
      report.checks.find((check) => check.id === "workflow_file")
    ).toMatchObject({
      status: "fail",
      summary: "WORKFLOW.md could not be parsed.",
    });
    expect(
      report.checks.find((check) => check.id === "runtime_command")
    ).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("WORKFLOW.md is missing or invalid"),
    });
  });

  it("fails writable-path checks when a configured path points to a file", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "doctor-path-file-"));
    const configPath = join(rootDir, "config-file");
    const workspacePath = join(rootDir, "workspace-file");
    await writeFile(configPath, "not a directory", "utf8");
    await writeFile(workspacePath, "not a directory", "utf8");
    const { repoDir } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configPath), [], {
        checkGhInstalled: () => true,
        checkGhAuthenticated: () => ({ authenticated: true, login: "tester" }),
        checkGhScopes: () => ({
          valid: true,
          missing: [],
          scopes: ["repo", "read:org", "project"],
        }),
        getGhToken: () => "ghp_test",
        validateGitHubToken: (async (token: string, source) =>
          ({
            source,
            token,
            login: "tester",
            scopes: ["repo", "read:org", "project"],
          }) as never) as never,
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspacePath),
        }),
        createClient: ((token: string) => ({ token })) as never,
        getProjectDetail: (async () =>
          ({
            id: "PVT_test",
            title: "Acme Platform",
            url: "https://github.com/orgs/acme/projects/1",
            statusFields: [],
            textFields: [],
            linkedRepositories: [],
          }) as never) as never,
        pathEnv: "",
      })
    );

    expect(
      report.checks.find((check) => check.id === "config_directory")
    ).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("not writable"),
    });
    expect(
      report.checks.find((check) => check.id === "workspace_root")
    ).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("not writable"),
    });
  });

  it("reports token retrieval errors distinctly from auth failures", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await mkdir(workspaceDir, { recursive: true });
    const { repoDir } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        checkGhInstalled: () => true,
        checkGhAuthenticated: () => ({ authenticated: true, login: "tester" }),
        checkGhScopes: () => ({
          valid: true,
          missing: [],
          scopes: ["repo", "read:org", "project"],
        }),
        getGhToken: () => {
          throw new Error("keychain locked");
        },
        validateGitHubToken: (async (token: string, source) =>
          ({
            source,
            token,
            login: "tester",
            scopes: ["repo", "read:org", "project"],
          }) as never) as never,
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir),
        }),
        pathEnv: "",
      })
    );

    expect(
      report.checks.find((check) => check.id === "github_project_resolution")
    ).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("token could not be retrieved"),
      remediation: expect.stringContaining("gh auth token"),
      details: expect.objectContaining({ error: "keychain locked" }),
    });
  });

  it("reports a missing GitHub project binding with targeted remediation", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await mkdir(workspaceDir, { recursive: true });
    const { repoDir } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        checkGhInstalled: () => true,
        checkGhAuthenticated: () => ({ authenticated: true, login: "tester" }),
        checkGhScopes: () => ({
          valid: true,
          missing: [],
          scopes: ["repo", "read:org", "project"],
        }),
        getGhToken: () => "ghp_test",
        validateGitHubToken: (async (token: string, source) =>
          ({
            source,
            token,
            login: "tester",
            scopes: ["repo", "read:org", "project"],
          }) as never) as never,
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir, ""),
        }),
        pathEnv: "",
      })
    );

    expect(
      report.checks.find((check) => check.id === "github_project_resolution")
    ).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("is not bound to a GitHub Project"),
      remediation: expect.stringContaining("project add"),
    });
  });

  it("detects Windows runtime commands via PATHEXT", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await mkdir(workspaceDir, { recursive: true });
    const { repoDir, pathEnv } = await createWindowsWorkflowFixture("agent");

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        checkGhInstalled: () => true,
        checkGhAuthenticated: () => ({ authenticated: true, login: "tester" }),
        checkGhScopes: () => ({
          valid: true,
          missing: [],
          scopes: ["repo", "read:org", "project"],
        }),
        getGhToken: () => "ghp_test",
        validateGitHubToken: (async (token: string, source) =>
          ({
            source,
            token,
            login: "tester",
            scopes: ["repo", "read:org", "project"],
          }) as never) as never,
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir),
        }),
        createClient: ((token: string) => ({ token })) as never,
        getProjectDetail: (async () =>
          ({
            id: "PVT_test",
            title: "Acme Platform",
            url: "https://github.com/orgs/acme/projects/1",
            statusFields: [],
            textFields: [],
            linkedRepositories: [],
          }) as never) as never,
        pathEnv,
        pathExtEnv: ".EXE;.CMD",
        platform: "win32",
      })
    );

    expect(
      report.checks.find((check) => check.id === "runtime_command")
    ).toMatchObject({
      status: "pass",
      details: expect.objectContaining({ binary: "agent" }),
    });
  });
});

describe("doctor command handler", () => {
  it("prints JSON output and exits 0 on success", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await mkdir(workspaceDir, { recursive: true });
    const { repoDir, pathEnv } = await createWorkflowFixture();
    const stdout = captureWrites(process.stdout);

    try {
      await withCwd(repoDir, () =>
        runDoctorCommand([], { ...baseOptions(configDir), json: true }, {
          checkGhInstalled: () => true,
          checkGhAuthenticated: () => ({ authenticated: true, login: "tester" }),
          checkGhScopes: () => ({
            valid: true,
            missing: [],
            scopes: ["repo", "read:org", "project"],
          }),
          getGhToken: () => "ghp_test",
          validateGitHubToken: (async (token: string, source) =>
            ({
              source,
              token,
              login: "tester",
              scopes: ["repo", "read:org", "project"],
            }) as never) as never,
          inspectManagedProjectSelection: async () => ({
            kind: "resolved",
            projectId: "tenant-a",
            projectConfig: createProjectConfig(workspaceDir),
          }),
          createClient: ((token: string) => ({ token })) as never,
          getProjectDetail: (async () =>
            ({
              id: "PVT_test",
              title: "Acme Platform",
              url: "https://github.com/orgs/acme/projects/1",
              statusFields: [],
              textFields: [],
              linkedRepositories: [],
            }) as never) as never,
          execFileSync: (() => "git version 2.43.0") as never,
          pathEnv,
        })
      );
    } finally {
      stdout.restore();
    }

    const report = JSON.parse(stdout.output()) as {
      ok: boolean;
      checks: Array<{
        id: string;
        details?: Record<string, unknown>;
      }>;
    };
    expect(report.ok).toBe(true);
    expect(process.exitCode).toBe(0);
    expect(report.checks.some((check) => check.id === "runtime_command")).toBe(
      true
    );
    expect(report.checks.find((check) => check.id === "node_runtime")?.details)
      .toMatchObject({
        currentVersion: process.version,
        minimumVersion: "v24.0.0",
      });
  });

  it("sets exit code 2 for invalid args", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const stderr = captureWrites(process.stderr);

    try {
      await doctorCommand(["--project-id"], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(process.exitCode).toBe(2);
    expect(stderr.output()).toContain("Usage: gh-symphony doctor");
  });
});
