import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import logsCommand from "./logs.js";
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
  const configDir = await mkdtemp(join(tmpdir(), "cli-logs-"));
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify(
      {
        activeProject: null,
        projects: ["tenant-a", "tenant-b"],
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  for (const project of [createProject("tenant-a"), createProject("tenant-b")]) {
    const projectDir = join(configDir, "projects", project.projectId);
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "project.json"),
      JSON.stringify(project, null, 2) + "\n",
      "utf8"
    );
  }

  return configDir;
}

async function writeRunEvents(
  configDir: string,
  runId: string,
  events: Array<Record<string, unknown>>
): Promise<void> {
  const runDir = join(configDir, "orchestrator", "runs", runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "events.ndjson"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8"
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("logs command", () => {
  it("shows events from all projects when --project-id is omitted", async () => {
    const configDir = await createConfigFixture();
    await writeRunEvents(configDir, "run-1", [
      {
        at: "2026-03-16T00:00:00.000Z",
        event: "run-started",
        issueIdentifier: "acme/platform#1",
        projectId: "tenant-a",
      },
    ]);
    await writeRunEvents(configDir, "run-2", [
      {
        at: "2026-03-16T00:01:00.000Z",
        event: "run-started",
        issueIdentifier: "beta/api#2",
        projectId: "tenant-b",
      },
    ]);
    const stdout = captureWrites(process.stdout);

    try {
      await logsCommand([], {
        configDir,
        verbose: false,
        json: false,
        noColor: false,
      });
    } finally {
      stdout.restore();
    }

    const output = stdout.output();
    expect(output).toContain("acme/platform#1");
    expect(output).toContain("beta/api#2");
  });

  it("filters scanned events by --project-id when provided", async () => {
    const configDir = await createConfigFixture();
    await writeRunEvents(configDir, "run-1", [
      {
        at: "2026-03-16T00:00:00.000Z",
        event: "run-started",
        issueIdentifier: "acme/platform#1",
        projectId: "tenant-a",
      },
      {
        at: "2026-03-16T00:01:00.000Z",
        event: "run-started",
        issueIdentifier: "beta/api#2",
        projectId: "tenant-b",
      },
    ]);
    const stdout = captureWrites(process.stdout);

    try {
      await logsCommand(["--project-id", "tenant-b"], {
        configDir,
        verbose: false,
        json: false,
        noColor: false,
      });
    } finally {
      stdout.restore();
    }

    const output = stdout.output();
    expect(output).not.toContain("acme/platform#1");
    expect(output).toContain("beta/api#2");
  });
});
