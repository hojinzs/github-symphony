import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectStatusSnapshot } from "@gh-symphony/core";
import projectCommand from "./project.js";
import {
  saveGlobalConfig,
  saveProjectConfig,
  type CliProjectConfig,
} from "../config.js";

function captureWrites(stream: NodeJS.WriteStream): {
  output: () => string;
  restore: () => void;
} {
  let buffer = "";
  const spy = vi
    .spyOn(stream, "write")
    .mockImplementation(((chunk: string | Uint8Array) => {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof stream.write);

  return {
    output: () => buffer,
    restore: () => spy.mockRestore(),
  };
}

async function seedProject(
  configDir: string,
  input: {
    projectId: string;
    displayName: string;
    pid?: number;
    port?: number;
    snapshot?: ProjectStatusSnapshot;
  }
): Promise<void> {
  const project: CliProjectConfig = {
    projectId: input.projectId,
    slug: input.projectId,
    displayName: input.displayName,
    workspaceDir: join(configDir, "workspaces"),
    repositories: [],
    tracker: {
      adapter: "github-project",
      bindingId: `binding-${input.projectId}`,
    },
  };

  await saveProjectConfig(configDir, input.projectId, project);

  if (input.pid !== undefined) {
    await writeFile(
      join(configDir, "projects", input.projectId, "daemon.pid"),
      `${input.pid}\n`,
      "utf8"
    );
  }

  if (input.port !== undefined) {
    await writeFile(
      join(configDir, "projects", input.projectId, "port"),
      `${input.port}\n`,
      "utf8"
    );
  }

  if (input.snapshot) {
    const runtimeDir = join(
      configDir,
      "orchestrator",
      "projects",
      input.projectId
    );
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      join(runtimeDir, "status.json"),
      JSON.stringify(input.snapshot, null, 2) + "\n",
      "utf8"
    );
  }
}

describe("project list", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T14:00:00.000Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("status server unavailable"))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ORCHESTRATOR_STATUS_HOST;
    delete process.env.ORCHESTRATOR_STATUS_BASE_URL;
    delete process.env.ORCHESTRATOR_STATUS_PORT;
    vi.useRealTimers();
  });

  it("renders a table with running and stopped project states", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "project-list-"));
    const stdout = captureWrites(process.stdout);

    await saveGlobalConfig(configDir, {
      activeProject: "backend-a1b2",
      projects: ["backend-a1b2", "front-c3d4"],
    });

    await seedProject(configDir, {
      projectId: "backend-a1b2",
      displayName: "Backend Tasks",
      pid: process.pid,
      port: 52341,
      snapshot: {
        projectId: "backend-a1b2",
        slug: "backend-a1b2",
        tracker: { adapter: "github-project", bindingId: "project-1" },
        lastTickAt: "2026-03-15T13:58:00.000Z",
        health: "running",
        summary: { dispatched: 1, suppressed: 0, recovered: 0, activeRuns: 2 },
        activeRuns: [],
        retryQueue: [],
        lastError: null,
      },
    });

    await seedProject(configDir, {
      projectId: "front-c3d4",
      displayName: "Frontend Features",
      pid: 999999,
    });

    try {
      await projectCommand(["list"], {
        configDir,
        verbose: false,
        json: false,
        noColor: true,
      });
    } finally {
      stdout.restore();
    }

    const output = stdout.output();
    expect(output).toContain("│ ID");
    expect(output).toContain("Backend Tasks");
    expect(output).toContain("Frontend Features");
    expect(output).toContain("running");
    expect(output).toContain("stopped");
    expect(output).toContain("http://127.0.0.1:52341");
    expect(output).toContain("2m ago");
    expect(output).toContain("│ running ");
    expect(output).toContain("│ 2 ");
    expect(output).toContain("│ - ");
  });

  it("emits structured JSON rows with resolved endpoint metadata", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "project-list-json-"));
    const stdout = captureWrites(process.stdout);
    process.env.ORCHESTRATOR_STATUS_HOST = "::1";

    await saveGlobalConfig(configDir, {
      activeProject: "infra-e5f6",
      projects: ["infra-e5f6"],
    });

    await seedProject(configDir, {
      projectId: "infra-e5f6",
      displayName: "Infra Automation",
      pid: process.pid,
      port: 52387,
      snapshot: {
        projectId: "infra-e5f6",
        slug: "infra-e5f6",
        tracker: { adapter: "github-project", bindingId: "project-2" },
        lastTickAt: "2026-03-15T13:59:30.000Z",
        health: "idle",
        summary: { dispatched: 0, suppressed: 0, recovered: 0, activeRuns: 0 },
        activeRuns: [],
        retryQueue: [],
        lastError: null,
      },
    });

    try {
      await projectCommand(["list"], {
        configDir,
        verbose: false,
        json: true,
        noColor: true,
      });
    } finally {
      stdout.restore();
    }

    const output = JSON.parse(stdout.output()) as Array<Record<string, unknown>>;
    expect(output).toEqual([
      expect.objectContaining({
        id: "infra-e5f6",
        name: "Infra Automation",
        status: "running",
        endpoint: "http://[::1]:52387",
        health: "idle",
        activeRuns: 0,
        lastTick: "30s ago",
        active: true,
      }),
    ]);
    expect(typeof output[0]?.uptime).toBe("string");
  });

  it("emits nulls for unknown runtime fields in JSON mode", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "project-list-json-stopped-"));
    const stdout = captureWrites(process.stdout);

    await saveGlobalConfig(configDir, {
      activeProject: null,
      projects: ["front-c3d4"],
    });

    await seedProject(configDir, {
      projectId: "front-c3d4",
      displayName: "프론트엔드 기능",
      pid: 999999,
    });

    try {
      await projectCommand(["list"], {
        configDir,
        verbose: false,
        json: true,
        noColor: true,
      });
    } finally {
      stdout.restore();
    }

    const output = JSON.parse(stdout.output()) as Array<Record<string, unknown>>;
    expect(output).toEqual([
      {
        id: "front-c3d4",
        name: "프론트엔드 기능",
        status: "stopped",
        endpoint: "-",
        health: "-",
        activeRuns: null,
        lastTick: "-",
        uptime: "-",
        active: false,
      },
    ]);
  });
});
