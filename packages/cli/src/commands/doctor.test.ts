import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackedIssue } from "@gh-symphony/core";
import type { CliProjectConfig } from "../config.js";
import type { GlobalOptions } from "../index.js";
import { resolveRuntimeRoot } from "../orchestrator-runtime.js";
import { orchestratorLogPath } from "../config.js";
import doctorCommand, {
  type DoctorDependencies,
  runDoctorCommand,
  runDoctorDiagnostics,
} from "./doctor.js";

const DOCTOR_TEST_NODE_VERSION = "v24.0.0";

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
  bindingId = "PVT_test",
  repositoryInput:
    | CliProjectConfig["repository"]
    | CliProjectConfig["repository"][] = undefined
): CliProjectConfig {
  const repository = Array.isArray(repositoryInput)
    ? repositoryInput[0]
    : repositoryInput;
  return {
    projectId: "tenant-a",
    slug: "tenant-a",
    workspaceDir,
    ...(repository ? { repository } : {}),
    tracker: {
      adapter: "github-project",
      bindingId,
    },
  };
}

function createTrackedIssue(
  overrides: Partial<TrackedIssue> = {}
): TrackedIssue {
  return {
    id: "issue-1",
    identifier: "acme/widgets#1",
    number: 1,
    title: "Smoke target",
    description: "Validate the first-run smoke path.",
    priority: 1,
    state: "Ready",
    branchName: null,
    url: "https://github.com/acme/widgets/issues/1",
    labels: [],
    blockedBy: [],
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-02T00:00:00Z",
    repository: {
      owner: "acme",
      name: "widgets",
      url: "https://github.com/acme/widgets",
      cloneUrl: "https://github.com/acme/widgets.git",
    },
    tracker: {
      adapter: "github-project",
      bindingId: "PVT_test",
      itemId: "item-1",
    },
    metadata: {},
    ...overrides,
  };
}

function createProjectDetail() {
  return {
    id: "PVT_test",
    title: "Acme Platform",
    url: "https://github.com/orgs/acme/projects/1",
    statusFields: [],
    textFields: [],
    linkedRepositories: [
      {
        owner: "acme",
        name: "widgets",
        url: "https://github.com/acme/widgets",
        cloneUrl: "https://github.com/acme/widgets.git",
      },
    ],
  };
}

function authDependencies(
  overrides: Partial<DoctorDependencies> = {}
): Partial<DoctorDependencies> {
  return {
    checkGhInstalled: () => true,
    checkGhAuthenticated: () => ({ authenticated: true, login: "tester" }),
    checkGhScopes: () => ({
      valid: true,
      missing: [],
      scopes: ["repo", "read:org", "project"],
    }),
    getEnvGitHubToken: () => null,
    getGhToken: () => "ghp_test",
    processVersion: DOCTOR_TEST_NODE_VERSION,
    validateGitHubToken: (async (token: string, source) =>
      ({
        source,
        token,
        login: "tester",
        scopes: ["repo", "read:org", "project"],
      }) as never) as never,
    createClient: ((token: string) => ({ token })) as never,
    ...overrides,
  };
}

const originalGraphQlToken = process.env.GITHUB_GRAPHQL_TOKEN;
const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
const originalCredentialBrokerUrl = process.env.AGENT_CREDENTIAL_BROKER_URL;
const originalCredentialBrokerSecret =
  process.env.AGENT_CREDENTIAL_BROKER_SECRET;

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
      '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo \'git version 2.44.0\'\n  exit 0\nfi\nexit 1\n',
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

async function prepareDoctorPaths(
  configDir: string,
  workspaceDir?: string
): Promise<void> {
  await mkdir(resolveRuntimeRoot(configDir), { recursive: true });
  if (workspaceDir) {
    await mkdir(workspaceDir, { recursive: true });
  }
}

