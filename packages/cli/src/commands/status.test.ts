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
    repositories: [],
    tracker: {
      adapter: "github-project",
      bindingId: `${projectId}-binding`,
    },
  };
}

async function createConfigFixture(): Promise<string> {
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

  const runtimeProjectDir = join(configDir, "projects", projectId);
  await mkdir(runtimeProjectDir, { recursive: true });
  await writeFile(
    join(runtimeProjectDir, "status.json"),
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
  it("renders project tokens as delta over cumulative total", async () => {
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
});
