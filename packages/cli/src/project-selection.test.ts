import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  saveGlobalConfig,
  saveProjectConfig,
  type CliProjectConfig,
} from "./config.js";
import { standaloneProjectId } from "./standalone-project.js";

const selectMock = vi.fn();
const cancelMock = vi.fn();
const originalStdinIsTty = Object.getOwnPropertyDescriptor(
  process.stdin,
  "isTTY"
);
const originalStdoutIsTty = Object.getOwnPropertyDescriptor(
  process.stdout,
  "isTTY"
);

vi.mock("@clack/prompts", async () => {
  const actual =
    await vi.importActual<typeof import("@clack/prompts")>("@clack/prompts");
  return {
    ...actual,
    select: selectMock,
    cancel: cancelMock,
    isCancel: (value: unknown) => value === Symbol.for("clack-cancel"),
  };
});

const {
  handleMissingManagedProjectConfig,
  inspectManagedProjectSelection,
  resolveManagedProjectConfig,
} = await import("./project-selection.js");

function createProject(
  projectId: string,
  displayName?: string,
  projectDir?: string
): CliProjectConfig {
  return {
    projectId,
    slug: projectId,
    displayName,
    ...(projectDir ? { projectDir } : {}),
    workspaceDir: join("/tmp", projectId),
    tracker: {
      adapter: "github-project",
      bindingId: `${projectId}-binding`,
    },
  };
}

async function createConfigFixture(
  projects: CliProjectConfig[],
  activeProject: string | null = null
): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), "project-selection-"));
  await saveGlobalConfig(configDir, {
    activeProject,
    projects: projects.map((project) => project.projectId),
  });
  for (const project of projects) {
    await saveProjectConfig(configDir, project.projectId, project);
  }
  return configDir;
}

function setTty(input: boolean, output: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value: input,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: output,
    configurable: true,
  });
}

afterEach(() => {
  selectMock.mockReset();
  cancelMock.mockReset();
  vi.restoreAllMocks();
  if (originalStdinIsTty) {
    Object.defineProperty(process.stdin, "isTTY", originalStdinIsTty);
  }
  if (originalStdoutIsTty) {
    Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTty);
  }
  process.exitCode = undefined;
});

describe("resolveManagedProjectConfig", () => {
  it("returns the only configured project when no project id is provided", async () => {
    const configDir = await createConfigFixture([createProject("tenant-a")]);

    const project = await resolveManagedProjectConfig({ configDir });

    expect(project?.projectId).toBe("tenant-a");
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("uses the active project in non-interactive multi-project mode", async () => {
    const configDir = await createConfigFixture(
      [createProject("tenant-a"), createProject("tenant-b")],
      "tenant-b"
    );
    setTty(false, false);

    const project = await resolveManagedProjectConfig({ configDir });

    expect(project?.projectId).toBe("tenant-b");
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("prefers the repository record matching cwd over another active repository", async () => {
    const repositoryA = await mkdtemp(join(tmpdir(), "repository-a-"));
    const repositoryB = await mkdtemp(join(tmpdir(), "repository-b-"));
    const projectA = {
      ...createProject("repository-a"),
      repositoryDir: repositoryA,
    };
    const projectB = {
      ...createProject("repository-b"),
      repositoryDir: repositoryB,
    };
    const configDir = await createConfigFixture(
      [projectA, projectB],
      projectB.projectId
    );

    await expect(
      resolveManagedProjectConfig({ configDir, cwd: repositoryA })
    ).resolves.toMatchObject({ projectId: projectA.projectId });
  });

  it("prefers the deepest repository record containing cwd", async () => {
    const repositoryDir = await mkdtemp(join(tmpdir(), "repository-root-"));
    const nestedRepositoryDir = join(repositoryDir, "packages", "cli");
    const projectA = {
      ...createProject("repository-root"),
      repositoryDir,
    };
    const projectB = {
      ...createProject("repository-nested"),
      repositoryDir: nestedRepositoryDir,
    };
    const configDir = await createConfigFixture(
      [projectA, projectB],
      projectA.projectId
    );

    await expect(
      resolveManagedProjectConfig({
        configDir,
        cwd: join(nestedRepositoryDir, "src"),
      })
    ).resolves.toMatchObject({ projectId: projectB.projectId });
  });

  it("requires interactive selection when multiple projects have no active project", async () => {
    const configDir = await createConfigFixture([
      createProject("tenant-a"),
      createProject("tenant-b"),
    ]);
    setTty(false, false);
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const project = await resolveManagedProjectConfig({ configDir });

    expect(project).toBeNull();
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "Multiple legacy repository runtime configs are present. Run 'gh-symphony setup' from the target repository to create a standalone project."
    );
    expect(process.exitCode).toBe(1);
  });

  it("prompts and resolves the selected project in interactive multi-project mode", async () => {
    const configDir = await createConfigFixture([
      createProject("tenant-a", "Alpha"),
      createProject("tenant-b", "Beta"),
    ]);
    setTty(true, true);
    selectMock.mockResolvedValue("tenant-b");

    const project = await resolveManagedProjectConfig({ configDir });

    expect(selectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Select a project:",
        options: expect.arrayContaining([
          expect.objectContaining({
            value: "tenant-a",
          }),
          expect.objectContaining({
            value: "tenant-b",
            label: "Beta",
          }),
        ]),
      })
    );
    expect(project?.projectId).toBe("tenant-b");
  });

  it("preserves an existing non-zero exit code when handling a missing project", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    process.exitCode = 130;

    handleMissingManagedProjectConfig();

    expect(stderr).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(130);
  });
});