async function prepareBundleRuntimeFixture(input: {
  configDir: string;
  workspaceDir: string;
  projectId?: string;
}): Promise<void> {
  const projectId = input.projectId ?? "tenant-a";
  await mkdir(join(input.configDir, "projects", projectId), {
    recursive: true,
  });
  await writeFile(
    join(input.configDir, "config.json"),
    JSON.stringify(
      {
        activeProject: projectId,
        projects: [projectId],
        GITHUB_TOKEN: "ghp_xxx",
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    join(input.configDir, "projects", projectId, "project.json"),
    JSON.stringify(
      {
        ...createProjectConfig(input.workspaceDir),
        projectId,
        tracker: {
          adapter: "github-project",
          bindingId: "PVT_test",
          settings: {
            GITHUB_GRAPHQL_TOKEN: "ghp_xxx",
            LINEAR_API_KEY: "lin_xxx",
          },
        },
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    join(input.configDir, "status.json"),
    JSON.stringify(
      {
        health: "running",
        token: "xxx",
        repository: { owner: "acme", name: "widgets" },
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    join(input.configDir, "issues.json"),
    JSON.stringify([{ id: "issue-1", secret: "xxx" }], null, 2),
    "utf8"
  );
  await mkdir(join(input.configDir, "runs", "run-1"), { recursive: true });
  await writeFile(
    join(input.configDir, "runs", "run-1", "run.json"),
    JSON.stringify(
      {
        runId: "run-1",
        status: "running",
        startedAt: "2026-05-18T00:00:00.000Z",
        updatedAt: "2026-05-18T00:01:00.000Z",
        apiKey: "xxx",
      },
      null,
      2
    ),
    "utf8"
  );
  await writeFile(
    join(input.configDir, "runs", "run-1", "events.ndjson"),
    [
      JSON.stringify({
        at: "2026-05-18T00:00:00.000Z",
        event: "worker",
        message: "Authorization: Bearer abc123",
      }),
      "OPENAI_API_KEY=sk-xxx",
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    join(input.configDir, "runs", "run-1", "worker.log"),
    Array.from({ length: 650 }, (_, index) =>
      index === 649 ? "X-API-Key: xxx" : `worker line ${index}`
    ).join("\n"),
    "utf8"
  );
  await mkdir(join(input.configDir, "projects", projectId), {
    recursive: true,
  });
  await writeFile(
    orchestratorLogPath(input.configDir, projectId),
    "GITHUB_TOKEN=ghp_xxx\norchestrator ready\n",
    "utf8"
  );
}

async function readBundleFiles(root: string): Promise<string> {
  const chunks: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else {
        chunks.push(await readFile(path, "utf8"));
      }
    }
  }
  await visit(root);
  return chunks.join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalGraphQlToken === undefined) {
    delete process.env.GITHUB_GRAPHQL_TOKEN;
  } else {
    process.env.GITHUB_GRAPHQL_TOKEN = originalGraphQlToken;
  }
  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
  }
  if (originalCredentialBrokerUrl === undefined) {
    delete process.env.AGENT_CREDENTIAL_BROKER_URL;
  } else {
    process.env.AGENT_CREDENTIAL_BROKER_URL = originalCredentialBrokerUrl;
  }
  if (originalCredentialBrokerSecret === undefined) {
    delete process.env.AGENT_CREDENTIAL_BROKER_SECRET;
  } else {
    process.env.AGENT_CREDENTIAL_BROKER_SECRET = originalCredentialBrokerSecret;
  }
  process.exitCode = undefined;
});

beforeEach(() => {
  delete process.env.GITHUB_GRAPHQL_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("runDoctorDiagnostics", () => {
  it("reports success when all required checks pass", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await prepareDoctorPaths(configDir, workspaceDir);
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
    expect(
      report.checks.find((check) => check.id === "node_runtime")
    ).toMatchObject({
      status: "pass",
      details: {
        currentVersion: DOCTOR_TEST_NODE_VERSION,
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

  it("adds Claude readiness checks for Claude runtime commands", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await prepareDoctorPaths(configDir, workspaceDir);
    const { repoDir, pathEnv } = await createWorkflowFixture("claude");
    const claudeExecutable = join(pathEnv, "claude");
    await writeFile(claudeExecutable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(claudeExecutable, 0o755);
    await writeFile(join(repoDir, ".mcp.json"), '{"mcpServers":{}}\n', "utf8");
    process.env.ANTHROPIC_API_KEY = "sk-test";

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
        execFileSync: ((command: string, args: readonly string[] = []) => {
          if (command === "git") {
            return "git version 2.43.0";
          }
          if (command === "which") {
            return join(pathEnv, String(args[0]));
          }
          if (command === "claude" && args[0] === "--version") {
            return "claude 1.2.3";
          }
          return "";
        }) as never,
        pathEnv,
      })
    );

    expect(report.ok).toBe(true);
    expect(
      report.checks.find((check) => check.id === "claude_binary")
    ).toMatchObject({
      status: "pass",
      summary: expect.stringContaining("1.2.3"),
    });
    expect(
      report.checks.find((check) => check.id === "anthropic_api_key")
    ).toMatchObject({ status: "pass" });
    expect(
      report.checks.find((check) => check.id === "claude_mcp_config")
    ).toMatchObject({ status: "pass" });
  });

  it("reports Claude missing API key with a concrete fix", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await prepareDoctorPaths(configDir, workspaceDir);
    const { repoDir, pathEnv } = await createWorkflowFixture("claude");
    const claudeExecutable = join(pathEnv, "claude");
    await writeFile(claudeExecutable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(claudeExecutable, 0o755);

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
        execFileSync: ((command: string, args: readonly string[] = []) => {
          if (command === "git") {
            return "git version 2.43.0";
          }
          if (command === "which") {
            return join(pathEnv, String(args[0]));
          }
          if (command === "claude" && args[0] === "--version") {
            return "claude 1.2.3";
          }
          return "";
        }) as never,
        pathEnv,
      })
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((check) => check.id === "anthropic_api_key")
    ).toMatchObject({
      status: "fail",
      remediation: expect.stringContaining("Set ANTHROPIC_API_KEY"),
    });
    expect(
      report.checks.find((check) => check.id === "claude_mcp_config")
    ).toMatchObject({ status: "warn" });
  });

  it("uses injected fetch when checking brokered Claude credentials", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await prepareDoctorPaths(configDir, workspaceDir);
    const { repoDir, pathEnv } = await createWorkflowFixture("claude");
    const claudeExecutable = join(pathEnv, "claude");
    await writeFile(claudeExecutable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(claudeExecutable, 0o755);
    process.env.AGENT_CREDENTIAL_BROKER_URL = "https://broker.test/agent";
    process.env.AGENT_CREDENTIAL_BROKER_SECRET = "secret";
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ env: { ANTHROPIC_API_KEY: "sk-brokered" } }),
    }));

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
        execFileSync: ((command: string, args: readonly string[] = []) => {
          if (command === "git") {
            return "git version 2.43.0";
          }
          if (command === "which") {
            return join(pathEnv, String(args[0]));
          }
          if (command === "claude" && args[0] === "--version") {
            return "claude 1.2.3";
          }
          return "";
        }) as never,
        fetchImpl: fetchImpl as never,
        pathEnv,
      })
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://broker.test/agent",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(
      report.checks.find((check) => check.id === "anthropic_api_key")
    ).toMatchObject({
      status: "pass",
      details: expect.objectContaining({ source: "broker" }),
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
    expect(
      report.checks.find((check) => check.id === "node_runtime")
    ).toMatchObject({
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
            "No repository runtime config is configured. Run 'gh-symphony repo init' first.",
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
      summary: expect.stringContaining("repo init"),
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
      .mockRejectedValueOnce(
        new Error("GITHUB_GRAPHQL_TOKEN is invalid or expired.")
      )
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
    expect(validateGitHubToken).toHaveBeenNthCalledWith(
      1,
      "bad-env-token",
      "env"
    );
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
    await prepareDoctorPaths(configDir, workspaceDir);
    const { repoDir } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        ...authDependencies({
          checkGhScopes: () => ({
            valid: false,
            missing: ["project"],
            scopes: ["repo", "read:org"],
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
            "No repository runtime config is configured. Run 'gh-symphony repo init' first.",
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
          checkGhInstalled: () => false,
          getEnvGitHubToken: () => "env-token",
          validateGitHubToken: (async () =>
            ({
              source: "env",
              token: "env-token",
              login: "env-user",
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
      details: expect.objectContaining({
        authSource: "env",
        login: "env-user",
      }),
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
      summary: expect.stringContaining("not a directory"),
    });
    expect(
      report.checks.find((check) => check.id === "workspace_root")
    ).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("not a directory"),
    });
  });

  it("does not create missing directories during diagnostics", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "doctor-missing-paths-"));
    const configDir = join(rootDir, "config");
    const workspaceDir = join(rootDir, "workspace");
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
      })
    );

    expect(report.ok).toBe(false);
    await expect(access(configDir, constants.F_OK)).rejects.toBeDefined();
    await expect(access(workspaceDir, constants.F_OK)).rejects.toBeDefined();
    expect(
      report.checks.find((check) => check.id === "config_directory")
    ).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("does not exist"),
      remediation: expect.stringContaining("mkdir -p"),
    });
  });

  it("reports token retrieval errors distinctly from auth failures", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await prepareDoctorPaths(configDir, workspaceDir);
    const { repoDir } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), [], {
        ...authDependencies({
          getGhToken: () => {
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
    await prepareDoctorPaths(configDir, workspaceDir);
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
      remediation: expect.stringContaining("workflow init"),
    });
  });

  it("detects Windows runtime commands via PATHEXT", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await prepareDoctorPaths(configDir, workspaceDir);
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
    await prepareDoctorPaths(configDir, workspaceDir);
    const { repoDir, pathEnv } = await createWorkflowFixture();
    const stdout = captureWrites(process.stdout);

    try {
      await withCwd(repoDir, () =>
        runDoctorCommand(
          [],
          { ...baseOptions(configDir), json: true },
          {
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
          }
        )
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
    expect(
      report.checks.find((check) => check.id === "node_runtime")?.details
    ).toMatchObject({
      currentVersion: DOCTOR_TEST_NODE_VERSION,
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

  it("applies missing directory fixes and reports structured JSON remediation steps", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "doctor-fix-paths-"));
    const configDir = join(rootDir, "config");
    const workspaceDir = join(rootDir, "workspace");
    const { repoDir, pathEnv } = await createWorkflowFixture();
    const stdout = captureWrites(process.stdout);

    try {
      await withCwd(repoDir, () =>
        runDoctorCommand(
          ["--fix"],
          { ...baseOptions(configDir), json: true },
          {
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
          }
        )
      );
    } finally {
      stdout.restore();
    }

    const report = JSON.parse(stdout.output()) as {
      ok: boolean;
      remediation?: {
        attempted: boolean;
        steps: Array<{ checkId: string; status: string }>;
      };
      checks: Array<{ id: string; status: string }>;
    };
    expect(report.ok).toBe(true);
    expect(report.remediation).toMatchObject({
      attempted: true,
    });
    expect(report.remediation?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "config_directory",
          status: "applied",
        }),
        expect.objectContaining({
          checkId: "runtime_root",
          status: "applied",
        }),
        expect.objectContaining({
          checkId: "workspace_root",
          status: "applied",
        }),
      ])
    );
    expect(
      report.checks.find((check) => check.id === "config_directory")
    ).toMatchObject({ status: "pass" });
  });

  it("reports manual remediation commands in non-interactive fix mode", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const { repoDir } = await createWorkflowFixture();
    const stdout = captureWrites(process.stdout);

    try {
      await withCwd(repoDir, () =>
        runDoctorCommand(
          ["--fix"],
          { ...baseOptions(configDir), json: true },
          {
            checkGhInstalled: () => true,
            checkGhAuthenticated: () => ({ authenticated: false }),
            inspectManagedProjectSelection: async () => ({
              kind: "no_projects",
              message:
                "No repository runtime config is configured. Run 'gh-symphony repo init' first.",
            }),
            stdinIsTTY: false,
            stdoutIsTTY: false,
          }
        )
      );
    } finally {
      stdout.restore();
    }

    const report = JSON.parse(stdout.output()) as {
      ok: boolean;
      remediation?: {
        steps: Array<{ checkId: string; status: string; command?: string }>;
      };
    };
    expect(report.ok).toBe(false);
    expect(report.remediation?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "gh_authentication",
          status: "manual",
          command: "gh auth login --scopes repo,read:org,project",
        }),
        expect.objectContaining({
          checkId: "managed_project",
          status: "manual",
          command: `gh-symphony --config ${configDir} repo init`,
        }),
      ])
    );
  });

  it("reports workflow init for missing workflow file remediation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "doctor-missing-workflow-"));
    const configDir = join(rootDir, "config");
    const workspaceDir = join(rootDir, "workspace");
    const repoDir = join(rootDir, "repo");
    const binDir = join(rootDir, "bin");
    await mkdir(repoDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await prepareDoctorPaths(configDir, workspaceDir);

    const gitExecutable = join(binDir, "git");
    await writeFile(
      gitExecutable,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo \'git version 2.44.0\'\n  exit 0\nfi\nexit 1\n',
      "utf8"
    );
    await chmod(gitExecutable, 0o755);

    const stdout = captureWrites(process.stdout);

    try {
      await withCwd(repoDir, () =>
        runDoctorCommand(
          ["--fix"],
          { ...baseOptions(configDir), json: true },
          {
            ...authDependencies(),
            inspectManagedProjectSelection: async () => ({
              kind: "resolved",
              projectId: "tenant-a",
              projectConfig: createProjectConfig(workspaceDir),
            }),
            getProjectDetail: (async () =>
              createProjectDetail() as never) as never,
            pathEnv: binDir,
          }
        )
      );
    } finally {
      stdout.restore();
    }

    const report = JSON.parse(stdout.output()) as {
      remediation?: {
        steps: Array<{ checkId: string; status: string; command?: string }>;
      };
    };
    expect(report.remediation?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "workflow_file",
          status: "manual",
          command: `gh-symphony --config ${configDir} workflow init`,
        }),
      ])
    );
  });

  it("does not launch remediation subprocesses while preserving JSON-only stdout", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-json-fix-"));
    const { repoDir } = await createWorkflowFixture();
    const stdout = captureWrites(process.stdout);
    const spawnSync = vi.fn(() => ({
      status: 0,
      pid: 1,
      signal: null,
      stdout: "",
      stderr: "",
      output: [null, "", ""],
    })) as never;

    try {
      await withCwd(repoDir, () =>
        runDoctorCommand(
          ["--fix"],
          { ...baseOptions(configDir), json: true },
          {
            checkGhInstalled: () => true,
            checkGhAuthenticated: () => ({ authenticated: false }),
            inspectManagedProjectSelection: async () => ({
              kind: "no_projects",
              message:
                "No repository runtime config is configured. Run 'gh-symphony repo init' first.",
            }),
            stdinIsTTY: true,
            stdoutIsTTY: true,
            spawnSync,
          }
        )
      );
    } finally {
      stdout.restore();
    }

    expect(spawnSync).not.toHaveBeenCalled();
    const report = JSON.parse(stdout.output()) as {
      remediation?: { steps: Array<{ checkId: string; status: string }> };
    };
    expect(report.remediation?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "gh_authentication",
          status: "manual",
        }),
        expect.objectContaining({
          checkId: "managed_project",
          status: "manual",
        }),
      ])
    );
  });

  it("forwards config context to interactive remediation subprocesses", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-fix-config-"));
    const { repoDir } = await createWorkflowFixture();
    const stdout = captureWrites(process.stdout);
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        pid: 1,
        signal: null,
        stdout: "",
        stderr: "",
        output: [null, "", ""],
      })
      .mockReturnValue({
        status: 0,
        pid: 2,
        signal: null,
        stdout: "",
        stderr: "",
        output: [null, "", ""],
      }) as never;

    try {
      await withCwd(repoDir, () =>
        runDoctorCommand(["--fix"], baseOptions(configDir), {
          ...authDependencies(),
          inspectManagedProjectSelection: async () => ({
            kind: "no_projects",
            message:
              "No repository runtime config is configured. Run 'gh-symphony repo init' first.",
          }),
          stdinIsTTY: true,
          stdoutIsTTY: true,
          execPath: process.execPath,
          cliArgv: [process.execPath, "/tmp/gh-symphony.js"],
          spawnSync,
        })
      );
    } finally {
      stdout.restore();
    }

    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      ["/tmp/gh-symphony.js", "--config", configDir, "repo", "init"],
      { stdio: "inherit" }
    );
  });

  it("creates a redacted support bundle at an explicit path", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-bundle-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await prepareDoctorPaths(configDir, workspaceDir);
    await prepareBundleRuntimeFixture({ configDir, workspaceDir });
    const { repoDir, pathEnv } = await createWorkflowFixture();
    await writeFile(
      join(repoDir, "WORKFLOW.md"),
      "---\ntracker:\n  kind: github-project\ncodex:\n  command: fake-agent\n---\nAuthorization: Bearer abc123\n",
      "utf8"
    );
    const outputPath = join(repoDir, "tmp", "support-bundle");
    const stdout = captureWrites(process.stdout);

    try {
      await withCwd(repoDir, () =>
        runDoctorCommand(
          ["--bundle", outputPath],
          { ...baseOptions(configDir), json: true },
          {
            ...authDependencies(),
            inspectManagedProjectSelection: async (input) => ({
              kind: "resolved",
              projectId: input.requestedProjectId ?? "tenant-a",
              projectConfig: createProjectConfig(workspaceDir),
            }),
            getProjectDetail: (async () =>
              createProjectDetail() as never) as never,
            execFileSync: (() => "git version 2.43.0") as never,
            pathEnv,
          }
        )
      );
    } finally {
      stdout.restore();
    }

    const summary = JSON.parse(stdout.output()) as {
      outputPath: string;
      includedCount: number;
      missingCount: number;
      redactionCount: number;
      redactionClasses: Array<{ class: string; count: number }>;
      truncationCount: number;
    };
    expect(summary.outputPath).toBe(outputPath);
    expect(summary.includedCount).toBeGreaterThanOrEqual(9);
    expect(summary.missingCount).toBe(0);
    expect(summary.redactionCount).toBeGreaterThan(0);
    expect(summary.redactionClasses.map((entry) => entry.class)).toEqual(
      expect.arrayContaining([
        "authorization_header",
        "env_token",
        "api_key",
        "secret_key",
      ])
    );
    expect(summary.truncationCount).toBeGreaterThanOrEqual(1);

    const manifest = JSON.parse(
      await readFile(join(outputPath, "manifest.json"), "utf8")
    ) as {
      projectId: string;
      included: string[];
      truncations: Array<{ path: string }>;
    };
    expect(manifest.projectId).toBe("tenant-a");
    expect(manifest.included).toEqual(
      expect.arrayContaining([
        "doctor.json",
        "config/config.json",
        "config/project.json",
        "repo/WORKFLOW.md",
        "runtime/status.json",
        "runtime/issues.json",
        "runtime/orchestrator.log.tail",
        "runs/run-1/run.json",
        "runs/run-1/events.ndjson.tail",
        "runs/run-1/worker.log.tail",
      ])
    );
    expect(manifest.truncations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "runs/run-1/worker.log.tail" }),
      ])
    );

    const bundleContent = await readBundleFiles(outputPath);
    for (const secret of ["abc123", "ghp_xxx", "lin_xxx", "sk-xxx"]) {
      expect(bundleContent).not.toContain(secret);
    }
  });

  it("creates a timestamped support bundle by default and records missing optional artifacts", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-bundle-default-"));
    const workspaceDir = join(configDir, "workspaces");
    await prepareDoctorPaths(configDir, workspaceDir);
    await mkdir(join(configDir, "projects", "tenant-a"), { recursive: true });
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({ activeProject: "tenant-a", projects: ["tenant-a"] }),
      "utf8"
    );
    await writeFile(
      join(configDir, "projects", "tenant-a", "project.json"),
      JSON.stringify(createProjectConfig(workspaceDir)),
      "utf8"
    );
    const { repoDir, pathEnv } = await createWorkflowFixture();
    const stdout = captureWrites(process.stdout);

    try {
      await withCwd(repoDir, () =>
        runDoctorCommand(
          ["--bundle"],
          { ...baseOptions(configDir), json: true },
          {
            ...authDependencies(),
            inspectManagedProjectSelection: async () => ({
              kind: "resolved",
              projectId: "tenant-a",
              projectConfig: createProjectConfig(workspaceDir),
            }),
            getProjectDetail: (async () =>
              createProjectDetail() as never) as never,
            execFileSync: (() => "git version 2.43.0") as never,
            pathEnv,
          }
        )
      );
    } finally {
      stdout.restore();
    }

    const summary = JSON.parse(stdout.output()) as {
      outputPath: string;
      missingCount: number;
    };
    expect(summary.outputPath).toContain("gh-symphony-support-bundle-");
    expect(summary.missingCount).toBeGreaterThan(0);
    const manifest = JSON.parse(
      await readFile(join(summary.outputPath, "manifest.json"), "utf8")
    ) as { missing: Array<{ path: string }> };
    expect(manifest.missing.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "runtime/status.json",
        "runtime/issues.json",
        "runtime/orchestrator.log.tail",
        "runs",
      ])
    );
  });

  it("honors explicit project selection for support bundles", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-bundle-project-"));
    const workspaceDir = join(configDir, "workspaces");
    await prepareDoctorPaths(configDir, workspaceDir);
    await prepareBundleRuntimeFixture({
      configDir,
      workspaceDir,
      projectId: "project-b",
    });
    const { repoDir, pathEnv } = await createWorkflowFixture();
    const outputPath = join(repoDir, "bundle-project-b");
    const requestedProjectIds: Array<string | undefined> = [];
    const stdout = captureWrites(process.stdout);

    try {
      await withCwd(repoDir, () =>
        runDoctorCommand(
          ["--bundle", outputPath, "--project-id", "project-b"],
          { ...baseOptions(configDir), json: true },
          {
            ...authDependencies(),
            inspectManagedProjectSelection: async (input) => {
              requestedProjectIds.push(input.requestedProjectId);
              return {
                kind: "resolved",
                projectId: input.requestedProjectId ?? "tenant-a",
                projectConfig: createProjectConfig(workspaceDir),
              };
            },
            getProjectDetail: (async () =>
              createProjectDetail() as never) as never,
            execFileSync: (() => "git version 2.43.0") as never,
            pathEnv,
          }
        )
      );
    } finally {
      stdout.restore();
    }

    const summary = JSON.parse(stdout.output()) as { projectId: string };
    expect(summary.projectId).toBe("project-b");
    expect(requestedProjectIds).toContain("project-b");
    const manifest = JSON.parse(
      await readFile(join(outputPath, "manifest.json"), "utf8")
    ) as { projectId: string };
    expect(manifest.projectId).toBe("project-b");
  });

  it("rejects --fix with support bundle export", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-bundle-fix-"));
    const stderr = captureWrites(process.stderr);

    try {
      await doctorCommand(["--bundle", "--fix"], baseOptions(configDir));
    } finally {
      stderr.restore();
    }

    expect(process.exitCode).toBe(2);
    expect(stderr.output()).toContain(
      "Option '--fix' cannot be used with '--bundle'"
    );
  });

  it("reports no managed project for smoke checks", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const { repoDir, pathEnv } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), ["--smoke"], {
        ...authDependencies(),
        inspectManagedProjectSelection: async () => ({
          kind: "no_projects",
          message:
            "No repository runtime config is configured. Run 'gh-symphony repo init' first.",
        }),
        pathEnv,
      })
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((check) => check.id === "smoke_issue")
    ).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("managed project selection failed"),
      details: { blockedBy: "managed_project" },
    });
  });

  it("fails smoke checks when no representative live issue is active", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await prepareDoctorPaths(configDir, workspaceDir);
    const { repoDir, pathEnv } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), ["--smoke"], {
        ...authDependencies(),
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir, "PVT_test", [
            {
              owner: "acme",
              name: "widgets",
              url: "https://github.com/acme/widgets",
              cloneUrl: "https://github.com/acme/widgets.git",
            },
          ]),
        }),
        getProjectDetail: (async () => createProjectDetail() as never) as never,
        fetchProjectIssues: (async () => [
          createTrackedIssue({ state: "Done" }),
        ]) as never,
        pathEnv,
      })
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((check) => check.id === "smoke_issue")
    ).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("No active live issue was found"),
      remediation: expect.stringContaining("--issue owner/repo#number"),
    });
  });

  it("reports tracker fetch failures as smoke diagnostics", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await prepareDoctorPaths(configDir, workspaceDir);
    const { repoDir, pathEnv } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), ["--smoke"], {
        ...authDependencies(),
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir, "PVT_test", [
            {
              owner: "acme",
              name: "widgets",
              url: "https://github.com/acme/widgets",
              cloneUrl: "https://github.com/acme/widgets.git",
            },
          ]),
        }),
        getProjectDetail: (async () => createProjectDetail() as never) as never,
        fetchProjectIssues: (async () => {
          throw new Error("GitHub Project query failed");
        }) as never,
        pathEnv,
      })
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((check) => check.id === "smoke_issue")
    ).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("could not read live issues"),
      remediation: expect.stringContaining("token scopes"),
      details: expect.objectContaining({
        error: "GitHub Project query failed",
      }),
    });
  });

  it("rejects --issue outside smoke mode", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));

    await expect(
      runDoctorDiagnostics(baseOptions(configDir), [
        "--issue",
        "acme/widgets#1",
      ])
    ).rejects.toThrow("Option '--issue' requires '--smoke'");
  });

  it("reports malformed explicit smoke issues as diagnostics", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await prepareDoctorPaths(configDir, workspaceDir);
    const { repoDir, pathEnv } = await createWorkflowFixture();

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(
        baseOptions(configDir),
        ["--smoke", "--issue", "garbage"],
        {
          ...authDependencies(),
          inspectManagedProjectSelection: async () => ({
            kind: "resolved",
            projectId: "tenant-a",
            projectConfig: createProjectConfig(workspaceDir, "PVT_test", [
              {
                owner: "acme",
                name: "widgets",
                url: "https://github.com/acme/widgets",
                cloneUrl: "https://github.com/acme/widgets.git",
              },
            ]),
          }),
          getProjectDetail: (async () =>
            createProjectDetail() as never) as never,
          pathEnv,
        }
      )
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((check) => check.id === "smoke_issue")
    ).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("issue reference is invalid"),
      remediation: expect.stringContaining("owner/repo#number"),
      details: expect.objectContaining({
        issue: "garbage",
        expectedFormat: "owner/repo#number",
      }),
    });
  });

  it("reports prompt render failures in smoke checks", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await prepareDoctorPaths(configDir, workspaceDir);
    const { repoDir, pathEnv } = await createWorkflowFixture();
    await writeFile(
      join(repoDir, "WORKFLOW.md"),
      "---\ntracker:\n  kind: github-project\ncodex:\n  command: fake-agent\n---\nPrompt {{ issue.not_a_real_field }}\n",
      "utf8"
    );

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(baseOptions(configDir), ["--smoke"], {
        ...authDependencies(),
        inspectManagedProjectSelection: async () => ({
          kind: "resolved",
          projectId: "tenant-a",
          projectConfig: createProjectConfig(workspaceDir, "PVT_test", [
            {
              owner: "acme",
              name: "widgets",
              url: "https://github.com/acme/widgets",
              cloneUrl: "https://github.com/acme/widgets.git",
            },
          ]),
        }),
        getProjectDetail: (async () => createProjectDetail() as never) as never,
        fetchProjectIssues: (async () => [
          createTrackedIssue({ state: "In progress" }),
        ]) as never,
        pathEnv,
      })
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((check) => check.id === "workflow_prompt_render")
    ).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("failed to render"),
      remediation: expect.stringContaining("workflow preview"),
    });
  });

  it("passes smoke checks for an explicit readable project issue", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await prepareDoctorPaths(configDir, workspaceDir);
    const { repoDir, pathEnv } = await createWorkflowFixture();
    await mkdir(join(repoDir, "hooks"), { recursive: true });
    await writeFile(
      join(repoDir, "hooks", "after_create.sh"),
      "#!/bin/sh\n",
      "utf8"
    );
    await writeFile(
      join(repoDir, "WORKFLOW.md"),
      "---\ntracker:\n  kind: github-project\ncodex:\n  command: fake-agent\nhooks:\n  after_create: hooks/after_create.sh\n---\nPrompt {{ issue.identifier }}\n",
      "utf8"
    );

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(
        baseOptions(configDir),
        ["--smoke", "--issue", "acme/widgets#1"],
        {
          ...authDependencies(),
          inspectManagedProjectSelection: async () => ({
            kind: "resolved",
            projectId: "tenant-a",
            projectConfig: createProjectConfig(workspaceDir, "PVT_test", [
              {
                owner: "acme",
                name: "widgets",
                url: "https://github.com/acme/widgets",
                cloneUrl: "https://github.com/acme/widgets.git",
              },
            ]),
          }),
          getProjectDetail: (async () =>
            createProjectDetail() as never) as never,
          fetchProjectIssue: (async () => createTrackedIssue()) as never,
          pathEnv,
        }
      )
    );

    expect(report.ok).toBe(true);
    expect(
      report.checks.find((check) => check.id === "smoke_issue")
    ).toMatchObject({
      status: "pass",
      details: expect.objectContaining({ source: "explicit" }),
    });
    expect(
      report.checks.find((check) => check.id === "workflow_prompt_render")
    ).toMatchObject({ status: "pass" });
    expect(
      report.checks.find((check) => check.id === "workflow_hooks")
    ).toMatchObject({ status: "pass" });
  });

  it("fails smoke checks for unresolved workflow hook paths", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "doctor-config-"));
    const workspaceDir = join(configDir, "workspaces");
    await prepareDoctorPaths(configDir, workspaceDir);
    const { repoDir, pathEnv } = await createWorkflowFixture();
    await writeFile(
      join(repoDir, "WORKFLOW.md"),
      "---\ntracker:\n  kind: github-project\ncodex:\n  command: fake-agent\nhooks:\n  after_create: hooks/missing.sh\n  before_run: echo ready\n---\nPrompt {{ issue.identifier }}\n",
      "utf8"
    );

    const report = await withCwd(repoDir, () =>
      runDoctorDiagnostics(
        baseOptions(configDir),
        ["--smoke", "--issue", "acme/widgets#1"],
        {
          ...authDependencies(),
          inspectManagedProjectSelection: async () => ({
            kind: "resolved",
            projectId: "tenant-a",
            projectConfig: createProjectConfig(workspaceDir, "PVT_test", [
              {
                owner: "acme",
                name: "widgets",
                url: "https://github.com/acme/widgets",
                cloneUrl: "https://github.com/acme/widgets.git",
              },
            ]),
          }),
          getProjectDetail: (async () =>
            createProjectDetail() as never) as never,
          fetchProjectIssue: (async () => createTrackedIssue()) as never,
          pathEnv,
        }
      )
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((check) => check.id === "workflow_hooks")
    ).toMatchObject({
      status: "fail",
      summary: expect.stringContaining("Unresolved WORKFLOW.md hook path"),
      details: expect.objectContaining({
        pathsChecked: 0,
        inline: 1,
        unresolved: [
          expect.objectContaining({
            hook: "after_create",
            command: "hooks/missing.sh",
          }),
        ],
      }),
    });
  });
});
