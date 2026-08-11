import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import statusCommand, { relativeTime } from "./status.js";
import type { CliProjectConfig } from "../config.js";

const daemonProcessMocks = vi.hoisted(() => ({
  getProcessCwd: vi.fn(),
  getProcessIdentity: vi.fn(),
}));

vi.mock("@gh-symphony/orchestrator", () => ({
  getProcessCwd: daemonProcessMocks.getProcessCwd,
  getProcessIdentity: daemonProcessMocks.getProcessIdentity,
}));

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

async function writeDaemonPid(
  configDir: string,
  options: { pid?: number; identity?: string; cwd?: string } = {}
): Promise<void> {
  await writeFile(
    join(configDir, "projects", "tenant-a", "daemon.pid"),
    JSON.stringify({
      pid: options.pid ?? 111,
      startedAt: "2026-03-30T11:00:00.000Z",
      processIdentity: options.identity ?? "live-daemon",
      cwd: options.cwd ?? join("/tmp", "tenant-a"),
    }) + "\n",
    "utf8"
  );
}

async function writeProjectLock(configDir: string, pid = 222): Promise<void> {
  await writeFile(
    join(configDir, "projects", "tenant-a", ".lock"),
    JSON.stringify({
      ownerToken: `${pid}:owner`,
      pid,
      startedAt: "2026-03-30T11:00:00.000Z",
      heartbeatAt: "2026-03-30T11:00:00.000Z",
      processIdentity: null,
    }) + "\n",
    "utf8"
  );
}

beforeEach(() => {
  daemonProcessMocks.getProcessCwd.mockReset();
  daemonProcessMocks.getProcessIdentity.mockReset();
  daemonProcessMocks.getProcessCwd.mockReturnValue(join("/tmp", "tenant-a"));
  daemonProcessMocks.getProcessIdentity.mockReturnValue("live-daemon");
});

afterEach(() => {
  daemonProcessMocks.getProcessCwd.mockReset();
  daemonProcessMocks.getProcessIdentity.mockReset();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("status command", () => {
  it("renders a stopped banner and restart hint when the PID file is missing", async () => {
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

    expect(stdout.output()).toContain("● Health    stopped");
    expect(stdout.output()).toContain(
      "daemon not running — run 'gh-symphony repo start'"
    );
    expect(stdout.output()).toContain("Last known state: running");
  });

  it("recognizes a live foreground daemon from the project lock", async () => {
    const configDir = await createConfigFixture();
    await writeProjectLock(configDir);
    daemonProcessMocks.getProcessIdentity.mockReturnValue(null);
    vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-03-30T11:00:30.000Z").getTime()
    );
    const stdout = captureWrites(process.stdout);

    try {
      await statusCommand([], {
        configDir,
        verbose: false,
        json: true,
        noColor: true,
      });
    } finally {
      stdout.restore();
    }

    expect(JSON.parse(stdout.output())).toMatchObject({
      health: "running",
      daemonRunning: true,
    });
  });

  it("recognizes a live foreground daemon when the PID file is malformed", async () => {
    const configDir = await createConfigFixture();
    await writeFile(
      join(configDir, "projects", "tenant-a", "daemon.pid"),
      "partially-written-pid-record\n",
      "utf8"
    );
    await writeProjectLock(configDir);
    daemonProcessMocks.getProcessIdentity.mockReturnValue(null);
    vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-03-30T11:00:30.000Z").getTime()
    );
    const stdout = captureWrites(process.stdout);

    try {
      await statusCommand([], {
        configDir,
        verbose: false,
        json: true,
        noColor: true,
      });
    } finally {
      stdout.restore();
    }

    expect(JSON.parse(stdout.output())).toMatchObject({
      health: "running",
      daemonRunning: true,
    });
  });

  it("renders a stopped banner for a stale PID", async () => {
    const configDir = await createConfigFixture();
    await writeDaemonPid(configDir, { pid: 999_999 });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
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

    expect(stdout.output()).toContain("● Health    stopped");
  });

  it("keeps live daemon health and annotates a stale last tick", async () => {
    const configDir = await createConfigFixture();
    await writeDaemonPid(configDir);
    vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-03-30T11:02:00.000Z").getTime()
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

    expect(stdout.output()).toContain("● Health    running");
    expect(stdout.output()).toContain("Last tick  2m ago (stale)");
    expect(stdout.output()).not.toContain("daemon not running");
  });

  it("keeps fresh live daemon output free of stopped and stale warnings", async () => {
    const configDir = await createConfigFixture();
    await writeDaemonPid(configDir);
    vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2026-03-30T11:00:30.000Z").getTime()
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

    expect(stdout.output()).toContain("● Health    running");
    expect(stdout.output()).not.toContain("stopped");
    expect(stdout.output()).not.toContain("stale");
  });

  it("adds daemonRunning to JSON output", async () => {
    const configDir = await createConfigFixture();
    const stdout = captureWrites(process.stdout);

    try {
      await statusCommand([], {
        configDir,
        verbose: false,
        json: true,
        noColor: true,
      });
    } finally {
      stdout.restore();
    }

    expect(JSON.parse(stdout.output())).toMatchObject({
      health: "running",
      daemonRunning: false,
    });
  });

  it("renders durations of at least 48 hours in days", () => {
    const now = new Date("2026-04-01T12:00:00.000Z").getTime();
    expect(relativeTime("2026-03-30T11:00:00.000Z", now)).toBe("2d ago");
  });

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

  it("does not render incomplete-turn recovery when snapshot recovery is null", async () => {
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
          health: "idle",
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
          recovery: null,
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

    expect(stdout.output()).not.toContain("Recoverable incomplete turn:");
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

  it("does not render incomplete-turn recovery details when snapshot recovery is null", async () => {
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
          health: "idle",
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
          recovery: null,
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
    expect(output).not.toContain("Recoverable incomplete turn:");
    expect(output).not.toContain("Workspace  /tmp/work/repository");
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
