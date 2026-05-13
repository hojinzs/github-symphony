import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProjectConfig } from "../config.js";

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

const VALID_WORKFLOW = `---
tracker:
  kind: github-project
  project_id: PVT_project_123
  state_field: Status
  active_states:
    - Ready
  terminal_states:
    - Done
polling:
  interval_ms: 30000
workspace:
  root: .runtime/symphony-workspaces
hooks:
  timeout_ms: 60000
agent:
  max_concurrent_agents: 1
codex:
  command: codex app-server
---
Handle {{issue.identifier}}.
`;

async function createGitRepo(remoteName = "platform"): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "repo-init-"));
  execFileSync("git", ["-C", repoDir, "init"]);
  execFileSync("git", [
    "-C",
    repoDir,
    "remote",
    "add",
    "origin",
    `https://github.com/acme/${remoteName}.git`,
  ]);
  return repoDir;
}

async function readRepoProjectConfig(
  repoDir: string
): Promise<CliProjectConfig> {
  return JSON.parse(
    await readFile(
      join(
        repoDir,
        ".runtime",
        "orchestrator",
        "projects",
        "repository",
        "project.json"
      ),
      "utf8"
    )
  ) as CliProjectConfig;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("repo init runtime migration", () => {
  it("does not advertise removed repo-set commands in fallback usage", async () => {
    const stderr = captureWrites(process.stderr);
    const repoCommand = await loadRepoCommand();

    try {
      await repoCommand(["unknown"], baseOptions(tmpdir()));
    } finally {
      stderr.restore();
    }

    expect(process.exitCode).toBe(2);
    expect(stderr.output()).toContain(
      "Usage: gh-symphony repo <init|start|status|stop|run|recover|logs|explain> [repo]"
    );
    expect(stderr.output()).not.toContain("list|add|remove|sync");
  });

  it("promotes a single legacy project directory and strips projectId from run records", async () => {
    const repoDir = await createGitRepo();
    const stdout = captureWrites(process.stdout);
    const repoCommand = await loadRepoCommand();
    await writeFile(join(repoDir, "WORKFLOW.md"), VALID_WORKFLOW, "utf8");

    const runDir = join(
      repoDir,
      ".runtime",
      "orchestrator",
      "projects",
      "tenant-a",
      "runs",
      "run-1"
    );
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({
        runId: "run-1",
        projectId: "tenant-a",
        status: "running",
      }),
      "utf8"
    );

    try {
      await repoCommand(
        ["init", "--repo-dir", repoDir],
        baseOptions(join(repoDir, "unused"))
      );
    } finally {
      stdout.restore();
    }

    const migratedRun = JSON.parse(
      await readFile(
        join(repoDir, ".runtime", "orchestrator", "runs", "run-1", "run.json"),
        "utf8"
      )
    ) as Record<string, unknown>;
    const projectConfig = await readRepoProjectConfig(repoDir);

    expect(migratedRun).not.toHaveProperty("projectId");
    expect(projectConfig.repository).toMatchObject({
      owner: "acme",
      name: "platform",
    });
    expect(projectConfig).not.toHaveProperty("repositories");
    expect(stdout.output()).toContain("Repository initialized: acme/platform");
  });

  it("can run repo init again after the repository layout exists", async () => {
    const repoDir = await createGitRepo();
    const stdout = captureWrites(process.stdout);
    const repoCommand = await loadRepoCommand();
    await writeFile(join(repoDir, "WORKFLOW.md"), VALID_WORKFLOW, "utf8");

    try {
      await repoCommand(
        ["init", "--repo-dir", repoDir],
        baseOptions(join(repoDir, "unused"))
      );
      process.exitCode = undefined;
      await repoCommand(
        ["init", "--repo-dir", repoDir],
        baseOptions(join(repoDir, "unused"))
      );
    } finally {
      stdout.restore();
    }

    expect(process.exitCode).toBeUndefined();
    expect(stdout.output()).toContain("Repository initialized: acme/platform");
  });

  it("initializes a Linear tracker runtime from WORKFLOW.md", async () => {
    const repoDir = await createGitRepo();
    const stdout = captureWrites(process.stdout);
    const repoCommand = await loadRepoCommand();
    await writeFile(
      join(repoDir, "WORKFLOW.md"),
      `---
tracker:
  kind: linear
  project_slug: symphony-0c79b11b75ea
  active_states:
    - Todo
    - In Progress
codex:
  command: codex app-server
---
Handle {{issue.identifier}}.
`,
      "utf8"
    );

    try {
      await repoCommand(
        ["init", "--repo-dir", repoDir],
        baseOptions(join(repoDir, "unused"))
      );
    } finally {
      stdout.restore();
    }

    const projectConfig = await readRepoProjectConfig(repoDir);

    expect(process.exitCode).toBeUndefined();
    expect(projectConfig.tracker).toMatchObject({
      adapter: "linear",
      bindingId: "symphony-0c79b11b75ea",
      apiUrl: "https://api.linear.app/graphql",
      settings: {
        projectSlug: "symphony-0c79b11b75ea",
        activeStates: "Todo\nIn Progress",
        repository: "acme/platform",
      },
    });
  });

  it("resolves a relative --workflow-file against --repo-dir", async () => {
    const repoDir = await createGitRepo();
    const elsewhere = await mkdtemp(join(tmpdir(), "repo-init-elsewhere-"));
    const stdout = captureWrites(process.stdout);
    const repoCommand = await loadRepoCommand();
    const originalCwd = process.cwd();
    await writeFile(join(repoDir, "CUSTOM.md"), VALID_WORKFLOW, "utf8");

    try {
      process.chdir(elsewhere);
      await repoCommand(
        ["init", "--repo-dir", repoDir, "--workflow-file", "CUSTOM.md"],
        baseOptions(join(repoDir, "unused"))
      );
    } finally {
      process.chdir(originalCwd);
      stdout.restore();
    }

    expect(process.exitCode).toBeUndefined();
    expect(stdout.output()).toContain(
      `Workflow: ${join(repoDir, "CUSTOM.md")}`
    );
  });

  it.each([
    ["name.with.dots", "name.with.dots"],
    [".github", ".github"],
  ])(
    "infers GitHub repository names containing dots: %s",
    async (remoteName, expectedName) => {
      const repoDir = await createGitRepo(remoteName);
      const stdout = captureWrites(process.stdout);
      const repoCommand = await loadRepoCommand();
      await writeFile(join(repoDir, "WORKFLOW.md"), VALID_WORKFLOW, "utf8");

      try {
        await repoCommand(
          ["init", "--repo-dir", repoDir],
          baseOptions(join(repoDir, "unused"))
        );
      } finally {
        stdout.restore();
      }

      const projectConfig = await readRepoProjectConfig(repoDir);

      expect(projectConfig.repository).toMatchObject({
        owner: "acme",
        name: expectedName,
      });
      expect(stdout.output()).toContain(
        `Repository initialized: acme/${expectedName}`
      );
    }
  );

  it("fails with manual cleanup guidance when multiple legacy project directories exist", async () => {
    const repoDir = await createGitRepo();
    const stderr = captureWrites(process.stderr);
    const repoCommand = await loadRepoCommand();
    await writeFile(join(repoDir, "WORKFLOW.md"), VALID_WORKFLOW, "utf8");
    await mkdir(
      join(repoDir, ".runtime", "orchestrator", "projects", "tenant-a"),
      { recursive: true }
    );
    await mkdir(
      join(repoDir, ".runtime", "orchestrator", "projects", "tenant-b"),
      { recursive: true }
    );

    try {
      await repoCommand(
        ["init", "--repo-dir", repoDir],
        baseOptions(join(repoDir, "unused"))
      );
    } finally {
      stderr.restore();
    }

    expect(process.exitCode).toBe(1);
    expect(stderr.output()).toContain(
      "Multiple legacy project runtime directories"
    );
    expect(stderr.output()).toContain("Manually keep the project directory");
  });

  it("reports a clear error when --project-id is used", async () => {
    const stderr = captureWrites(process.stderr);
    const repoCommand = await loadRepoCommand();

    try {
      await repoCommand(
        ["init", "--project-id", "tenant-a"],
        baseOptions(tmpdir())
      );
    } finally {
      stderr.restore();
    }

    expect(process.exitCode).toBe(2);
    expect(stderr.output()).toContain("--project-id has been removed");
    expect(stderr.output()).toContain("current repository directory");
  });

  it("writes a single-repository file-tracker config for repo-local E2E init", async () => {
    const repoDir = await createGitRepo();
    const stdout = captureWrites(process.stdout);
    const repoCommand = await loadRepoCommand();
    const originalIssuesPath = process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH;
    await writeFile(
      join(repoDir, "WORKFLOW.md"),
      VALID_WORKFLOW.replace("github-project", "file").replace(
        "PVT_project_123",
        "e2e-test"
      ),
      "utf8"
    );
    process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH =
      "/e2e/fixtures/issues.json";

    try {
      await repoCommand(
        ["init", "--repo-dir", repoDir],
        baseOptions(join(repoDir, "unused"))
      );
    } finally {
      if (originalIssuesPath === undefined) {
        delete process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH;
      } else {
        process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH = originalIssuesPath;
      }
      stdout.restore();
    }

    const projectConfig = await readRepoProjectConfig(repoDir);

    expect(projectConfig.repository).toMatchObject({
      owner: "acme",
      name: "platform",
    });
    expect(projectConfig).not.toHaveProperty("repositories");
    expect(projectConfig.tracker).toMatchObject({
      adapter: "file",
      bindingId: "e2e-test",
      settings: {
        projectId: "e2e-test",
        repository: "acme/platform",
        issuesPath: "/e2e/fixtures/issues.json",
      },
    });
    expect(stdout.output()).toContain("Repository initialized: acme/platform");
  });

  it("fails fast when file-tracker repo init has no issues fixture path", async () => {
    const repoDir = await createGitRepo();
    const stderr = captureWrites(process.stderr);
    const repoCommand = await loadRepoCommand();
    const originalIssuesPath = process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH;
    await writeFile(
      join(repoDir, "WORKFLOW.md"),
      VALID_WORKFLOW.replace("github-project", "file").replace(
        "PVT_project_123",
        "e2e-test"
      ),
      "utf8"
    );
    delete process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH;

    try {
      await repoCommand(
        ["init", "--repo-dir", repoDir],
        baseOptions(join(repoDir, "unused"))
      );
    } finally {
      if (originalIssuesPath === undefined) {
        delete process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH;
      } else {
        process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH = originalIssuesPath;
      }
      stderr.restore();
    }

    expect(process.exitCode).toBe(1);
    expect(stderr.output()).toContain(
      "File tracker repo init requires GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH"
    );
  });
});
