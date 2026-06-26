import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import statusCommand from "./status.js";
import type { CliProjectConfig } from "../config.js";

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

function createProject(projectId: string): CliProjectConfig {
  return {
    projectId,
    slug: projectId,
    displayName: projectId.toUpperCase(),
    workspaceDir: join("/tmp", projectId),
    tracker: {
      adapter: "github-project",
      bindingId: `${projectId}-binding`,
    },
  };
}

async function createConfigFixture(
  statusLayout: "flat" | "legacy" = "flat"
): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), "cli-status-"));
  const projectId = "tenant-a";

  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify(
      {
        activeProject: projectId,
        projects: [projectId],
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  const projectDir = join(configDir, "projects", projectId);
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "project.json"),
    JSON.stringify(createProject(projectId), null, 2) + "\n",
    "utf8"
  );

  const statusDir =
    statusLayout === "flat"
      ? configDir
      : join(configDir, "projects", projectId);
  await mkdir(statusDir, { recursive: true });
  await writeFile(
    join(statusDir, "status.json"),
    JSON.stringify(
      {
        projectId,
        slug: projectId,
        tracker: { adapter: "github-project", bindingId: "project-1" },
        lastTickAt: "2026-03-30T11:00:00.000Z",
        health: "running",
        summary: {
          dispatched: 2,
          suppressed: 0,
          recovered: 0,
          activeRuns: 1,
        },
        activeRuns: [
          {
            runId: "run-1",
            issueIdentifier: "acme/repo#1",
            issueState: "In Progress",
            status: "running",
            retryKind: null,
            port: null,
            tokenUsage: {
              inputTokens: 500,
              outputTokens: 100,
              totalTokens: 600,
              cumulativeInputTokens: 1400,
              cumulativeOutputTokens: 300,
              cumulativeTotalTokens: 1700,
            },
          },
        ],
        retryQueue: [],
        codexTotals: {
          inputTokens: 1400,
          outputTokens: 300,
          totalTokens: 1700,
          secondsRunning: 60,
        },
        lastError: null,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  return configDir;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("status command", () => {
  it("prints JSON for missing runtime config when --json is set", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-status-missing-"));
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);

    try {
      await statusCommand([], {
        configDir,
        verbose: false,
        json: true,
        noColor: true,
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
          "No repository runtime config found. Run 'gh-symphony repo init' first.",
      },
    });
  });

  it("renders project tokens from the flat runtime status snapshot", async () => {
    const configDir = await createConfigFixture();
    const stdout = captureWrites(process.stdout);

    try {
      await statusCommand([], {
        configDir,
        verbose: false,
        json: false,
        noColor: true,
      });
    } finally {
      stdout.restore();
    }

    expect(stdout.output()).toContain("Tokens: 600 / 1,700 total");
  });

  it("renders incomplete-turn recovery details in text status output", async () => {
    const configDir = await createConfigFixture();
    const projectId = "tenant-a";
    await writeFile(
      join(configDir, "status.json"),
      JSON.stringify(
        {
          projectId,
          slug: projectId,
          tracker: { adapter: "github-project", bindingId: "project-1" },
          lastTickAt: "2026-03-30T11:00:00.000Z",
          health: "degraded",
          summary: {
            dispatched: 2,
            suppressed: 1,
            recovered: 0,
            activeRuns: 0,
          },
          activeRuns: [],
          retryQueue: [],
          codexTotals: {
            inputTokens: 1400,
            outputTokens: 300,
            totalTokens: 1700,
            secondsRunning: 60,
          },
          lastError: null,
          recovery: {
            kind: "incomplete-turn-dirty-workspace",
            runId: "repository-acme-repo-78-mpmc5cl9",
            issueId: "issue-78",
            workspacePath: "/tmp/work/repository",
            dirtyFiles: [
              "apps/admin-v1/src/app/router.tsx",
              "apps/admin-v1/src/widgets/sidebar/Sidebar.tsx",
            ],
            lastEvent: "heartbeat",
            lastEventAt: "2026-05-26T08:20:42.912Z",
            sessionId: "session-123",
            threadId: "thread-456",
            suggestedCommand:
              "cd /tmp/work/repository && git status --short && git diff",
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    const stdout = captureWrites(process.stdout);

    try {
      await statusCommand([], {
        configDir,
        verbose: false,
        json: false,
        noColor: true,
      });
    } finally {
      stdout.restore();
    }

    const output = stdout.output();
    expect(output).toContain("Recoverable incomplete turn:");
    expect(output).toContain("Run        repository-acme-repo-78-mpmc5cl9");
    expect(output).toContain("Issue      issue-78");
    expect(output).toContain("Workspace  /tmp/work/repository");
    expect(output).toContain("apps/admin-v1/src/app/router.tsx");
    expect(output).toContain("Last       heartbeat");
    expect(output).toContain("At         2026-05-26T08:20:42.912Z");
    expect(output).toContain("Session    session-123");
    expect(output).toContain("Thread     thread-456");
    expect(output).toContain(
      "Command    cd /tmp/work/repository && git status --short && git diff"
    );
  });

  it("falls back to the legacy per-project status snapshot path", async () => {
    const configDir = await createConfigFixture("legacy");
    const stdout = captureWrites(process.stdout);

    try {
      await statusCommand([], {
        configDir,
        verbose: false,
        json: false,
        noColor: true,
      });
    } finally {
      stdout.restore();
    }

    expect(stdout.output()).toContain("Tokens: 600 / 1,700 total");
  });
});
