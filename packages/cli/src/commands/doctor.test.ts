import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProjectConfig } from "../config.js";
import type { GlobalOptions } from "../index.js";
import doctorCommand, {
  type DoctorDependencies,
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

function authDependencies(
  overrides: Partial<DoctorDependencies> = {}
): Partial<DoctorDependencies> {
  return {
    detectGitHubAuthSource: () => "gh",
    checkGhInstalled: () => true,
    checkGhAuthenticated: () => ({ authenticated: true, login: "tester" }),
    getGhTokenWithSource: () => ({ token: "ghp_test", source: "gh" }),
    createClient: ((token: string) => ({ token })) as never,
    validateToken: (async () =>
      ({
        login: "tester",
        name: "Test User",
        scopes: ["repo", "read:org", "project"],
      }) as never) as never,
    checkRequiredScopes: () => ({ valid: true, missing: [] }),
    ...overrides,
  };
}

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
  process.exitCode = undefined;
});

describe("runDoctorDiagnostics", () => {
  it("reports success when all required checks pass", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await mkdir(workspaceDir, { recursive: true });
    const { repoDir, pathEnv } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        ...authDependencies(),
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir),
        }),
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
    expect(report.authSource).toBe("gh");
    expect(report.authLogin).toBe("tester");
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
        ...authDependencies(),
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir),
        }),
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
        ...authDependencies(),
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir),
        }),
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
        ...authDependencies(),
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir),
        }),
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
        ...authDependencies({
          checkGhAuthenticated: () => ({ authenticated: false }),
        }),
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

  it("reports missing scopes with a refresh command", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    const { repoDir } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        ...authDependencies({
          validateToken: (async () =>
            ({
              login: "tester",
              name: "Test User",
              scopes: ["repo", "read:org"],
            }) as never) as never,
          checkRequiredScopes: () => ({
            valid: false,
            missing: ["project"],
          }),
        }),
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

  it("uses env auth when GITHUB_GRAPHQL_TOKEN is present and gh is unavailable", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await mkdir(workspaceDir, { recursive: true });
    const { repoDir, pathEnv } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        ...authDependencies({
          detectGitHubAuthSource: () => "env",
          checkGhInstalled: () => false,
          getGhTokenWithSource: () => ({ token: "env-token", source: "env" }),
          validateToken: (async () =>
            ({
              login: "env-user",
              name: "Env User",
              scopes: ["repo", "read:org", "project"],
            }) as never) as never,
        }),
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir),
        }),
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
    expect(report.authSource).toBe("env");
    expect(report.authLogin).toBe("env-user");
    expect(
      report.checks.find((check) => check.id === "gh_installation")
    ).toMatchObject({
      status: "pass",
      details: expect.objectContaining({ authSource: "env" }),
    });
    expect(
      report.checks.find((check) => check.id === "gh_authentication")
    ).toMatchObject({
      status: "pass",
      details: expect.objectContaining({ authSource: "env", login: "env-user" }),
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
        ...authDependencies(),
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspacePath),
        }),
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
        ...authDependencies({
          getGhTokenWithSource: () => {
            throw new Error("keychain locked");
          },
        }),
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
        ...authDependencies(),
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
        ...authDependencies(),
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir),
        }),
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
          ...authDependencies(),
          inspectManagedProjectSelection: async () => ({
            kind: "resolved",
            projectId: "tenant-a",
            projectConfig: createProjectConfig(workspaceDir),
          }),
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
      authSource: string | null;
      checks: Array<{ id: string }>;
    };
    expect(report.ok).toBe(true);
    expect(report.authSource).toBe("gh");
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
