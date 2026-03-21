import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliProjectConfig } from "../config.js";

const dashboardRunCli = vi.fn();

vi.mock("@gh-symphony/dashboard", () => ({
  runCli: dashboardRunCli,
}));

const dashboardModule = await import("./dashboard.js");

afterEach(() => {
  dashboardRunCli.mockReset();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("dashboard command", () => {
  it("forwards the resolved runtime root and project ID", async () => {
    const configDir = await createConfigFixture({
      activeProject: "tenant-a",
      projects: [createProject("tenant-a")],
    });

    await dashboardModule.default(["--port", "4680"], baseOptions(configDir));

    expect(dashboardRunCli).toHaveBeenCalledWith([
      "--runtime-root",
      configDir,
      "--project-id",
      "tenant-a",
      "--port",
      "4680",
    ]);
  });

  it("prints usage for unknown options", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await dashboardModule.default(["--bogus"], baseOptions("/tmp/config"));

    expect(process.exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledWith("Unknown option '--bogus'\n");
    expect(stderr).toHaveBeenCalledWith(
      "Usage: gh-symphony dashboard [--project-id <project-id>] [--port <number>]\n"
    );
    expect(dashboardRunCli).not.toHaveBeenCalled();
  });

  it("prints usage when an option value is missing", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await dashboardModule.default(["--project-id", "--port", "4680"], baseOptions("/tmp/config"));

    expect(process.exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledWith(
      "Option '--project-id' argument missing\n"
    );
    expect(dashboardRunCli).not.toHaveBeenCalled();
  });
});

function baseOptions(configDir: string) {
  return {
    configDir,
    verbose: false,
    json: false,
    noColor: false,
  };
}

function createProject(projectId: string): CliProjectConfig {
  return {
    projectId,
    slug: projectId,
    workspaceDir: join("/tmp", projectId),
    repositories: [
      {
        owner: "acme",
        name: "platform",
        cloneUrl: "https://github.com/acme/platform.git",
      },
    ],
    tracker: {
      adapter: "github-project",
      bindingId: `${projectId}-project`,
      settings: {
        projectId: `${projectId}-project`,
        token: `${projectId}-token`,
      },
    },
  };
}

async function createConfigFixture(input: {
  activeProject: string;
  projects: CliProjectConfig[];
}): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), "cli-dashboard-"));
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify(
      {
        activeProject: input.activeProject,
        token: `${input.activeProject}-token`,
        projects: input.projects.map((project) => project.projectId),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  for (const project of input.projects) {
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