describe("inspectManagedProjectSelection", () => {
  it("prefers the cached standalone cwd over a different active project", async () => {
    const projectADir = await mkdtemp(join(tmpdir(), "standalone-a-"));
    const projectAId = standaloneProjectId(projectADir);
    const configDir = await createConfigFixture(
      [createProject("tenant-b", "Beta")],
      "tenant-b"
    );
    await saveProjectConfig(
      configDir,
      projectAId,
      createProject(projectAId, "Alpha", projectADir)
    );

    const result = await inspectManagedProjectSelection({
      configDir,
      cwd: projectADir,
    });

    expect(result).toMatchObject({
      kind: "resolved",
      projectId: projectAId,
    });
  });

  it("resolves a cached standalone cwd without a global config", async () => {
    const projectADir = await mkdtemp(join(tmpdir(), "standalone-a-"));
    const projectAId = standaloneProjectId(projectADir);
    const configDir = await mkdtemp(join(tmpdir(), "project-selection-"));
    await saveProjectConfig(
      configDir,
      projectAId,
      createProject(projectAId, "Alpha", projectADir)
    );

    const result = await inspectManagedProjectSelection({
      configDir,
      cwd: projectADir,
    });

    expect(result).toMatchObject({
      kind: "resolved",
      projectId: projectAId,
    });
  });

  it("keeps an explicit selector ahead of the cached standalone cwd", async () => {
    const projectADir = await mkdtemp(join(tmpdir(), "standalone-a-"));
    const projectAId = standaloneProjectId(projectADir);
    const configDir = await createConfigFixture(
      [createProject("tenant-b", "Beta")],
      "tenant-b"
    );
    await saveProjectConfig(
      configDir,
      projectAId,
      createProject(projectAId, "Alpha", projectADir)
    );

    const result = await inspectManagedProjectSelection({
      configDir,
      requestedProjectId: "tenant-b",
      cwd: projectADir,
    });

    expect(result).toMatchObject({
      kind: "resolved",
      projectId: "tenant-b",
    });
  });

  it("uses the active project in non-interactive multi-project mode", async () => {
    const configDir = await createConfigFixture(
      [createProject("tenant-a"), createProject("tenant-b")],
      "tenant-b"
    );
    setTty(false, false);

    const result = await inspectManagedProjectSelection({ configDir });

    expect(result).toMatchObject({
      kind: "resolved",
      projectId: "tenant-b",
    });
  });

  it("reports standalone selection guidance when multiple projects have no active project", async () => {
    const configDir = await createConfigFixture([
      createProject("tenant-a"),
      createProject("tenant-b"),
    ]);
    setTty(false, false);

    const result = await inspectManagedProjectSelection({ configDir });

    expect(result).toMatchObject({
      kind: "multiple_projects_require_selection",
      message: expect.stringContaining("--project-dir <path>"),
    });
    expect(result.message).toContain("gh-symphony project list");
    expect(result.message).toContain("run the diagnostic from that folder");
    expect(result.message).not.toContain("repo init");
  });

  it("uses the active project when one is configured", async () => {
    const configDir = await createConfigFixture(
      [createProject("tenant-a"), createProject("tenant-b")],
      "tenant-b"
    );
    setTty(true, true);

    const result = await inspectManagedProjectSelection({ configDir });

    expect(result).toMatchObject({
      kind: "resolved",
      projectId: "tenant-b",
    });
  });

  it("reports a missing project config for the active project", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "project-selection-"));
    await saveGlobalConfig(configDir, {
      activeProject: "tenant-a",
      projects: ["tenant-a"],
    });

    const result = await inspectManagedProjectSelection({ configDir });

    expect(result).toMatchObject({
      kind: "active_project_missing",
      projectId: "tenant-a",
      message:
        "Active project \"tenant-a\" is configured in config.json but its project config is missing. Run 'gh-symphony project start --project-dir <path>' to refresh the standalone project config, then run diagnostics from that folder or select it explicitly.",
    });
    expect(result.message).not.toContain('Active Project "tenant-a"');
  });
});
